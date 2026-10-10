import { createHash } from 'node:crypto';
import { closestRoutes, matchRoutes, parseEndpointTarget, type EndpointTarget } from '../routes/match.js';
import type { Store } from '../store/index.js';
import type { MiddlewarePhase, MiddlewareRecord, MountFact, RouteRecord, SideEffectKind, SymbolRecord } from '../store/types.js';
import type { CalleeFact, CodeBlock, PackageFact, UnresolvedFact } from './fn.js';
import { Budget, collectPackages, NON_CODE_KINDS, PROMPT_RESERVE_TOKENS, SourceCache } from './shared.js';
import { TargetError } from './target.js';

// Selects the code and static facts for `walk endpoint` (CLAUDE.md §6.3): the matched route and its
// mounts, the middleware chain in execution order, the handler, everything they call (to --depth),
// side effects per function and the error paths. The same object is the `--no-llm` output and the
// LLM's only input.

export interface EndpointNode {
  phase: MiddlewarePhase | 'handler';
  label: string;
  /** Null for package middleware (e.g. express.json()) and handlers that couldn't be resolved. */
  symbol: SymbolRecord | null;
  /** The registration call, e.g. `router.post(...)`. */
  registeredAt: { file: string; line: number; endLine: number };
  code: CodeBlock | null;
  note: string | null;
}

export interface EndpointSideEffect {
  symbol: Pick<SymbolRecord, 'id' | 'file' | 'name'>;
  kind: SideEffectKind;
  detail: string;
  line: number;
}

export interface ErrorPath {
  symbol: Pick<SymbolRecord, 'id' | 'file' | 'name'>;
  line: number;
  /** e.g. "ConflictError", "rethrows err", "forwards err". */
  error: string;
  /** The status the error class sets; null when the error handler decides. */
  status: number | null;
}

export interface EndpointContext {
  /** "<METHOD> <full path>" of the matched route; the saved walkthrough's scope. */
  scopeRef: string;
  route: { id: number; method: string; fullPath: string; mounts: MountFact[]; warnings: string[] };
  /** Mount, middleware and route registration lines, adjacent lines merged. */
  registrations: CodeBlock[];
  /** Middleware in execution order, then the handler. */
  chain: EndpointNode[];
  /** Error-handling middleware that runs when a node fails, in order. */
  errorHandlers: EndpointNode[];
  /** Calls made by the chain and error handlers, transitively to --depth; each body is included once. */
  callees: CalleeFact[];
  /** Database, Redis, HTTP and queue effects (thrown errors are in errorPaths). */
  sideEffects: EndpointSideEffect[];
  errorPaths: ErrorPath[];
  unresolved: UnresolvedFact[];
  packages: PackageFact[];
  /** Line count of every file the context cites; the verifier's bounds. */
  files: Record<string, number>;
  omitted: string[];
  warnings: string[];
  /** Hash of the resolved chain; a saved walkthrough is stale when it changes. */
  chainHash: string;
}

export interface EndpointContextOptions {
  depth: number;
  maxContextTokens: number;
}

const STATUS = /\s*\((\d{3})\)$/;

