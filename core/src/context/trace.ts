import { createHash } from 'node:crypto';
import type { PinnedEdge } from '../config.js';
import { parseEndpointTarget, type EndpointTarget } from '../routes/match.js';
import type { Store } from '../store/index.js';
import type { CrossEdgeRecord, EdgeMatch, RouteRecord, SymbolRecord } from '../store/types.js';
import { buildComponentContext, componentStructure, structureHashOf, type ComponentApiCall, type ComponentContext } from './component.js';
import { buildEndpointContext, currentChainHash, findRoute, type EndpointContext } from './endpoint.js';
import type { PackageFact, UnresolvedFact } from './fn.js';
import { parseComponentTarget, TargetError, type ComponentTarget } from './target.js';

// Selects the facts for `walk trace` (CLAUDE.md §6.5): the route, the frontend call(s) linked to it
// (cross_edges), the component whose user action or effect reaches that call, and both sides' contexts.
// A loose link is never followed silently: PinNeededError hands the choice to the user.

export interface TraceTarget {
  endpoint: EndpointTarget;
  /** --from: which calling component to trace; null = the only one. */
  from: ComponentTarget | null;
}

export interface TraceLink {
  /** The API call as the component context sees it, with its triggers. */
  call: ComponentApiCall;
  match: EdgeMatch;
  confidence: number;
  pinned: boolean;
}

/** A call the calling function makes after the request line, e.g. `setStatus('success')`, `onSuccess?.(patient)`. */
export interface AfterResponse {
  calleeText: string;
  file: string;
  line: number;
  /** The repo function called, when resolved. */
  callee: string | null;
}

export interface TraceContext {
  /** "<METHOD> <full path> <- <file>#<Component>"; the saved walkthrough's scope. */
  scopeRef: string;
  component: ComponentContext;
  endpoint: EndpointContext;
  link: TraceLink;
  afterResponse: AfterResponse[];
  files: Record<string, number>;
  packages: PackageFact[];
  unresolved: UnresolvedFact[];
  warnings: string[];
  /** Changes when the component's structure, the route's chain or the link changes. */
  traceHash: string;
}

export interface TraceContextOptions {
  depth: number;
  maxContextTokens: number;
}

/** The route has no confirmed caller, but these calls match it loosely: the user must pin one. */
export class PinNeededError extends Error {
  constructor(
    public readonly route: { method: string; fullPath: string },
    public readonly candidates: CrossEdgeRecord[],
  ) {
    super(
      `${route.method} ${route.fullPath} has no confirmed frontend caller. These calls match it only loosely:\n` +
        candidates.map((c, i) => `  [${i + 1}] ${describeCandidate(c)}`).join('\n'),
    );
    this.name = 'PinNeededError';
  }
}

const MAX_HOPS = 8;

