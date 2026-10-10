import { Node, SyntaxKind, type CallExpression, type PropertyAccessExpression, type SourceFile, type ts } from 'ts-morph';
import type { SymbolFact, SymbolKind } from '../store/types.js';

// Decides which declarations become symbols and what they are called. The same registry is
// used to extract a file's symbols and to map a resolved callee declaration back to its key,
// so naming is defined in exactly one place.
//
// Naming: top-level declarations use their own name; members and nested functions are
// qualified by their owner: "Class.method", "api.post" (object-literal member of a top-level
// const), "EnrollForm.handleSubmit" (function declared inside a component).

export interface RegisteredSymbol extends SymbolFact {
  /** The node whose body contains the symbol's code (null for classes and types). */
  bodyOwner: Node | null;
}

export interface FileSymbols {
  symbols: RegisteredSymbol[];
  /** Declaration nodes and function nodes -> symbol. Keyed by compiler node for identity. */
  byNode: Map<ts.Node, RegisteredSymbol>;
}

const REACT_WRAPPERS = new Set(['memo', 'forwardRef', 'useCallback', 'React.memo', 'React.forwardRef']);
const MAX_SIGNATURE = 300;
// Express-style registrations whose inline function arguments become `route_handler` symbols.
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use']);

/**
 * `isRouteReceiver` decides whether `x` in `x.get('/p', (req, res) => ...)` is an Express app or router;
 * only then does the inline function become a `route_handler` symbol (sqlite's `db.get(sql, cb)` doesn't).
 */
export function collectSymbols(sourceFile: SourceFile, isRouteReceiver: (receiver: Node) => boolean = () => false): FileSymbols {
  const exported = new Set<ts.Node>();
  for (const decls of sourceFile.getExportedDeclarations().values()) {
    for (const d of decls) if (d.getSourceFile() === sourceFile) exported.add(d.compilerNode);
  }

  const symbols: RegisteredSymbol[] = [];
  const byNode = new Map<ts.Node, RegisteredSymbol>();

  const register = (sym: RegisteredSymbol, ...nodes: (Node | undefined)[]) => {
    symbols.push(sym);
    for (const n of nodes) if (n) byNode.set(n.compilerNode, sym);
  };

  const visit = (node: Node, owner: RegisteredSymbol | null, objectOwner: string | null): void => {
    const qualify = (name: string) => (owner ? `${owner.name}.${name}` : name);
    const isExported = exported.has(node.compilerNode);

    if (Node.isFunctionDeclaration(node) && node.getBody()) {
      const sym = functionSymbol(qualify(node.getName() ?? 'default'), node, node, owner ? false : isExported, 'function');
      register(sym, node);
      return node.forEachChild((c) => visit(c, sym, null));
    }

    if (Node.isVariableDeclaration(node) && Node.isIdentifier(node.getNameNode())) {
      const fn = functionInitializer(node.getInitializer());
      if (fn) {
        const statement = node.getVariableStatement();
        const rangeNode = statement && statement.getDeclarations().length === 1 ? statement : node;
        const sym = functionSymbol(qualify(node.getName()), rangeNode, fn, owner ? false : isExported, 'function');
        register(sym, node, fn);
        return fn.forEachChild((c) => visit(c, sym, null));
      }
      const init = unwrap(node.getInitializer());
      if (!owner && init && Node.isObjectLiteralExpression(init)) {
        // Members of a top-level object literal become "<const>.<member>" methods.
        return init.forEachChild((c) => visit(c, null, node.getName()));
      }
    }

    if (objectOwner && (Node.isPropertyAssignment(node) || Node.isMethodDeclaration(node))) {
      const fn = Node.isMethodDeclaration(node) ? node : functionInitializer(node.getInitializer());
      if (fn && Node.isIdentifier(node.getNameNode())) {
        const sym = functionSymbol(`${objectOwner}.${node.getName()}`, node, fn, false, 'method');
        register(sym, node, fn);
        return fn.forEachChild((c) => visit(c, sym, null));
      }
    }

    // Named function expressions that aren't a variable/property initializer,
    // e.g. `return function validateBody(req, res, next) { ... }`.
    if (Node.isFunctionExpression(node) && node.getName()) {
      const sym = functionSymbol(qualify(node.getName()!), node, node, false, 'function');
      register(sym, node);
      return node.forEachChild((c) => visit(c, sym, null));
    }

    if (Node.isClassDeclaration(node)) {
      const name = qualify(node.getName() ?? 'default');
      const sym: RegisteredSymbol = {
        ...range(node),
        name,
        kind: 'class',
        exported: owner ? false : isExported,
        signature: header(node.getText().split('{')[0]),
        bodyOwner: null,
      };
      register(sym, node);
      for (const member of node.getMembers()) {
        const fn =
          Node.isMethodDeclaration(member) || Node.isConstructorDeclaration(member) || Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)
            ? member
            : Node.isPropertyDeclaration(member)
              ? functionInitializer(member.getInitializer())
              : undefined;
        if (!fn) continue;
        const memberName = Node.isConstructorDeclaration(member) ? 'constructor' : (member as { getName(): string }).getName();
        const m = functionSymbol(`${name}.${memberName}`, member, fn, sym.exported, 'method');
        register(m, member, fn);
        fn.forEachChild((c) => visit(c, m, null));
      }
      return;
    }

    if (Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node) || Node.isEnumDeclaration(node)) {
      const text = Node.isTypeAliasDeclaration(node) ? node.getText() : node.getText().split('{')[0];
      register(
        { ...range(node), name: qualify(node.getName()), kind: 'type', exported: owner ? false : isExported, signature: header(text), bodyOwner: null },
        node,
      );
      return;
    }

    // `router.get('/x', (req, res) => ...)`: the inline handler is a symbol, so it can be cited,
    // called from, and tagged with side effects.
    if (Node.isCallExpression(node)) {
      const route = routeCallName(node);
      if (route && isRouteReceiver(route.receiver)) {
        visit(node.getExpression(), owner, objectOwner);
        for (const arg of node.getArguments()) {
          for (const item of Node.isArrayLiteralExpression(arg) ? arg.getElements() : [arg]) {
            const fn = unwrap(item);
            if (fn && isInlineHandler(fn)) {
              const start = fn.getStartLineNumber();
              let name = qualify(route.name);
              // Two handlers on one line would share (name, startLine), the key facts are joined on.
              for (let n = 2; symbols.some((s) => s.name === name && s.startLine === start); n++) name = `${qualify(route.name)}#${n}`;
              const sym: RegisteredSymbol = { ...functionSymbol(name, fn, fn, false, 'function'), kind: 'route_handler' };
              register(sym, fn);
              fn.forEachChild((c) => visit(c, sym, null));
            } else {
              visit(item, owner, objectOwner);
            }
          }
        }
        return;
      }
    }

    node.forEachChild((c) => visit(c, owner, objectOwner));
  };

  sourceFile.forEachChild((c) => visit(c, null, null));
  symbols.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  return { symbols, byNode };
}

