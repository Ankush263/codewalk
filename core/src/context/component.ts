import { createHash } from 'node:crypto';
import type { Store } from '../store/index.js';
import type { ApiCallRecord, ReactFactRecord, SymbolKey, SymbolRecord } from '../store/types.js';
import { declarationsUsed, type DeclarationRef } from './declarations.js';
import { resolveTypes, type CalleeFact, type CodeBlock, type PackageFact, type TypeFact, type UnresolvedFact, type ValueFact } from './fn.js';
import { Budget, collectPackages, NON_CODE_KINDS, PROMPT_RESERVE_TOKENS, SourceCache } from './shared.js';
import { parseComponentTarget, TargetError, type ComponentTarget } from './target.js';

// Selects the code and static facts for `walk component` (CLAUDE.md §6.4): the component, the repo
// hooks it uses (expanded to --depth), its children one level deep, its handlers and effects, the code
// they call, and every API call reachable from them with the user action or effect that triggers it.
// The same object is the `--no-llm` output and the LLM's only input.

export interface ReactUnit {
  symbol: SymbolRecord;
  facts: ReactFactRecord;
  /** Null when it didn't fit the context budget. */
  code: CodeBlock | null;
  /** Functions declared inside it: event handlers, functions a hook returns. */
  inner: SymbolRecord[];
}

export interface ExpandedHook extends ReactUnit {
  /** 1 for hooks the component calls, 2 for hooks those call, ... */
  depth: number;
  /** Name of the component or hook that calls it. */
  usedBy: string;
  /** "file:line" of that call. */
  calledAt: string;
}

export interface ChildComponent {
  element: string;
  /** The repo component rendered (signature only); null for package components. */
  symbol: SymbolRecord | null;
  package: string | null;
  line: number;
  props: { name: string; value: string }[];
  condition: string | null;
}

export interface ApiTrigger {
  kind: 'event' | 'effect';
  /** e.g. "onSubmit on <form>", "useEffect [id] in usePatient". */
  label: string;
  /** "file:line" of the handler attribute or effect call. */
  at: string;
  /** Functions from the trigger to the call, e.g. ["EnrollForm.handleSubmit", "useEnrollMutation.mutate"]. */
  path: string[];
}

export interface ComponentApiCall {
  symbol: Pick<SymbolRecord, 'id' | 'file' | 'name'>;
  method: string;
  urlPattern: string;
  urlText: string;
  line: number;
  triggers: ApiTrigger[];
}

export interface ComponentContext {
  /** "<file>#<Component>"; the saved walkthrough's scope. */
  scopeRef: string;
  component: ReactUnit;
  /** Repo custom hooks, breadth first; package hooks are only listed in the facts. */
  hooks: ExpandedHook[];
  /** Component elements in the render tree, one level deep. */
  children: ChildComponent[];
  /** Calls made by the component, its hooks and their inner functions, to --depth; calls between them are left out. */
  callees: CalleeFact[];
  types: TypeFact[];
  values: ValueFact[];
  apiCalls: ComponentApiCall[];
  packages: PackageFact[];
  unresolved: UnresolvedFact[];
  /** Line count of every file the context cites; the verifier's bounds. */
  files: Record<string, number>;
  /** What was left out to fit the token budget. */
  omitted: string[];
  /** What the depth limits left out (CLAUDE.md §13). */
  limits: string[];
  warnings: string[];
  /** Hash of the hooks, children, handlers and API calls; a saved walkthrough is stale when it changes. */
  structureHash: string;
}

export interface ComponentContextOptions {
  depth: number;
  maxContextTokens: number;
}

const EFFECT_TRIGGERS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);

