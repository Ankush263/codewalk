import { Node, SyntaxKind, type ArrowFunction, type FunctionDeclaration, type FunctionExpression, type SourceFile } from 'ts-morph';
import type { HandlerArg, RouterCallFact } from '../store/types.js';
import { calleeText, declarationOf, packageOf, type RepoLookup } from './calls.js';
import { functionInitializer, unwrap } from './symbols.js';

// Express registrations (CLAUDE.md §6.3): every app.use / router.<verb> / router.route(p).<verb>
// on an app or router, with its path and handler arguments classified. Facts stay per file; the
// store stitches mounts across files into full routes (routes/stitch.ts).

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const MAX_TEXT = 60;

type FunctionLike = FunctionDeclaration | FunctionExpression | ArrowFunction;

export function collectRouterCalls(sourceFile: SourceFile, repo: RepoLookup): RouterCallFact[] {
  const facts: Omit<RouterCallFact, 'orderIdx'>[] = [];
  // Chained calls share a start; the inner one (`.get`) was registered before the outer (`.delete`).
  const calls = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .sort((a, b) => a.getStart() - b.getStart() || a.getEnd() - b.getEnd());

  for (const call of calls) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const name = callee.getName();
    if (name !== 'use' && !VERBS.has(name)) continue;

    const base = routeBase(callee.getExpression());
    const receiver = routerOf(base.receiver, repo);
    if (receiver === undefined) continue; // not an Express app or router

    const args = call.getArguments();
    let pathArg: Node | undefined;
    let handlerArgs: Node[];
    if (base.path) {
      pathArg = base.path;
      handlerArgs = args;
    } else if (name !== 'use' || (args.length > 1 && isPathLike(args[0]))) {
      pathArg = args[0];
      handlerArgs = args.slice(1);
    } else {
      handlerArgs = args;
    }
    const handlers = handlerArgs
      .flatMap((a) => (Node.isArrayLiteralExpression(a) ? a.getElements() : [a]))
      .map((a) => classifyHandler(a, repo));
    if (handlers.length === 0) continue; // e.g. app.get('env'): a settings read, not a route

    const literal = pathArg ? pathLiteral(pathArg) : null;
    facts.push({
      receiver,
      receiverText: oneLine(base.receiver.getText()),
      callKind: name === 'use' ? 'use' : 'route',
      method: name === 'use' ? null : name.toUpperCase(),
      path: literal,
      pathText: pathArg && literal === null ? oneLine(pathArg.getText()) : null,
      line: call.getStartLineNumber(),
      endLine: call.getEndLineNumber(),
      handlers,
    });
  }
  return facts.map((f, orderIdx) => ({ ...f, orderIdx }));
}

/** For `r.route('/x').get(a).post(b)`: the router `r` and the path '/x'. Otherwise the receiver itself. */
function routeBase(receiver: Node): { receiver: Node; path?: Node } {
  let r = receiver;
  while (Node.isCallExpression(r)) {
    const inner = r.getExpression();
    if (!Node.isPropertyAccessExpression(inner)) break;
    if (inner.getName() === 'route') return { receiver: inner.getExpression(), path: r.getArguments()[0] };
    if (!VERBS.has(inner.getName())) break;
    r = inner.getExpression();
  }
  return { receiver: r };
}

/** True when `expr` is an Express app or router (or another Express value, e.g. a parameter typed Express). */
export function isExpressValue(expr: Node, repo: RepoLookup): boolean {
  return routerOf(expr, repo) !== undefined;
}

/**
 * The app or router `expr` refers to; null for an Express value that isn't a router declared in the
 * repo (a parameter typed Express, a value returned from elsewhere); undefined for anything else.
 */
function routerOf(expr: Node, repo: RepoLookup): RouterCallFact['receiver'] | undefined {
  const decl = declarationOf(expr);
  if (decl && Node.isVariableDeclaration(decl) && repo.isRepoFile(decl.getSourceFile())) {
    const kind = routerKind(decl.getInitializer(), repo);
    if (kind) return { key: `${repo.pathOf(decl.getSourceFile())}#${decl.getName()}`, kind };
  }
  return packageOf(expr, repo) === 'express' ? null : undefined;
}

/** "app" for express(), "router" for Router() / express.Router(); null for anything else. */
function routerKind(init: Node | undefined, repo: RepoLookup): 'app' | 'router' | null {
  const call = unwrap(init);
  if (!call || !Node.isCallExpression(call)) return null;
  const callee = call.getExpression();
  if (packageOf(callee, repo) !== 'express') return null;
  return calleeText(callee).endsWith('Router') ? 'router' : 'app';
}

function classifyHandler(arg: Node, repo: RepoLookup): HandlerArg {
  const node = unwrap(arg) ?? arg;
  const text = oneLine(node.getText());

  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const key = repo.keyFor(node);
    return key ? { kind: 'inline', key, arity: node.getParameters().length, text } : { kind: 'unresolved', text };
  }

  if (Node.isCallExpression(node)) {
    const decl = declarationOf(node.getExpression());
    const fn = decl && repo.isRepoFile(decl.getSourceFile()) ? functionOf(decl) : undefined;
    const factory = fn && decl ? repo.keyFor(decl) : null;
    if (fn && factory) {
      const returned = returnedFunction(fn);
      return {
        kind: 'factory',
        factory,
        key: returned ? repo.keyFor(returned) : null,
        arity: returned ? returned.getParameters().length : null,
        text,
      };
    }
  } else {
    const decl = declarationOf(node);
    if (decl && repo.isRepoFile(decl.getSourceFile())) {
      if (Node.isVariableDeclaration(decl) && routerKind(decl.getInitializer(), repo)) {
        return { kind: 'router', receiverKey: `${repo.pathOf(decl.getSourceFile())}#${decl.getName()}`, text };
      }
      const fn = functionOf(decl);
      const key = fn ? repo.keyFor(decl) : null;
      if (fn && key) return { kind: 'symbol', key, arity: fn.getParameters().length, text };
    }
  }

  const pkg = packageOf(node, repo);
  return pkg ? { kind: 'package', package: pkg, text } : { kind: 'unresolved', text };
}

function functionOf(decl: Node): FunctionLike | undefined {
  if (Node.isFunctionDeclaration(decl)) return decl;
  if (Node.isVariableDeclaration(decl)) return functionInitializer(decl.getInitializer()) as FunctionLike | undefined;
  return undefined;
}

/** The single function a factory returns, e.g. `return function validateBody(...) {...}`. */
function returnedFunction(fn: FunctionLike): ArrowFunction | FunctionExpression | undefined {
  const body = fn.getBody();
  if (!body) return undefined;
  const candidates = Node.isBlock(body)
    ? body
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter((r) => r.getFirstAncestor((a) => Node.isFunctionDeclaration(a) || Node.isFunctionExpression(a) || Node.isArrowFunction(a) || Node.isMethodDeclaration(a)) === fn)
        .map((r) => unwrap(r.getExpression()))
    : [unwrap(body)];
  const fns = candidates.filter((c): c is ArrowFunction | FunctionExpression => !!c && (Node.isArrowFunction(c) || Node.isFunctionExpression(c)));
  return fns.length === 1 ? fns[0] : undefined;
}

function isPathLike(node: Node): boolean {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isTemplateExpression(node)) return true;
  const type = node.getType();
  return type.isString() || type.isStringLiteral();
}

function pathLiteral(node: Node): string | null {
  return Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) ? node.getLiteralText() : null;
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TEXT ? `${collapsed.slice(0, MAX_TEXT - 1)}…` : collapsed;
}