/** A function-like initializer, looking through parentheses, `as`, and React wrappers like memo(() => ...). */
export function functionInitializer(init: Node | undefined): Node | undefined {
  const node = unwrap(init);
  if (!node) return undefined;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node;
  if (Node.isCallExpression(node) && REACT_WRAPPERS.has(node.getExpression().getText())) {
    return functionInitializer(node.getArguments()[0]);
  }
  return undefined;
}

export function unwrap(node: Node | undefined): Node | undefined {
  let n = node;
  while (n && (Node.isParenthesizedExpression(n) || Node.isAsExpression(n) || Node.isSatisfiesExpression(n) || Node.isNonNullExpression(n))) {
    n = n.getExpression();
  }
  return n;
}

function functionSymbol(name: string, rangeNode: Node, fn: Node, exported: boolean, baseKind: 'function' | 'method'): RegisteredSymbol {
  return {
    ...range(rangeNode),
    name,
    kind: classify(name, fn, baseKind),
    exported,
    signature: header(signatureText(rangeNode, fn)),
    bodyOwner: fn,
  };
}

function classify(name: string, fn: Node, baseKind: 'function' | 'method'): SymbolKind {
  const short = name.slice(name.lastIndexOf('.') + 1);
  if (/^use[A-Z0-9]/.test(short)) return 'hook';
  if (/^[A-Z]/.test(short) && containsJsx(fn)) return 'component';
  return baseKind;
}

function containsJsx(fn: Node): boolean {
  return (
    fn.getFirstDescendant((d) => {
      const k = d.getKind();
      return k === SyntaxKind.JsxElement || k === SyntaxKind.JsxSelfClosingElement || k === SyntaxKind.JsxFragment;
    }) !== undefined
  );
}

/** Source text from the start of the declaration up to its body, e.g. "export function f(a: A): B". */
function signatureText(rangeNode: Node, fn: Node): string {
  const body = (fn as { getBody?: () => Node | undefined }).getBody?.();
  const text = rangeNode.getText();
  if (!body) return text;
  const end = body.getStart() - rangeNode.getStart();
  return end > 0 ? text.slice(0, end).replace(/=>\s*$/, '=>') : text;
}

function header(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SIGNATURE ? `${collapsed.slice(0, MAX_SIGNATURE - 1)}…` : collapsed;
}

function range(node: Node): { startLine: number; endLine: number } {
  return { startLine: node.getStartLineNumber(), endLine: node.getEndLineNumber() };
}

/** "app.use", "patientsRouter.get /:id", "r.post /x" for `r.route('/x').post(...)`, with the receiver; null when not an Express-style registration. */
function routeCallName(call: CallExpression): { name: string; receiver: Node } | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || !ROUTE_METHODS.has(callee.getName())) return null;
  let receiver: Node = callee.getExpression();
  let path: Node | undefined = call.getArguments()[0];
  while (Node.isCallExpression(receiver) && Node.isPropertyAccessExpression(receiver.getExpression())) {
    const inner = receiver.getExpression() as PropertyAccessExpression;
    if (inner.getName() === 'route') {
      path = receiver.getArguments()[0];
      receiver = inner.getExpression();
      break;
    }
    if (!ROUTE_METHODS.has(inner.getName())) break;
    receiver = inner.getExpression();
  }
  const literal = path && (Node.isStringLiteral(path) || Node.isNoSubstitutionTemplateLiteral(path)) ? ` ${path.getLiteralText()}` : '';
  return { name: `${receiver.getText().replace(/\s+/g, '')}.${callee.getName()}${literal}`, receiver };
}

/** An anonymous function taking (req, res), (req, res, next) or (err, req, res, next). */
function isInlineHandler(node: Node): boolean {
  const anonymous = Node.isArrowFunction(node) || (Node.isFunctionExpression(node) && !node.getName());
  if (!anonymous) return false;
  const params = (node as unknown as { getParameters(): Node[] }).getParameters().length;
  return params >= 2 && params <= 4;
}