export async function buildComponentContext(store: Store, repoRoot: string, target: ComponentTarget, options: ComponentContextOptions): Promise<ComponentContext> {
  const fileRecord = await store.getFile(target.file);
  if (!fileRecord) {
    throw new TargetError(`${target.file} is not in the index. Check the path (relative to the repo root) or run \`walk index\`.`);
  }
  const source = new SourceCache(repoRoot);
  const warnings: string[] = [];
  if (source.hash(target.file) !== fileRecord.hash) {
    warnings.push(`${target.file} changed since it was indexed; run \`walk index\` for accurate facts.`);
  }

  const { component, hooks, units, calls, children, childRecords, apiCalls, limits } = await componentStructure(store, target, options.depth);
  const symbol = component.symbol;

  // Code in priority order: the component (must fit), hooks (shallowest first), types, values, callees.
  const budget = new Budget(options.maxContextTokens - PROMPT_RESERVE_TOKENS);
  const omitted: string[] = [];
  component.code = source.block(symbol.file, symbol.startLine, symbol.endLine);
  if (!budget.take(component.code)) {
    throw new TargetError(
      `${symbol.name} (${symbol.file}:${symbol.startLine}-${symbol.endLine}) is too large for llm.maxContextTokens (${options.maxContextTokens}); walk its parts with \`walk fn\`.`,
    );
  }
  for (const h of hooks) {
    const block = source.block(h.symbol.file, h.symbol.startLine, h.symbol.endLine);
    if (budget.take(block)) h.code = block;
    else omitted.push(`body of hook ${h.symbol.name} (${h.symbol.file}:${h.symbol.startLine})`);
  }

  const inUnits = (ref: DeclarationRef) => units.some((u) => ref.file === u.symbol.file && ref.line >= u.symbol.startLine && ref.line <= u.symbol.endLine);
  const used = units.map((u) => declarationsUsed(repoRoot, u.symbol.file, u.symbol.startLine, u.symbol.endLine));
  const types: TypeFact[] = (await resolveTypes(store, used.flatMap((d) => d.types).filter((r) => !inUnits(r)))).map((s) => {
    const code = source.block(s.file, s.startLine, s.endLine);
    if (budget.take(code)) return { symbol: s, code };
    omitted.push(`body of type ${s.name} (${s.file}:${s.startLine})`);
    return { symbol: s, code: null };
  });
  const valueRefs = uniqueBy(used.flatMap((d) => d.values).filter((v) => !inUnits(v)), (v) => `${v.file}:${v.line}`);
  const values: ValueFact[] = valueRefs.map((v) => {
    const code = source.block(v.file, v.line, v.endLine);
    const fact = { name: v.name, file: v.file, startLine: v.line, endLine: v.endLine };
    if (budget.take(code)) return { ...fact, code };
    omitted.push(`declaration of ${v.name} (${v.file}:${v.line})`);
    return { ...fact, code: null };
  });

  const shown = new Set<number>();
  const callees: CalleeFact[] = calls.map((c) => {
    if (c.depth !== 1 || !c.callee || NON_CODE_KINDS.has(c.callee.kind) || shown.has(c.callee.id)) return { ...c, code: null };
    shown.add(c.callee.id);
    const block = source.block(c.callee.file, c.callee.startLine, c.callee.endLine);
    if (budget.take(block)) return { ...c, code: block };
    omitted.push(`body of ${c.callee.name} (${c.callee.file}:${c.callee.startLine})`);
    return { ...c, code: null };
  });

  const unitOf = new Map<number, ReactUnit>();
  for (const u of units) for (const s of [u.symbol, ...u.inner]) unitOf.set(s.id, u);
  const unresolved: UnresolvedFact[] = callees
    .filter((c) => !c.resolved)
    .map((c) => ({ calleeText: c.calleeText, file: c.caller.file, line: c.callLine, note: unresolvedNote(c, unitOf.get(c.caller.id), units) }));

  const cited = [
    ...units.map((u) => u.symbol.file),
    ...callees.flatMap((c) => [c.caller.file, ...(c.callee ? [c.callee.file] : [])]),
    ...types.map((t) => t.symbol.file),
    ...values.map((v) => v.file),
    ...childRecords.map((s) => s.file),
  ];
  const files = Object.fromEntries([...new Set(cited)].sort().map((f) => [f, source.lineCount(f)]));

  const ctx = {
    scopeRef: `${symbol.file}#${symbol.name}`,
    component,
    hooks,
    children,
    callees,
    types,
    values,
    apiCalls,
    packages: await collectPackages(store, Object.keys(files)),
    unresolved,
    files,
    omitted,
    limits,
    warnings,
  };
  return { ...ctx, structureHash: structureHashOf(ctx) };
}