export async function buildTraceContext(store: Store, repoRoot: string, target: TraceTarget, options: TraceContextOptions): Promise<TraceContext> {
  const { route, warnings: matchWarnings } = await findRoute(store, target.endpoint);
  // A `router.all` route serves every method: trace only the calls made with the one asked for.
  const method = route.method === 'ALL' ? target.endpoint.method : route.method;
  const edges = (await store.getCrossEdges(route.id)).filter((e) => route.method !== 'ALL' || e.apiCall.method === method || e.apiCall.method === 'UNKNOWN');
  const resolved = edges.filter((e) => e.resolved);
  const loose = edges.filter((e) => !e.callResolved);
  if (resolved.length === 0) {
    if (loose.length > 0) throw new PinNeededError(route, loose);
    throw new TargetError(
      `No frontend API call matches ${method} ${route.fullPath}. Check apiClientWrappers in .walkthrough/config.json, and that the frontend builds this URL from a string or template literal.`,
    );
  }

  const caller = pickCaller(route, resolved, await callersOf(store, resolved), target.from);
  const half = Math.floor(options.maxContextTokens / 2);
  const component = await buildComponentContext(store, repoRoot, { file: caller.component.file, name: caller.component.name }, { depth: options.depth, maxContextTokens: half });
  const call = component.apiCalls.find((a) => a.symbol.id === caller.edge.apiCall.caller.id && a.line === caller.edge.apiCall.line);
  if (!call) {
    throw new TargetError(
      `${caller.component.name} reaches ${caller.edge.apiCall.caller.name} only beyond --depth ${options.depth}; run again with a larger --depth.`,
    );
  }
  const endpoint = await buildEndpointContext(store, repoRoot, { method: route.method, path: route.fullPath }, { depth: options.depth, maxContextTokens: half });
  const link: TraceLink = { call, match: caller.edge.match, confidence: caller.edge.confidence, pinned: caller.edge.pinned };

  const afterResponse: AfterResponse[] = component.callees
    .filter((c) => c.caller.id === call.symbol.id && c.callLine > call.line)
    .map((c) => ({ calleeText: c.calleeText, file: c.caller.file, line: c.callLine, callee: c.callee?.name ?? null }));

  const warnings = [
    ...matchWarnings,
    ...component.warnings,
    ...endpoint.warnings,
    ...(call.triggers.length === 0 ? [`No user action or effect in ${caller.component.name} was found to trigger this call.`] : []),
    ...loose.map((e) => `Also loosely matching this route, not traced (pin it to trace it): ${describeCandidate(e)}`),
  ];
  const files = Object.fromEntries(Object.entries({ ...component.files, ...endpoint.files }).sort(([a], [b]) => a.localeCompare(b)));
  const packages = [...new Map([...component.packages, ...endpoint.packages].map((p) => [p.name, p])).values()];
  const unresolved = [...new Map([...component.unresolved, ...endpoint.unresolved].map((u) => [u.note, u])).values()];

  return {
    scopeRef: `${method} ${route.fullPath} <- ${component.scopeRef}`,
    component,
    endpoint,
    link,
    afterResponse,
    files,
    packages,
    unresolved,
    warnings: [...new Set(warnings)],
    traceHash: traceHashOf(component.structureHash, endpoint.chainHash, caller.edge),
  };
}

/** The trace hash a saved trace would have now, from the index alone; null when its route, component or link is gone. */
export async function currentTraceHash(store: Store, _repoRoot: string, scopeRef: string, depth: number): Promise<string | null> {
  const [routeRef, componentRef] = scopeRef.split(' <- ');
  if (!componentRef) return null;
  try {
    const target = parseEndpointTarget(routeRef);
    // The scope names the method traced; a `router.all` route is stored as ALL.
    const route = (await store.listRoutes()).find((r) => (r.method === target.method || r.method === 'ALL') && r.fullPath === target.path);
    const chain = route ? await currentChainHash(store, `${route.method} ${route.fullPath}`) : null;
    if (!route || chain === null) return null;
    const structure = await componentStructure(store, parseComponentTarget(componentRef), depth);
    const edge = (await store.getCrossEdges(route.id)).find(
      (e) =>
        e.resolved &&
        (route.method !== 'ALL' || e.apiCall.method === target.method || e.apiCall.method === 'UNKNOWN') &&
        structure.apiCalls.some((a) => a.symbol.id === e.apiCall.caller.id && a.line === e.apiCall.line),
    );
    return edge ? traceHashOf(structureHashOf(structure), chain, edge) : null;
  } catch (err) {
    if (err instanceof TargetError) return null;
    throw err;
  }
}

export function describeCandidate(c: CrossEdgeRecord): string {
  const a = c.apiCall;
  return `${a.method} ${a.urlPattern} in ${a.caller.name} (${a.caller.file}:${a.line}): ${c.match} match (${c.confidence.toFixed(1)})`;
}

export function describeLink(link: TraceLink): string {
  return link.pinned ? 'pinned in .walkthrough/config.json' : `${link.match} match, confidence ${link.confidence.toFixed(1)}`;
}

/** The pinnedEdges entry that links candidate `c` to `route`. */
export function pinFor(c: CrossEdgeRecord, route: { method: string; fullPath: string }): PinnedEdge {
  return { caller: `${c.apiCall.caller.file}#${c.apiCall.caller.name}`, method: c.apiCall.method, url: c.apiCall.urlPattern, route: `${route.method} ${route.fullPath}` };
}

