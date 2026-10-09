import { join, relative } from 'node:path';
import { Node, type SourceFile } from 'ts-morph';
import { toPosix } from '../indexer/discover.js';
import { createProject } from '../indexer/index.js';

export interface DeclarationRef {
  /** Repo-relative file of the declaration. */
  file: string;
  line: number;
}

export interface ValueDeclarationRef extends DeclarationRef {
  name: string;
  /** Last line of the declaring statement, e.g. `export const pool = new Pool(...)`. */
  endLine: number;
}

export interface DeclarationsUsed {
  /** Types referenced between start..end, e.g. `Promise<Patient>` -> where `Patient` is declared. */
  types: DeclarationRef[];
  /** Module-level constants and variables (not functions) referenced between start..end. */
  values: ValueDeclarationRef[];
}

/**
 * Declarations inside the repo that the code between lines start..end of `file` refers to.
 * Resolved on the fly with ts-morph for the target only; the index stores no reference edges.
 */
export function declarationsUsed(repoRoot: string, file: string, start: number, end: number): DeclarationsUsed {
  const project = createProject(repoRoot);
  const sourceFile = project.addSourceFileAtPath(join(repoRoot, file));
  project.resolveSourceFileDependencies();

  const repoFile = (sf: SourceFile): string | null => {
    const path = toPosix(relative(repoRoot, sf.getFilePath()));
    return path.startsWith('..') || sf.isInNodeModules() || sf.isDeclarationFile() ? null : path;
  };

  const types = new Map<string, DeclarationRef>();
  const values = new Map<string, ValueDeclarationRef>();

  sourceFile.forEachDescendant((node, traversal) => {
    if (node.getEndLineNumber() < start || node.getStartLineNumber() > end) {
      traversal.skip();
      return;
    }

    const typeName = Node.isTypeReference(node)
      ? node.getTypeName()
      : Node.isExpressionWithTypeArguments(node)
        ? node.getExpression()
        : undefined;
    if (typeName) {
      for (const decl of declarationsOf(typeName)) {
        const declFile = repoFile(decl.getSourceFile());
        if (!declFile) continue;
        const ref = { file: declFile, line: decl.getStartLineNumber() };
        types.set(`${ref.file}:${ref.line}`, ref);
      }
      return;
    }

    if (Node.isIdentifier(node)) {
      for (const decl of declarationsOf(node)) {
        if (!Node.isVariableDeclaration(decl)) continue;
        const statement = decl.getVariableStatement();
        // Module level only, and not a function: functions are indexed symbols already.
        if (!statement || !Node.isSourceFile(statement.getParent())) continue;
        const init = decl.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) continue;
        const declFile = repoFile(decl.getSourceFile());
        if (!declFile) continue;
        const ref = { file: declFile, line: statement.getStartLineNumber(), endLine: statement.getEndLineNumber(), name: decl.getName() };
        values.set(`${ref.file}:${ref.line}`, ref);
      }
    }
  });

  return { types: [...types.values()], values: [...values.values()] };
}

function declarationsOf(node: Node): Node[] {
  let symbol = node.getSymbol();
  if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol() ?? symbol;
  return symbol?.getDeclarations() ?? [];
}