interface ComponentStructure {
  component: ReactUnit;
  hooks: ExpandedHook[];
  units: ReactUnit[];
  calls: Omit<CalleeFact, 'code'>[];
  children: ChildComponent[];
  childRecords: SymbolRecord[];
  apiCalls: ComponentApiCall[];
  limits: string[];
}

/**
 * Everything about the component that comes from the index alone: the hooks it expands, the calls they
 * and its handlers make, its children and its API calls with their triggers. Reads no source files, so
 * `walk list` can use it cheaply. Orders are by file, line and name, never by database id.
 */
async function componentStructure(store: Store, target: ComponentTarget, depth: number): Promise<ComponentStructure> {
  const symbolsOf = fileSymbolsLoader(store);
  const symbol = pickComponent(target, await symbolsOf(target.file));
  const [facts] = await store.getReactFacts([symbol.id]);
  if (!facts) throw new TargetError(`No React facts for ${symbol.name}; run \`walk index\` to re-extract ${target.file}.`);
  const component: ReactUnit = { symbol, facts, code: null, inner: innerOf(symbol, await symbolsOf(symbol.file)) };

  const limits: string[] = [];
  const hooks = await expandHooks(store, component, depth, symbolsOf, limits);
  const units: ReactUnit[] = [component, ...hooks];

  const owners = uniqueBy(units.flatMap((u) => [u.symbol, ...u.inner]).filter((o) => !NON_CODE_KINDS.has(o.kind)), (o) => String(o.id));
  const ownerIds = new Set(owners.map((o) => o.id));
  // A function passed as a handler (`onClick={logout}`, `onClick={mutate}`) isn't called by the component,
  // but the user's action calls it: it is a depth-1 callee, and the calls it makes are followed.
  const handlerTargets = await store.getSymbolsByKeys(facts.handlers.flatMap((h) => (h.target ? [h.target] : [])));
  const handlerRoots = handlerTargets.filter((s) => !ownerIds.has(s.id) && !NON_CODE_KINDS.has(s.kind));
  const handlerCalls: Omit<CalleeFact, 'code'>[] = handlerRoots.map((s) => {
    const binding = facts.handlers.find((h) => h.target && sameKey(s, h.target))!;
    return {
      depth: 1,
      caller: { id: symbol.id, file: symbol.file, name: symbol.name },
      callee: s,
      calleeText: binding.handler,
      callLine: binding.line,
      resolved: true,
    };
  });
  const roots = [...owners.map((o) => ({ symbol: o, depth: 0 })), ...handlerRoots.map((s) => ({ symbol: s, depth: 1 }))];
  const { callees, edges } = await collectCallees(store, roots, ownerIds, depth);
  const calls = [...handlerCalls, ...callees];

  const childRecords = await store.getSymbolsByKeys(facts.render.flatMap((r) => (r.kind === 'component' && r.component ? [r.component] : [])));
  const children: ChildComponent[] = facts.render
    .filter((r) => r.kind === 'component')
    .map((r) => ({
      element: r.element,
      symbol: (r.component && childRecords.find((s) => sameKey(s, r.component!))) || null,
      package: r.package,
      line: r.line,
      props: r.props,
      condition: r.condition,
    }));
  for (const s of childRecords) {
    limits.push(`${s.name} (${s.file}:${s.startLine}): internals not expanded; child components are shown one level deep. Run \`walk component ${s.file}#${s.name}\`.`);
  }

  const calleeSymbols = calls.flatMap((c) => (c.callee ? [c.callee] : []));
  const reached = new Map<number, SymbolRecord>([...owners, ...calleeSymbols].map((s) => [s.id, s]));
  const graph = new CallGraph(edges, reached);
  const apiCalls: ComponentApiCall[] = (await store.getApiCalls([...reached.keys()]))
    .map((row) => {
      const s = reached.get(row.symbolId)!;
      return {
        symbol: { id: s.id, file: s.file, name: s.name },
        method: row.method,
        urlPattern: row.urlPattern,
        urlText: row.urlText,
        line: row.line,
        triggers: triggersOf(row, component, units, handlerTargets, graph),
      };
    })
    .sort((a, b) => a.symbol.file.localeCompare(b.symbol.file) || a.line - b.line || a.method.localeCompare(b.method) || a.urlPattern.localeCompare(b.urlPattern));

  return { component, hooks, units, calls, children, childRecords, apiCalls, limits };
}