export async function buildEndpointContext(store: Store, repoRoot: string, target: EndpointTarget, options: EndpointContextOptions): Promise<EndpointContext> {
  const { route, warnings: matchWarnings } = await findRoute(store, target);
  const middleware = await store.getMiddlewareChain(route.id);
  const source = new SourceCache(repoRoot);
  const budget = new Budget(options.maxContextTokens - PROMPT_RESERVE_TOKENS);
  const omitted: string[] = [];

  const registrations = mergeRanges([
    ...route.mountChain.map((m) => ({ file: m.file, start: m.line, end: m.endLine })),
    ...middleware.map((m) => ({ file: m.file, start: m.line, end: m.endLine })),
    { file: route.file, start: route.line, end: route.endLine },
  ]).map((r) => source.block(r.file, r.start, r.end));
  if (!registrations.every((b) => budget.take(b))) {
    throw new TargetError(`The registrations of ${route.method} ${route.fullPath} alone exceed llm.maxContextTokens (${options.maxContextTokens}).`);
  }

  // Each symbol's body is sent once, in priority order: chain, error handlers, then callees (shallowest first).
  const shown = new Set<number>();
  const body = (symbol: SymbolRecord, label: string): CodeBlock | null => {
    if (NON_CODE_KINDS.has(symbol.kind) || shown.has(symbol.id)) return null;
    shown.add(symbol.id);
    const block = source.block(symbol.file, symbol.startLine, symbol.endLine);
    if (budget.take(block)) return block;
    omitted.push(`body of ${label} (${symbol.file}:${symbol.startLine})`);
    return null;
  };

  const nodeOf = (m: MiddlewareRecord): EndpointNode => ({
    phase: m.phase, label: m.label, symbol: m.symbol, registeredAt: { file: m.file, line: m.line, endLine: m.endLine }, code: null, note: m.unresolvedNote,
  });
  const chain: EndpointNode[] = [
    ...middleware.filter((m) => m.phase !== 'error').map(nodeOf),
    {
      phase: 'handler',
      label: route.handlerLabel,
      symbol: route.handler,
      registeredAt: { file: route.file, line: route.line, endLine: route.endLine },
      code: null,
      note: route.handler ? null : `unresolved: handler \`${route.handlerLabel}\` of ${route.method} ${route.fullPath} is not a function in this repo (${route.file}:${route.line})`,
    },
  ];
  const errorHandlers = middleware.filter((m) => m.phase === 'error').map(nodeOf);
  for (const node of [...chain, ...errorHandlers]) if (node.symbol) node.code = body(node.symbol, node.label);

  const owners = uniqueById([...chain, ...errorHandlers].flatMap((n) => (n.symbol && !NON_CODE_KINDS.has(n.symbol.kind) ? [n.symbol] : [])));
  const callees: CalleeFact[] = (await collectCallees(store, owners, options.depth)).map((c) => ({ ...c, code: c.callee ? body(c.callee, c.callee.name) : null }));

  const symbols = uniqueById([...owners, ...callees.flatMap((c) => (c.callee ? [c.callee] : []))]);
  const rank = new Map(symbols.map((s, i) => [s.id, i]));
  const effects = (await store.getSideEffects(symbols.map((s) => s.id)))
    .sort((a, b) => rank.get(a.symbolId)! - rank.get(b.symbolId)! || a.line - b.line)
    .map((e) => {
      const s = symbols[rank.get(e.symbolId)!];
      return { symbol: { id: s.id, file: s.file, name: s.name }, kind: e.kind, detail: e.detail, line: e.line };
    });
  const errorPaths: ErrorPath[] = effects
    .filter((e) => e.kind === 'throws')
    .map((e) => {
      const m = STATUS.exec(e.detail);
      return { symbol: e.symbol, line: e.line, error: m ? e.detail.slice(0, m.index) : e.detail, status: m ? Number(m[1]) : null };
    });

  const unresolved: UnresolvedFact[] = [
    ...[...chain, ...errorHandlers].flatMap((n) => (n.note ? [{ calleeText: n.label, file: n.registeredAt.file, line: n.registeredAt.line, note: n.note }] : [])),
    ...callees
      .filter((c) => !c.resolved)
      .map((c) => ({
        calleeText: c.calleeText,
        file: c.caller.file,
        line: c.callLine,
        note: `unresolved: likely ${c.calleeText} (dynamic call in ${c.caller.name} at ${c.caller.file}:${c.callLine})`,
      })),
  ];

  const cited = [...registrations.map((b) => b.file), ...symbols.map((s) => s.file), ...callees.map((c) => c.caller.file)];
  const files = Object.fromEntries([...new Set(cited)].sort().map((f) => [f, source.lineCount(f)]));

  return {
    scopeRef: `${route.method} ${route.fullPath}`,
    route: { id: route.id, method: route.method, fullPath: route.fullPath, mounts: route.mountChain, warnings: route.warnings },
    registrations,
    chain,
    errorHandlers,
    callees,
    sideEffects: effects.filter((e) => e.kind !== 'throws'),
    errorPaths,
    unresolved,
    packages: await collectPackages(store, Object.keys(files)),
    files,
    omitted,
    warnings: [...matchWarnings, ...route.warnings, ...(await store.getRouteWarnings())],
    chainHash: chainHashOf(route, middleware),
  };
}

