import { Node, SyntaxKind, type SourceFile, type Symbol as MorphSymbol } from 'ts-morph';
import type { CallFact, SymbolKey } from '../store/types.js';
import { unwrap, type RegisteredSymbol } from './symbols.js';

// Resolves every call / `new` inside a symbol's body to one of:
//   - a repo symbol (callee key, resolved = true),
//   - an external package or built-in (callee null, resolved = true),
//   - unresolved (callee null, resolved = false): dynamic dispatch, event emitters,
//     callbacks received as parameters, values of unknown origin.
// Resolution tries, in order: the type checker's symbol for the callee, the callee's type
// (catches functions returned from hooks/factories), then a syntactic trace of where the
// root identifier came from (works even when a package's types are not installed).

export interface RepoLookup {
  /** True for files that are part of the index. */
  isRepoFile(sourceFile: SourceFile): boolean;
  /** Key of the registered symbol for a declaration or function node, if any. */
  keyFor(node: Node): SymbolKey | null;
  /** Repo-relative path of a repo file. */
  pathOf(sourceFile: SourceFile): string;
}

/** Origin of a value declared outside the repo without an import, e.g. globals like `fetch` or `JSON`. */
const GLOBAL_ORIGIN = '<global>';

const EVENT_DISPATCH_METHODS = new Set(['emit']);
// Each hop (identifier -> declaration -> initializer/type -> identifier) costs ~2 levels.
const MAX_TRACE_DEPTH = 12;

export function collectCalls(sourceFile: SourceFile, byNode: Map<unknown, RegisteredSymbol>, repo: RepoLookup): CallFact[] {
  const calls: CallFact[] = [];
  const candidates = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression),
  ];

  for (const call of candidates) {
    const expr = call.getExpression();
    const kind = expr.getKind();
    if (kind === SyntaxKind.SuperKeyword || kind === SyntaxKind.ImportKeyword) continue;

    const caller = enclosingSymbol(call, byNode);
    if (!caller) continue;

    const nameNode = Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr;
    calls.push({
      caller: { name: caller.name, startLine: caller.startLine },
      calleeText: calleeText(expr),
      line: nameNode.getStartLineNumber(),
      ...resolveCallee(expr, repo),
    });
  }
  return calls.sort((a, b) => a.line - b.line || a.calleeText.localeCompare(b.calleeText));
}

/** Innermost registered function-like symbol containing `node`; calls in class/type bodies or at module level have none. */
export function enclosingSymbol(node: Node, byNode: Map<unknown, RegisteredSymbol>): RegisteredSymbol | null {
  for (let n = node.getParent(); n; n = n.getParent()) {
    const sym = byNode.get(n.compilerNode);
    if (sym) return sym.bodyOwner ? sym : null;
  }
  return null;
}

