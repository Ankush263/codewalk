import type { HandlerArg, MiddlewarePhase, MountFact, RouterCallRecord, SymbolKey } from '../store/types.js';

// Turns per-file Express registrations into full routes (CLAUDE.md §6.3 items 1-2). Pure: the store
// runs it over stored router facts inside the indexing transaction, never over source. Express rules:
// - an app's or router's middleware runs only for requests that reach it, in registration order;
// - middleware registered after a route (or mount) doesn't run before it;
// - on failure, error handlers (4 parameters) registered after the route run, innermost router first.

export interface StitchedMiddleware {
  phase: MiddlewarePhase;
  handler: HandlerArg;
  /** The registration call. */
  file: string;
  line: number;
  endLine: number;
}

export interface StitchedRoute {
  method: string;
  fullPath: string;
  file: string;
  line: number;
  endLine: number;
  handler: HandlerArg;
  mountChain: MountFact[];
  /** Execution order: app and router middleware, route middleware, then error handlers. */
  middleware: StitchedMiddleware[];
  warnings: string[];
}

export interface StitchResult {
  routes: StitchedRoute[];
  /** Registrations that couldn't be placed in the route tree. */
  warnings: string[];
}

interface Scoped {
  /** Full path prefix the middleware applies to. */
  scope: string;
  mw: StitchedMiddleware;
}

export function stitchRoutes(calls: RouterCallRecord[]): StitchResult {
  const warnings: string[] = [];
  const byReceiver = new Map<string, RouterCallRecord[]>();
  const kinds = new Map<string, 'app' | 'router'>();
  for (const call of calls) {
    if (!call.receiver) {
      warnings.push(
        `${call.file}:${call.line}: \`${call.receiverText}.${(call.method ?? 'use').toLowerCase()}(...)\` registers on a value that isn't an app or router created in this repo with express() or Router(), so it can't be placed in the route tree`,
      );
      continue;
    }
    kinds.set(call.receiver.key, call.receiver.kind);
    byReceiver.set(call.receiver.key, [...(byReceiver.get(call.receiver.key) ?? []), call]);
  }
  for (const list of byReceiver.values()) list.sort((a, b) => a.file.localeCompare(b.file) || a.orderIdx - b.orderIdx);

  const mounted = new Set(calls.flatMap((c) => c.handlers.flatMap((h) => (h.kind === 'router' ? [h.receiverKey] : []))));
  const roots = [...byReceiver.keys()].filter((k) => kinds.get(k) === 'app' && !mounted.has(k)).sort();
  const reached = new Set<string>();
  const routes: StitchedRoute[] = [];

  const walk = (key: string, prefix: string, mountChain: MountFact[], inherited: Scoped[], outerErrors: Scoped[], stack: string[]): void => {
    reached.add(key);
    const list = byReceiver.get(key) ?? [];
    const phase: MiddlewarePhase = kinds.get(key) === 'app' ? 'app' : 'router';
    const errorsAfter = (orderIdx: number): Scoped[] =>
      list
        .filter((c) => c.callKind === 'use' && c.orderIdx > orderIdx)
        .flatMap((c) => c.handlers.filter(isErrorHandler).map((h) => ({ scope: joinPath(prefix, pathOf(c)), mw: middlewareAt(c, 'error', h) })));
    const local: Scoped[] = [];

    for (const call of list) {
      if (call.callKind === 'use') {
        const scope = joinPath(prefix, pathOf(call));
        if (call.path === null && call.pathText !== null) {
          warnings.push(`${call.file}:${call.line}: mount path \`${call.pathText}\` is not a string literal; shown as *`);
        }
        const pending: Scoped[] = [];
        for (const h of call.handlers) {
          if (h.kind === 'router') {
            if (stack.includes(h.receiverKey)) {
              warnings.push(`${call.file}:${call.line}: \`${h.text}\` is already mounted above this router; skipped to avoid a loop`);
              continue;
            }
            const mount: MountFact = { file: call.file, line: call.line, endLine: call.endLine, prefix: pathOf(call) };
            walk(h.receiverKey, scope, [...mountChain, mount], [...inherited, ...local, ...pending], [...errorsAfter(call.orderIdx), ...outerErrors], [...stack, h.receiverKey]);
          } else if (!isErrorHandler(h)) {
            pending.push({ scope, mw: middlewareAt(call, phase, h) });
          }
        }
        local.push(...pending);
        continue;
      }

      const own = call.handlers.filter((h) => h.kind !== 'router');
      const handler = own.at(-1);
      if (!handler) continue;
      const fullPath = joinPath(prefix, pathOf(call));
      const applies = (s: Scoped) => hasPrefix(fullPath, s.scope);
      routes.push({
        method: call.method ?? 'ALL',
        fullPath,
        file: call.file,
        line: call.line,
        endLine: call.endLine,
        handler,
        mountChain,
        middleware: [
          ...[...inherited, ...local].filter(applies).map((s) => s.mw),
          ...own.slice(0, -1).map((h) => middlewareAt(call, 'route', h)),
          ...[...errorsAfter(call.orderIdx), ...outerErrors].filter(applies).map((s) => s.mw),
        ],
        warnings: call.path === null && call.pathText !== null ? [`${call.file}:${call.line}: path \`${call.pathText}\` is not a string literal; shown as *`] : [],
      });
    }
  };

  for (const root of roots) walk(root, '/', [], [], [], [root]);
  for (const [key, list] of byReceiver) {
    if (reached.has(key) || !list.some((c) => c.callKind === 'route')) continue;
    const at = key.lastIndexOf('#');
    warnings.push(`${key.slice(0, at)}: router \`${key.slice(at + 1)}\` has routes but is never mounted on an app`);
  }
  return { routes, warnings };
}

/** "/api" + "/patients/" -> "/api/patients"; always one leading slash, no trailing slash except "/". */
export function joinPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/** The symbol a handler runs, for joining to the symbols table: a factory runs the function it returns. */
export function handlerKey(h: HandlerArg): SymbolKey | null {
  if (h.kind === 'symbol' || h.kind === 'inline') return h.key;
  if (h.kind === 'factory') return h.key ?? h.factory;
  return null;
}

/** How a handler is shown: the symbol name, or the source text for packages and unresolved values. */
export function handlerLabel(h: HandlerArg): string {
  if (h.kind === 'symbol' || h.kind === 'inline') return h.key.name;
  if (h.kind === 'factory') return h.key?.name ?? h.text;
  return h.text;
}

export function handlerNote(h: HandlerArg, file: string, line: number): string | null {
  return h.kind === 'unresolved' ? `unresolved: likely ${h.text} (middleware registered at ${file}:${line})` : null;
}

function pathOf(call: RouterCallRecord): string {
  return call.path ?? (call.pathText !== null ? '*' : '/');
}

function hasPrefix(path: string, scope: string): boolean {
  return scope === '/' || path === scope || path.startsWith(`${scope}/`);
}

function isErrorHandler(h: HandlerArg): boolean {
  return 'arity' in h && h.arity === 4;
}

function middlewareAt(call: RouterCallRecord, phase: MiddlewarePhase, handler: HandlerArg): StitchedMiddleware {
  return { phase, handler, file: call.file, line: call.line, endLine: call.endLine };
}