/** Changes when the route's middleware, their order, or the functions they resolve to change. */
export function chainHashOf(route: RouteRecord, middleware: MiddlewareRecord[]): string {
  const entry = (phase: string, label: string, s: SymbolRecord | null) => `${phase} ${label} ${s ? `${s.file}#${s.name}` : '-'}`;
  const lines = [
    `${route.method} ${route.fullPath}`,
    ...middleware.map((m) => entry(m.phase, m.label, m.symbol)),
    entry('handler', route.handlerLabel, route.handler),
  ];
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The chain hash of the route a saved endpoint walkthrough explains; null when the route is gone. */
export async function currentChainHash(store: Store, scopeRef: string): Promise<string | null> {
  const target = parseEndpointTarget(scopeRef);
  const route = (await store.listRoutes()).find((r) => r.method === target.method && r.fullPath === target.path);
  return route ? chainHashOf(route, await store.getMiddlewareChain(route.id)) : null;
}

async function findRoute(store: Store, target: EndpointTarget): Promise<{ route: RouteRecord; warnings: string[] }> {
  const routes = await store.listRoutes();
  // Registrations stitching couldn't place usually explain a missing route, so they go in the error.
  const withIndexWarnings = async (message: string) => {
    const warnings = await store.getRouteWarnings();
    return new TargetError(warnings.length ? `${message}\nIndex warnings:\n${warnings.map((w) => `- ${w}`).join('\n')}` : message);
  };
  if (routes.length === 0) {
    throw await withIndexWarnings(
      'No Express routes in the index. Check that roots.backend in .walkthrough/config.json contains the code that calls express() and mounts your routers.',
    );
  }
  const matches = matchRoutes(routes, target);
  if (matches.length === 0) {
    const near = closestRoutes(routes, target);
    throw await withIndexWarnings(`No route matches ${target.method} ${target.path}.${near.length ? ` Closest: ${near.map(describeRoute).join(', ')}` : ''}`);
  }
  const [first, ...others] = matches;
  if (others.length === 0) return { route: first, warnings: [] };
  if (others.some((r) => r.method !== first.method || r.fullPath !== first.fullPath)) {
    throw new TargetError(`${target.method} ${target.path} matches ${matches.length} routes: ${matches.map(describeRoute).join(', ')}. Name one exactly.`);
  }
  // The same method and path registered more than once (two apps mounting one router, or a repeated
  // route): Express serves the first registration, so that one is explained.
  const mountOf = (r: RouteRecord) => (r.mountChain[0] ? `${r.mountChain[0].file}:${r.mountChain[0].line}` : '');
  const byMount = new Set(matches.map(mountOf)).size === matches.length;
  const where = (r: RouteRecord) => (byMount && r.mountChain[0] ? `mounted via ${mountOf(r)}` : `${r.file}:${r.line}`);
  return {
    route: first,
    warnings: [`${first.method} ${first.fullPath} is registered ${matches.length} times; explaining the first (${where(first)}). Also: ${others.map(where).join(', ')}`],
  };
}

function describeRoute(r: RouteRecord): string {
  return `${r.method} ${r.fullPath} (${r.file}:${r.line})`;
}

/**
 * Calls made by `owners`, transitively to `depth`, one recursive query per owner. A call between two
 * owners is left out (each is a chain node of its own); a call reached from several owners is kept once.
 */
async function collectCallees(store: Store, owners: SymbolRecord[], depth: number): Promise<Omit<CalleeFact, 'code'>[]> {
  const ownerIds = new Set(owners.map((o) => o.id));
  const names = new Map<number, Pick<SymbolRecord, 'id' | 'file' | 'name'>>(owners.map((o) => [o.id, o]));
  const rows = (await Promise.all(owners.map((o) => store.getCallees(o.id, depth)))).flat().sort((a, b) => a.depth - b.depth);
  const seen = new Set<string>();
  const kept: Omit<CalleeFact, 'code'>[] = [];
  for (const row of rows) {
    if (row.callee && ownerIds.has(row.callee.id)) continue;
    const key = `${row.callerId}:${row.callLine}:${row.calleeText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const caller = names.get(row.callerId);
    if (!caller) continue;
    if (row.callee) names.set(row.callee.id, row.callee);
    kept.push({
      depth: row.depth,
      caller: { id: caller.id, file: caller.file, name: caller.name },
      callee: row.callee,
      calleeText: row.calleeText,
      callLine: row.callLine,
      resolved: row.resolved,
    });
  }
  return kept;
}

function mergeRanges(ranges: { file: string; start: number; end: number }[]): { file: string; start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  const merged: { file: string; start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = merged.at(-1);
    if (last && last.file === r.file && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

function uniqueById<T extends { id: number }>(items: T[]): T[] {
  const seen = new Set<number>();
  return items.filter((i) => !seen.has(i.id) && (seen.add(i.id), true));
}