function traceHashOf(structureHash: string, chainHash: string, edge: CrossEdgeRecord): string {
  const a = edge.apiCall;
  const link = `${a.caller.file}#${a.caller.name} ${a.method} ${a.urlPattern} ${edge.match} ${edge.pinned}`;
  return createHash('sha256').update([`component ${structureHash}`, `endpoint ${chainHash}`, `link ${link}`].join('\n')).digest('hex');
}

interface Caller {
  component: SymbolRecord;
  edge: CrossEdgeRecord;
}

/** Each component that reaches one of the edges' calls, with the first such edge. */
async function callersOf(store: Store, edges: CrossEdgeRecord[]): Promise<Caller[]> {
  const callers = new Map<number, Caller>();
  for (const edge of edges) {
    for (const component of await componentsReaching(store, edge.apiCall.caller)) {
      if (!callers.has(component.id)) callers.set(component.id, { component, edge });
    }
  }
  return [...callers.values()].sort((a, b) => a.component.file.localeCompare(b.component.file) || a.component.startLine - b.component.startLine);
}

/**
 * Components from which `start` is reached, walking up at most MAX_HOPS: through callers, through JSX
 * handlers that name a function (`onClick={logout}`), and stopping at the component that encloses a
 * function (`EnrollForm.handleSubmit` -> `EnrollForm`).
 */
async function componentsReaching(store: Store, start: SymbolRecord): Promise<SymbolRecord[]> {
  const found = new Map<number, SymbolRecord>();
  const seen = new Set<number>([start.id]);
  const fileSymbols = new Map<string, SymbolRecord[]>();
  const symbolsOf = async (file: string) => {
    if (!fileSymbols.has(file)) fileSymbols.set(file, await store.getSymbolsInFile(file));
    return fileSymbols.get(file)!;
  };
  let frontier = [start];
  for (let hop = 0; hop <= MAX_HOPS && frontier.length > 0; hop++) {
    const next: SymbolRecord[] = [];
    for (const s of frontier) {
      const enclosing =
        s.kind === 'component'
          ? s
          : (await symbolsOf(s.file))
              .filter((c) => c.kind === 'component' && c.startLine <= s.startLine && c.endLine >= s.endLine)
              .sort((a, b) => b.startLine - a.startLine)[0];
      if (enclosing) {
        found.set(enclosing.id, enclosing);
        continue;
      }
      const up = [...(await store.getCallers(s.id)).map((c) => c.caller), ...(await store.getHandlerOwners({ file: s.file, name: s.name, startLine: s.startLine }))];
      for (const u of up) {
        if (!seen.has(u.id)) {
          seen.add(u.id);
          next.push(u);
        }
      }
    }
    frontier = next;
  }
  return [...found.values()];
}

function pickCaller(route: RouteRecord, resolved: CrossEdgeRecord[], callers: Caller[], from: ComponentTarget | null): Caller {
  const ref = (c: Caller) => `${c.component.file}#${c.component.name}`;
  const list = callers.map(ref).join(', ');
  const endpoint = `${route.method} ${route.fullPath}`;
  if (from) {
    const matches = callers.filter((c) => c.component.file === from.file && (from.name === null || c.component.name === from.name));
    if (matches.length === 1) return matches[0];
    const named = `${from.file}${from.name ? `#${from.name}` : ''}`;
    if (matches.length > 1) throw new TargetError(`${named} has several components calling ${endpoint} (${matches.map(ref).join(', ')}); name one.`);
    throw new TargetError(`${named} doesn't call ${endpoint}; callers: ${list || 'none found'}.`);
  }
  if (callers.length === 1) return callers[0];
  if (callers.length === 0) {
    const calls = resolved.map((e) => `${e.apiCall.caller.name} (${e.apiCall.caller.file}:${e.apiCall.line})`).join(', ');
    throw new TargetError(`No component reaches the frontend call(s) to ${endpoint} within ${MAX_HOPS} calls: ${calls}. Use \`walk fn\` on the calling function instead.`);
  }
  throw new TargetError(`${endpoint} is called from ${callers.length} components: ${list}. Choose one with --from <file>#<Component>.`);
}