function resolveCallee(expr: Node, repo: RepoLookup): Pick<CallFact, 'callee' | 'resolved'> {
  const external = { callee: null, resolved: true };
  const unresolved = { callee: null, resolved: false };

  if (Node.isElementAccessExpression(expr)) {
    const arg = expr.getArgumentExpression();
    if (!arg || !(Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) return unresolved;
  }
  if (Node.isPropertyAccessExpression(expr) && EVENT_DISPATCH_METHODS.has(expr.getName())) return unresolved;

  // 1. The checker's symbol for the called name.
  const decl = firstDeclaration(symbolOf(expr));
  if (decl) {
    if (!repo.isRepoFile(decl.getSourceFile())) return external;
    const key = repo.keyFor(decl);
    if (key) return { callee: key, resolved: true };
  }

  // 2. The callee's type, e.g. `mutate` destructured from a hook's return value.
  for (const typeDecl of expr.getType().getSymbol()?.getDeclarations() ?? []) {
    if (!repo.isRepoFile(typeDecl.getSourceFile())) continue;
    const key = repo.keyFor(typeDecl);
    if (key) return { callee: key, resolved: true };
  }

  // 3. Where the root identifier came from.
  return originOfExpression(expr, repo, 0) !== null ? external : unresolved;
}

/**
 * The module a value was created from, e.g. "pg" for `client` in `const client = await pool.connect()`
 * where `pool = new Pool()` imports Pool from "pg"; "events" for "node:events". Null for values
 * declared in the repo, globals, and anything whose origin can't be traced.
 */
export function packageOf(expr: Node, repo: RepoLookup): string | null {
  const origin = originOfExpression(expr, repo, 0);
  return origin === null || origin === '' || origin === GLOBAL_ORIGIN ? null : moduleOf(origin);
}

/** "node:events" -> "events", "@prisma/client/runtime" -> "@prisma/client", "axios/lib" -> "axios". */
export function moduleOf(specifier: string): string {
  const bare = specifier.replace(/^node:/, '');
  const parts = bare.split('/');
  return bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The declaration an expression names, following imports; for `a.b` the declaration of `b`. */
export function declarationOf(expr: Node): Node | undefined {
  return firstDeclaration(symbolOf(expr));
}

function symbolOf(expr: Node): MorphSymbol | undefined {
  const target = Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr;
  const sym = target.getSymbol();
  if (sym?.isAlias()) return sym.getAliasedSymbol() ?? sym;
  return sym;
}

function firstDeclaration(sym: MorphSymbol | undefined): Node | undefined {
  return sym?.getDeclarations()[0];
}

/** The import specifier a value comes from (or GLOBAL_ORIGIN); null for repo values and unknown origins. */
function originOfExpression(expr: Node, repo: RepoLookup, depth: number): string | null {
  if (depth > MAX_TRACE_DEPTH) return null;
  const root = rootIdentifier(expr);
  if (!root || !Node.isIdentifier(root)) return null;
  const decl = root.getSymbol()?.getDeclarations()[0];
  if (!decl) return null;
  if (!repo.isRepoFile(decl.getSourceFile())) return GLOBAL_ORIGIN;
  return originOfDeclaration(decl, repo, depth + 1);
}

function originOfDeclaration(decl: Node, repo: RepoLookup, depth: number): string | null {
  if (depth > MAX_TRACE_DEPTH) return null;

  if (Node.isImportSpecifier(decl) || Node.isImportClause(decl) || Node.isNamespaceImport(decl)) {
    const importDecl = decl.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    const target = importDecl?.getModuleSpecifierSourceFile();
    if (!target || !repo.isRepoFile(target)) {
      const spec = importDecl?.getModuleSpecifierValue() ?? '';
      return spec.startsWith('.') ? null : spec;
    }
    const nameNode = Node.isImportSpecifier(decl) ? decl.getNameNode() : Node.isImportClause(decl) ? decl.getDefaultImport() : decl.getNameNode();
    const sym = nameNode?.getSymbol();
    const aliased = sym?.isAlias() ? sym.getAliasedSymbol() : undefined;
    const targetDecl = aliased?.getDeclarations()[0];
    return targetDecl ? originOfDeclaration(targetDecl, repo, depth + 1) : null;
  }

  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    return init ? originOfExpression(init, repo, depth + 1) : null;
  }

  if (Node.isBindingElement(decl)) {
    const owner = decl.getFirstAncestor((a) => Node.isVariableDeclaration(a) || Node.isParameterDeclaration(a));
    return owner ? originOfDeclaration(owner, repo, depth + 1) : null;
  }

  if (Node.isParameterDeclaration(decl)) {
    const typeNode = decl.getTypeNode();
    if (typeNode && Node.isTypeReference(typeNode)) {
      const typeName = typeNode.getTypeName();
      const left = Node.isQualifiedName(typeName) ? leftmost(typeName) : typeName;
      return originOfExpression(left, repo, depth + 1);
    }
    // An untyped parameter of an inline callback takes its origin from the call it's passed to,
    // e.g. `rows.map((r) => r.x())` or `promise.then((data) => ...)`.
    const fn = decl.getParent();
    const call = fn?.getParent();
    if (!typeNode && call && Node.isCallExpression(call) && call.getArguments().some((a) => a === fn)) {
      return originOfExpression(call.getExpression(), repo, depth + 1);
    }
  }

  return null;
}

function leftmost(name: Node): Node {
  let n = name;
  while (Node.isQualifiedName(n)) n = n.getLeft();
  return n;
}

/** Leftmost identifier of a call target or initializer: `a.b().c` -> a, `await x.y()` -> x, `p ?? q` -> p. */
function rootIdentifier(expr: Node): Node | undefined {
  let n: Node | undefined = expr;
  while (n) {
    n = unwrap(n);
    if (!n) return undefined;
    if (Node.isIdentifier(n)) return n;
    if (Node.isPropertyAccessExpression(n) || Node.isElementAccessExpression(n)) n = n.getExpression();
    else if (Node.isCallExpression(n) || Node.isNewExpression(n)) n = n.getExpression();
    else if (Node.isAwaitExpression(n)) n = n.getExpression();
    else if (Node.isBinaryExpression(n)) n = n.getLeft();
    else return undefined;
  }
  return undefined;
}

/** Compact callee text: `api.get<T>(...).then` -> "api.get().then", `handlers[name]` stays as is. */
export function calleeText(expr: Node): string {
  const n = unwrap(expr) ?? expr;
  if (Node.isIdentifier(n)) return n.getText();
  if (Node.isThisExpression(n)) return 'this';
  if (Node.isPropertyAccessExpression(n)) return `${calleeText(n.getExpression())}.${n.getName()}`;
  if (Node.isElementAccessExpression(n)) {
    return `${calleeText(n.getExpression())}[${n.getArgumentExpression()?.getText() ?? ''}]`;
  }
  if (Node.isCallExpression(n)) return `${calleeText(n.getExpression())}()`;
  if (Node.isNewExpression(n)) return `new ${calleeText(n.getExpression())}()`;
  const text = n.getText().replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