/** Changes when the hooks expanded, the children, the handler bindings or the API calls (and their triggers) change. Line moves don't count. */
export function structureHashOf(ctx: Pick<ComponentContext, 'component' | 'hooks' | 'children' | 'apiCalls'>): string {
  const key = (s: { file: string; name: string }) => `${s.file}#${s.name}`;
  const lines = [
    `component ${key(ctx.component.symbol)}`,
    ...ctx.hooks.map((h) => `hook ${h.depth} ${h.usedBy} ${key(h.symbol)}`),
    ...ctx.children.map((c) => `child ${c.element} ${c.symbol ? key(c.symbol) : (c.package ?? '-')}`),
    ...ctx.component.facts.handlers.map((h) => `handler ${h.event} ${h.element} ${h.handler}`),
    ...ctx.apiCalls.map((a) => `api ${a.method} ${a.urlPattern} ${key(a.symbol)} ${a.triggers.map((t) => `${t.label}:${t.path.join('>')}`).join(',')}`),
  ];
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The structure hash a saved component walkthrough would have now; null when the component is gone. */
export async function currentStructureHash(store: Store, _repoRoot: string, scopeRef: string, depth: number): Promise<string | null> {
  try {
    return structureHashOf(await componentStructure(store, parseComponentTarget(scopeRef), depth));
  } catch (err) {
    if (err instanceof TargetError) return null;
    throw err;
  }
}

export function describeTrigger(t: ApiTrigger): string {
  return `${t.label} (${t.at}) → ${t.path.join(' → ')}`;
}

function pickComponent(target: ComponentTarget, fileSymbols: SymbolRecord[]): SymbolRecord {
  const components = fileSymbols.filter((s) => s.kind === 'component');
  const list = components.map((c) => c.name).join(', ');
  if (target.name === null) {
    if (components.length === 1) return components[0];
    if (components.length === 0) throw new TargetError(`No React components in ${target.file}. Use \`walk file ${target.file}\` for other code.`);
    throw new TargetError(`${target.file} has ${components.length} components (${list}); name one, e.g. \`walk component ${target.file}#${components[0].name}\`.`);
  }
  const matches = fileSymbols.filter((s) => s.name === target.name);
  if (matches.length === 0) throw new TargetError(`No component "${target.name}" in ${target.file}.${list ? ` Components here: ${list}` : ''}`);
  const [match] = matches;
  if (match.kind !== 'component') {
    throw new TargetError(`${target.name} in ${target.file} is a ${match.kind}, not a React component; use \`walk fn ${target.file}#${target.name}\` instead.`);
  }
  if (matches.length > 1) throw new TargetError(`"${target.name}" is ambiguous in ${target.file}; it is declared ${matches.length} times.`);
  return match;
}

/** Repo hooks reachable through `hooks_used.callee`, breadth first, each expanded once, up to `maxDepth`. */
async function expandHooks(
  store: Store,
  component: ReactUnit,
  maxDepth: number,
  symbolsOf: (file: string) => Promise<SymbolRecord[]>,
  limits: string[],
): Promise<ExpandedHook[]> {
  const hooks: ExpandedHook[] = [];
  const seen = new Set<number>([component.symbol.id]);
  let frontier: ReactUnit[] = [component];
  for (let depth = 1; frontier.length > 0; depth++) {
    const uses = frontier.flatMap((unit) => unit.facts.hooks.flatMap((use) => (use.callee ? [{ unit, use, key: use.callee }] : [])));
    const found = await store.getSymbolsByKeys(uses.map((u) => u.key));
    const factsById = new Map((await store.getReactFacts(found.map((s) => s.id))).map((f) => [f.symbolId, f]));
    const next: ExpandedHook[] = [];
    for (const { unit, use, key } of uses) {
      const calledAt = `${unit.symbol.file}:${use.line}`;
      const symbol = found.find((s) => sameKey(s, key));
      if (!symbol) {
        limits.push(`${use.name} at ${calledAt}: hook not found in the index; run \`walk index\``);
        continue;
      }
      if (seen.has(symbol.id)) continue;
      seen.add(symbol.id);
      const facts = factsById.get(symbol.id);
      if (depth > maxDepth || !facts) {
        limits.push(`${symbol.name} (used by ${unit.symbol.name} at ${calledAt}) is not expanded: --depth ${maxDepth}`);
        continue;
      }
      const hook: ExpandedHook = { symbol, facts, code: null, inner: innerOf(symbol, await symbolsOf(symbol.file)), depth, usedBy: unit.symbol.name, calledAt };
      hooks.push(hook);
      next.push(hook);
    }
    frontier = next;
  }
  return hooks;
}

interface Edge {
  from: number;
  to: number;
  line: number;
}

/**
 * Calls made from `roots`, transitively to `maxDepth` (each root starts at its own depth), one recursive
 * query per root. Every resolved call becomes an edge (for trigger paths); calls into an owner are left
 * out of the list, because each owner is explained in full on its own. Sorted by depth, file, line.
 */
async function collectCallees(
  store: Store,
  roots: { symbol: SymbolRecord; depth: number }[],
  ownerIds: Set<number>,
  maxDepth: number,
): Promise<{ callees: Omit<CalleeFact, 'code'>[]; edges: Edge[] }> {
  const known = new Map<number, Pick<SymbolRecord, 'id' | 'file' | 'name'>>(roots.map((r) => [r.symbol.id, r.symbol]));
  const depthOf = new Map<number, number>(roots.map((r) => [r.symbol.id, r.depth]));
  const live = roots.filter((r) => r.depth < maxDepth);
  const rows = (await Promise.all(live.map((r) => store.getCallees(r.symbol.id, maxDepth - r.depth)))).flat().sort((a, b) => a.depth - b.depth);
  const seen = new Set<string>();
  const callees: Omit<CalleeFact, 'code'>[] = [];
  const edges: Edge[] = [];
  for (const row of rows) {
    const key = `${row.callerId}:${row.callLine}:${row.calleeText}`;
    const callerDepth = depthOf.get(row.callerId);
    const caller = known.get(row.callerId);
    if (seen.has(key) || callerDepth === undefined || !caller || callerDepth >= maxDepth) continue;
    seen.add(key);
    if (row.callee) {
      edges.push({ from: row.callerId, to: row.callee.id, line: row.callLine });
      if (!depthOf.has(row.callee.id)) {
        depthOf.set(row.callee.id, callerDepth + 1);
        known.set(row.callee.id, row.callee);
      }
      if (ownerIds.has(row.callee.id)) continue;
    }
    callees.push({
      depth: callerDepth + 1,
      caller: { id: caller.id, file: caller.file, name: caller.name },
      callee: row.callee,
      calleeText: row.calleeText,
      callLine: row.callLine,
      resolved: row.resolved,
    });
  }
  callees.sort((a, b) => a.depth - b.depth || a.caller.file.localeCompare(b.caller.file) || a.callLine - b.callLine || a.calleeText.localeCompare(b.calleeText));
  return { callees, edges };
}

class CallGraph {
  private readonly out = new Map<number, Edge[]>();

  constructor(
    private readonly edges: Edge[],
    private readonly symbols: Map<number, SymbolRecord>,
  ) {
    for (const e of edges) this.out.set(e.from, [...(this.out.get(e.from) ?? []), e]);
    // Visit callees by line, then by name, so the path found never depends on database ids.
    const name = (id: number) => `${symbols.get(id)?.file ?? ''}#${symbols.get(id)?.name ?? ''}`;
    for (const list of this.out.values()) list.sort((a, b) => a.line - b.line || name(a.to).localeCompare(name(b.to)));
  }

  /** Shortest path of symbol ids from any of `starts` to `goal`, or null. */
  pathFrom(starts: number[], goal: number): number[] | null {
    const parent = new Map<number, number | null>();
    const queue: number[] = [];
    for (const s of starts) {
      if (!parent.has(s)) {
        parent.set(s, null);
        queue.push(s);
      }
    }
    while (queue.length > 0) {
      const n = queue.shift()!;
      if (n === goal) {
        const path: number[] = [];
        for (let x: number | null = n; x !== null; x = parent.get(x) ?? null) path.unshift(x);
        return path;
      }
      for (const e of this.out.get(n) ?? []) {
        if (!parent.has(e.to)) {
          parent.set(e.to, n);
          queue.push(e.to);
        }
      }
    }
    return null;
  }

  /** Path to `call` from code inside lines start..end of `ownerId` (an inline handler or an effect callback). */
  pathWithin(ownerId: number, start: number, end: number, call: ApiCallRecord): number[] | null {
    if (call.symbolId === ownerId && call.line >= start && call.line <= end) return [ownerId];
    const starts = this.edges.filter((e) => e.from === ownerId && e.line >= start && e.line <= end).map((e) => e.to);
    const path = this.pathFrom(starts, call.symbolId);
    return path && [ownerId, ...path];
  }

  names(path: number[]): string[] {
    return path.map((id) => this.symbols.get(id)?.name ?? `#${id}`);
  }
}

/** The handler bindings of the component and the effects of every unit from which `call` is reachable. */
function triggersOf(call: ApiCallRecord, component: ReactUnit, units: ReactUnit[], handlerTargets: SymbolRecord[], graph: CallGraph): ApiTrigger[] {
  const triggers = new Map<string, ApiTrigger>();
  const add = (t: ApiTrigger) => triggers.set(`${t.label}@${t.at}`, t);
  for (const h of component.facts.handlers) {
    const target = h.target ? handlerTargets.find((s) => sameKey(s, h.target!)) : undefined;
    const path = target ? graph.pathFrom([target.id], call.symbolId) : graph.pathWithin(component.symbol.id, h.line, h.endLine, call);
    if (path) add({ kind: 'event', label: `${h.event} on <${h.element}>`, at: `${component.symbol.file}:${h.line}`, path: graph.names(path) });
  }
  for (const u of units) {
    for (const e of u.facts.effects) {
      if (!EFFECT_TRIGGERS.has(e.hook)) continue;
      const path = graph.pathWithin(u.symbol.id, e.line, e.endLine, call);
      const deps = e.deps ? `[${e.deps.join(', ')}]` : '(every render)';
      if (path) add({ kind: 'effect', label: `${e.hook} ${deps} in ${u.symbol.name}`, at: `${u.symbol.file}:${e.line}`, path: graph.names(path) });
    }
  }
  return [...triggers.values()];
}

/** "unresolved: likely ..." for a call the indexer couldn't resolve, using what the React facts show. */
function unresolvedNote(c: Omit<CalleeFact, 'code'>, unit: ReactUnit | undefined, units: ReactUnit[]): string {
  const at = `${c.caller.file}:${c.callLine}`;
  if (unit) {
    for (const u of units) {
      for (const use of u.facts.hooks) {
        const callback = use.callee && sameKey(unit.symbol, use.callee) ? use.callbacks.find((cb) => cb.name === c.calleeText) : undefined;
        if (callback) return `unresolved: likely the \`${c.calleeText}\` callback ${u.symbol.name} passes to ${unit.symbol.name} (${u.symbol.file}:${callback.line})`;
      }
    }
    if (unit.facts.props.includes(c.calleeText)) {
      return unit.symbol.kind === 'component'
        ? `unresolved: likely the \`${c.calleeText}\` prop, supplied by whoever renders ${unit.symbol.name} (call at ${at})`
        : `unresolved: likely the \`${c.calleeText}\` argument of ${unit.symbol.name} (call at ${at})`;
    }
  }
  return `unresolved: likely ${c.calleeText} (dynamic call in ${c.caller.name} at ${at})`;
}

function innerOf(symbol: SymbolRecord, fileSymbols: SymbolRecord[]): SymbolRecord[] {
  return fileSymbols.filter((s) => s.id !== symbol.id && s.startLine >= symbol.startLine && s.endLine <= symbol.endLine && !NON_CODE_KINDS.has(s.kind));
}

function fileSymbolsLoader(store: Store): (file: string) => Promise<SymbolRecord[]> {
  const cache = new Map<string, Promise<SymbolRecord[]>>();
  return (file) => {
    if (!cache.has(file)) cache.set(file, store.getSymbolsInFile(file));
    return cache.get(file)!;
  };
}

function sameKey(s: Pick<SymbolRecord, 'file' | 'name' | 'startLine'>, k: SymbolKey): boolean {
  return s.file === k.file && s.name === k.name && s.startLine === k.startLine;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
