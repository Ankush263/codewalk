import { dirname, relative } from 'node:path';
import { Node, type Project, type SourceFile } from 'ts-morph';
import type { CallFact, ImportFact, SymbolFact, SymbolKey } from '../store/types.js';
import { collectCalls } from './calls.js';
import { toPosix } from './discover.js';
import { PackageVersions, packageNameOf } from './packages.js';
import { collectSymbols, type FileSymbols } from './symbols.js';

export interface ExtractedFacts {
  symbols: SymbolFact[];
  calls: CallFact[];
  imports: ImportFact[];
}

/** Extracts facts for repo files from one ts-morph project, caching per-file symbol registries. */
export class Extractor {
  private readonly registries = new Map<string, FileSymbols>();
  private readonly versions: PackageVersions;

  constructor(
    private readonly project: Project,
    private readonly repoRoot: string,
    /** Repo-relative paths of every indexed file (not just the ones being extracted). */
    private readonly repoPaths: Set<string>,
  ) {
    this.versions = new PackageVersions(repoRoot);
  }

  extract(path: string): ExtractedFacts {
    const sourceFile = this.sourceFile(path);
    const registry = this.registry(sourceFile);
    const repo = {
      isRepoFile: (sf: SourceFile) => this.repoPaths.has(this.relPath(sf)),
      keyFor: (node: Node) => this.keyFor(node),
    };
    return {
      symbols: registry.symbols.map(({ bodyOwner: _, ...fact }) => fact),
      calls: collectCalls(sourceFile, registry.byNode, repo),
      imports: this.imports(sourceFile),
    };
  }

  private keyFor(node: Node): SymbolKey | null {
    const sym = this.registry(node.getSourceFile()).byNode.get(node.compilerNode);
    return sym ? { file: this.relPath(node.getSourceFile()), name: sym.name, startLine: sym.startLine } : null;
  }

  private imports(sourceFile: SourceFile): ImportFact[] {
    const fromDir = dirname(sourceFile.getFilePath());
    const facts: ImportFact[] = [];
    const declarations = [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()];

    for (const decl of declarations) {
      const importedPath = decl.getModuleSpecifierValue();
      if (importedPath === undefined) continue; // `export { x }` without a module

      const target = decl.getModuleSpecifierSourceFile();
      const targetPath = target ? this.relPath(target) : null;
      const resolvedPath = targetPath && this.repoPaths.has(targetPath) ? targetPath : null;
      const packageName = resolvedPath ? null : packageNameOf(importedPath);

      facts.push({
        importedPath,
        resolvedPath,
        importedNames: importedNames(decl),
        packageName,
        packageVersion: packageName ? this.versions.versionOf(packageName, fromDir) : null,
      });
    }
    return facts;
  }

  private registry(sourceFile: SourceFile): FileSymbols {
    const key = sourceFile.getFilePath();
    let registry = this.registries.get(key);
    if (!registry) {
      registry = collectSymbols(sourceFile);
      this.registries.set(key, registry);
    }
    return registry;
  }

  private sourceFile(path: string): SourceFile {
    const sf = this.project.getSourceFile(`${this.repoRoot}/${path}`);
    if (!sf) throw new Error(`File ${path} is not loaded in the project`);
    return sf;
  }

  private relPath(sourceFile: SourceFile): string {
    return toPosix(relative(this.repoRoot, sourceFile.getFilePath()));
  }
}

function importedNames(decl: Node): string[] {
  const names: string[] = [];
  if (Node.isImportDeclaration(decl)) {
    const def = decl.getDefaultImport();
    if (def) names.push('default');
    const ns = decl.getNamespaceImport();
    if (ns) names.push('*');
    for (const spec of decl.getNamedImports()) names.push(spec.getName());
  } else if (Node.isExportDeclaration(decl)) {
    const named = decl.getNamedExports();
    if (named.length === 0) names.push('*');
    for (const spec of named) names.push(spec.getName());
  }
  return names;
}
