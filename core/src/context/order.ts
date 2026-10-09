import type { CallEdge, SymbolRecord } from '../store/types.js';

// The order `walk file` explains a file's functions in (CLAUDE.md §6.2): helpers first, entry
// points last. Pure functions over the index facts, so they are tested without a database.

type Span = Pick<SymbolRecord, 'kind' | 'startLine' | 'endLine'>;

const NOT_WALKED = new Set(['type', 'class']);

/**
 * The functions a file walkthrough explains: code symbols that aren't nested inside another code
 * symbol (nested ones, like a component's handlers, are covered by their parent), in source order.
 */
export function walkableSymbols<T extends Span>(symbols: T[]): T[] {
  const code = symbols.filter((s) => !NOT_WALKED.has(s.kind));
  const nested = (s: T) =>
    code.some(
      (o) => o !== s && o.startLine <= s.startLine && o.endLine >= s.endLine && (o.startLine < s.startLine || o.endLine > s.endLine),
    );
  return code.filter((s) => !nested(s)).sort((a, b) => a.startLine - b.startLine);
}

/**
 * Orders `walkable` so each function comes after every function it calls, ties in source order.
 * Calls made by nested symbols (anything in `all`) count for the walkable symbol containing them.
 * Functions that call each other (a cycle) are walked together, in source order, after everything
 * the cycle calls; each such cycle is noted in `cycleBreaks`.
 */
export function dependencyOrder<T extends Pick<SymbolRecord, 'id' | 'name' | 'startLine' | 'endLine'>>(
  walkable: T[],
  all: Pick<SymbolRecord, 'id' | 'startLine' | 'endLine'>[],
  edges: CallEdge[],
): { order: T[]; cycleBreaks: string[] } {
  const byId = new Map(all.map((s) => [s.id, s]));
  const ownerOf = (id: number): T | undefined => {
    const s = byId.get(id);
    return s && walkable.find((w) => w.startLine <= s.startLine && w.endLine >= s.endLine);
  };

  const bySource = [...walkable].sort((a, b) => a.startLine - b.startLine);
  const callees = new Map<T, Set<T>>(bySource.map((w) => [w, new Set<T>()]));
  for (const e of edges) {
    const from = ownerOf(e.callerId);
    const to = ownerOf(e.calleeId);
    if (from && to && from !== to) callees.get(from)!.add(to);
  }

  // Each group is a single function or a cycle; the groups' call graph has no cycles.
  const groups = stronglyConnected(bySource, callees);
  const groupOf = new Map<T, number>();
  groups.forEach((members, i) => members.forEach((m) => groupOf.set(m, i)));
  const needs = groups.map((members, i) => new Set(members.flatMap((m) => [...callees.get(m)!].map((c) => groupOf.get(c)!)).filter((j) => j !== i)));

  const done = new Set<number>();
  const order: T[] = [];
  const cycleBreaks: string[] = [];
  while (done.size < groups.length) {
    const next = groups
      .map((_, i) => i)
      .filter((i) => !done.has(i) && [...needs[i]].every((j) => done.has(j)))
      .sort((i, j) => groups[i][0].startLine - groups[j][0].startLine)[0];
    done.add(next);
    order.push(...groups[next]);
    if (groups[next].length > 1) cycleBreaks.push(`${listNames(groups[next].map((m) => m.name))} call each other; walked in source order`);
  }
  return { order, cycleBreaks };
}

/** Tarjan's strongly connected components; each component in source order. */
function stronglyConnected<T extends { startLine: number }>(nodes: T[], callees: Map<T, Set<T>>): T[][] {
  const index = new Map<T, number>();
  const low = new Map<T, number>();
  const stack: T[] = [];
  const onStack = new Set<T>();
  const groups: T[][] = [];

  const visit = (v: T) => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    onStack.add(v);
    for (const w of callees.get(v)!) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const group: T[] = [];
      let w: T;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      groups.push(group.sort((a, b) => a.startLine - b.startLine));
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return groups;
}

/** "a", "a and b", "a, b and c". */
function listNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
