import type { Store } from '../store/index.js';
import type { CalleeRecord, SymbolRecord } from '../store/types.js';
import { TargetError, type FnTarget } from './target.js';
import { declarationsUsed, type DeclarationRef } from './declarations.js';
import { Budget, collectPackages, NON_CODE_KINDS, PROMPT_RESERVE_TOKENS, SourceCache } from './shared.js';

export { estimateTokens } from './shared.js';

// Selects the exact code and static facts for a `walk fn` walkthrough (CLAUDE.md §6.1, §7):
// the target block, who calls it, what it calls (to --depth), the types and module-level values
// it uses, and the packages imported by its file and by the files declaring those values. The same object is the `--no-llm` output and the LLM's only input.

export interface CodeBlock {
  file: string;
  /** First and last line shown, 1-based, inclusive. */
  start: number;
  end: number;
  lines: string[];
}

export interface CallerFact {
  symbol: SymbolRecord;
  callLine: number;
  /** A few lines around the call site, within the caller. */
  code: CodeBlock | null;
}

export interface CalleeFact {
  depth: number;
  /** The symbol whose code makes this call. */
  caller: Pick<SymbolRecord, 'id' | 'file' | 'name'>;
  /** Null for package calls and unresolved dynamic calls. */
  callee: SymbolRecord | null;
  calleeText: string;
  callLine: number;
  resolved: boolean;
  /** Body of a direct repo callee; deeper callees are listed by signature only. */
  code: CodeBlock | null;
}

export interface TypeFact {
  symbol: SymbolRecord;
  code: CodeBlock | null;
}

export interface ValueFact {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  /** The declaring statement, e.g. `export const pool = new Pool(...)`. */
  code: CodeBlock | null;
}

export interface PackageFact {
  name: string;
  version: string | null;
  importedPath: string;
  importedNames: string[];
}

export interface UnresolvedFact {
  calleeText: string;
  file: string;
  line: number;
  /** Shown to the user, e.g. "unresolved: likely handlers[name] (dynamic call at api/x.ts:12)". */
  note: string;
}

export interface FnContext {
  target: {
    file: string;
    start: number;
    end: number;
    /** The symbol the target names, or the innermost symbol enclosing a line range. */
    symbol: SymbolRecord | null;
    code: CodeBlock;
  };
  /** Symbols declared inside the target (nested functions, handlers). */
  innerSymbols: SymbolRecord[];
  callers: CallerFact[];
  callees: CalleeFact[];
  types: TypeFact[];
  /** Module-level constants and variables the target reads, e.g. `pool`, `CACHE_TTL`. */
  values: ValueFact[];
  packages: PackageFact[];
  unresolved: UnresolvedFact[];
  /** Line count of every file the context cites; the verifier's bounds. */
  files: Record<string, number>;
  /** What was left out to fit the token budget. */
  omitted: string[];
  warnings: string[];
}

export interface FnContextOptions {
  depth: number;
  maxContextTokens: number;
}

const CALLER_WINDOW = 2;

export async function buildFnContext(
  store: Store,
  repoRoot: string,
  target: FnTarget,
  options: FnContextOptions,
): Promise<FnContext> {
  const fileRecord = await store.getFile(target.file);
  if (!fileRecord) {
    throw new TargetError(`${target.file} is not in the index. Check the path (relative to the repo root) or run \`walk index\`.`);
  }

  const source = new SourceCache(repoRoot);
  const warnings: string[] = [];
  if (source.hash(target.file) !== fileRecord.hash) {
    warnings.push(`${target.file} changed since it was indexed; run \`walk index\` for accurate facts.`);
  }

  const fileSymbols = await store.getSymbolsInFile(target.file);
  const { symbol, start, end } = resolveTarget(target, fileSymbols, source.lineCount(target.file));

  // Symbols whose calls belong to the target: the enclosing symbol plus everything nested inside the range.
  const inner = fileSymbols.filter((s) => s.id !== symbol?.id && s.startLine >= start && s.endLine <= end);
  const owners = [...(symbol ? [symbol] : []), ...inner].filter((s) => !NON_CODE_KINDS.has(s.kind));

  const callees = await collectCallees(store, owners, start, end, options.depth);
  const callerSymbols = [...(symbol ? [symbol] : []), ...inner.filter((s) => s.exported)];
  const callers = (await Promise.all(callerSymbols.map((s) => store.getCallers(s.id))))
    .flat()
    .filter((c) => !(c.caller.file === target.file && c.caller.startLine >= start && c.caller.endLine <= end));

  const used = declarationsUsed(repoRoot, target.file, start, end);
  const outsideTarget = (ref: DeclarationRef) => !(ref.file === target.file && ref.line >= start && ref.line <= end);
  const typeSymbols = await resolveTypes(store, used.types.filter(outsideTarget));
  const valueRefs = used.values.filter(outsideTarget).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const packages = await collectPackages(store, [target.file, ...valueRefs.map((v) => v.file)]);

  const budget = new Budget(options.maxContextTokens - PROMPT_RESERVE_TOKENS);
  const targetCode = source.block(target.file, start, end);
  if (!budget.take(targetCode)) {
    throw new TargetError(
      `${target.file}:${start}-${end} is too large for llm.maxContextTokens (${options.maxContextTokens}); ` +
        'walk a smaller line range instead.',
    );
  }

  const omitted: string[] = [];
  const values: ValueFact[] = valueRefs.map((v) => {
    const code = source.block(v.file, v.line, v.endLine);
    const fact = { name: v.name, file: v.file, startLine: v.line, endLine: v.endLine };
    if (budget.take(code)) return { ...fact, code };
    omitted.push(`declaration of ${v.name} (${v.file}:${v.line})`);
    return { ...fact, code: null };
  });
  const types: TypeFact[] = typeSymbols.map((s) => {
    const code = source.block(s.file, s.startLine, s.endLine);
    if (budget.take(code)) return { symbol: s, code };
    omitted.push(`body of type ${s.name} (${s.file}:${s.startLine})`);
    return { symbol: s, code: null };
  });

  const calleeFacts: CalleeFact[] = callees.map((c) => {
    let code: CodeBlock | null = null;
    if (c.depth === 1 && c.callee && !NON_CODE_KINDS.has(c.callee.kind)) {
      const block = source.block(c.callee.file, c.callee.startLine, c.callee.endLine);
      if (budget.take(block)) code = block;
      else omitted.push(`body of ${c.callee.name} (${c.callee.file}:${c.callee.startLine})`);
    }
    return { ...c, code };
  });

  const callerFacts: CallerFact[] = callers.map(({ caller, callLine }) => {
    const block = source.block(
      caller.file,
      Math.max(caller.startLine, callLine - CALLER_WINDOW),
      Math.min(caller.endLine, callLine + CALLER_WINDOW),
    );
    if (budget.take(block)) return { symbol: caller, callLine, code: block };
    omitted.push(`call site in ${caller.name} (${caller.file}:${callLine})`);
    return { symbol: caller, callLine, code: null };
  });

  const unresolved = calleeFacts
    .filter((c) => !c.resolved)
    .map((c) => ({
      calleeText: c.calleeText,
      file: c.caller.file,
      line: c.callLine,
      note: `unresolved: likely ${c.calleeText} (dynamic call in ${c.caller.name} at ${c.caller.file}:${c.callLine})`,
    }));

  const cited = [
    target.file,
    ...callerFacts.map((c) => c.symbol.file),
    ...calleeFacts.flatMap((c) => [c.caller.file, ...(c.callee ? [c.callee.file] : [])]),
    ...types.map((t) => t.symbol.file),
    ...values.map((v) => v.file),
  ];
  const files = Object.fromEntries([...new Set(cited)].sort().map((f) => [f, source.lineCount(f)]));

  return {
    target: { file: target.file, start, end, symbol, code: targetCode },
    innerSymbols: inner,
    callers: callerFacts,
    callees: calleeFacts,
    types,
    values,
    packages,
    unresolved,
    files,
    omitted,
    warnings,
  };
}

function resolveTarget(
  target: FnTarget,
  fileSymbols: SymbolRecord[],
  lineCount: number,
): { symbol: SymbolRecord | null; start: number; end: number } {
  if (target.kind === 'symbol') {
    const matches = fileSymbols.filter((s) => s.name === target.name);
    if (matches.length === 0) {
      const names = fileSymbols.filter((s) => s.kind !== 'type').map((s) => s.name);
      throw new TargetError(
        `No symbol "${target.name}" in ${target.file}.` + (names.length ? ` Available: ${names.join(', ')}` : ''),
      );
    }
    if (matches.length > 1) {
      const places = matches.map((s) => `${target.file}:${s.startLine}-${s.endLine}`).join(', ');
      throw new TargetError(`"${target.name}" is ambiguous in ${target.file} (${places}); use a line range instead.`);
    }
    const [symbol] = matches;
    return { symbol, start: symbol.startLine, end: symbol.endLine };
  }

  if (target.end > lineCount) {
    throw new TargetError(`${target.file} has ${lineCount} lines; ${target.start}-${target.end} is out of bounds.`);
  }
  // Innermost symbol enclosing the whole range: the latest-starting one among those that contain it.
  const enclosing = fileSymbols
    .filter((s) => s.startLine <= target.start && s.endLine >= target.end)
    .sort((a, b) => b.startLine - a.startLine || a.endLine - b.endLine);
  return { symbol: enclosing[0] ?? null, start: target.start, end: target.end };
}

/**
 * Callees of the code between start..end, transitively to `depth`. Direct calls must sit inside
 * the range; deeper calls must be made by a callee already kept. One recursive query per owner.
 */
async function collectCallees(
  store: Store,
  owners: SymbolRecord[],
  start: number,
  end: number,
  depth: number,
): Promise<Omit<CalleeFact, 'code'>[]> {
  const ownerIds = new Set(owners.map((o) => o.id));
  const names = new Map<number, Pick<SymbolRecord, 'id' | 'file' | 'name'>>(owners.map((o) => [o.id, o]));
  const results = await Promise.all(owners.map((o) => store.getCallees(o.id, depth)));

  const kept: Omit<CalleeFact, 'code'>[] = [];
  const seen = new Set<string>();
  const reached = new Set<number>(ownerIds);

  // Rows come back ordered by depth, so a caller is always reached before its own calls.
  const rows = results.flat().sort((a, b) => a.depth - b.depth);
  for (const row of rows) {
    const inTarget = ownerIds.has(row.callerId);
    if (inTarget ? row.callLine < start || row.callLine > end : !reached.has(row.callerId)) continue;
    // Calls between symbols that are both inside the target are part of the target itself.
    if (row.callee && ownerIds.has(row.callee.id)) continue;

    const key = `${row.callerId}:${row.callLine}:${row.calleeText}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const caller = names.get(row.callerId);
    if (!caller) continue;
    if (row.callee) {
      reached.add(row.callee.id);
      names.set(row.callee.id, row.callee);
    }
    kept.push(toCallee(row, inTarget ? 1 : row.depth, caller));
  }
  return kept;
}

function toCallee(row: CalleeRecord, depth: number, caller: Pick<SymbolRecord, 'id' | 'file' | 'name'>): Omit<CalleeFact, 'code'> {
  return {
    depth,
    caller: { id: caller.id, file: caller.file, name: caller.name },
    callee: row.callee,
    calleeText: row.calleeText,
    callLine: row.callLine,
    resolved: row.resolved,
  };
}

/** The indexed type (or class) symbol enclosing each referenced declaration. */
export async function resolveTypes(store: Store, refs: DeclarationRef[]): Promise<SymbolRecord[]> {
  const byFile = new Map<string, SymbolRecord[]>();
  const found = new Map<number, SymbolRecord>();

  for (const ref of refs) {
    if (!byFile.has(ref.file)) byFile.set(ref.file, await store.getSymbolsInFile(ref.file));
    const innermost = byFile
      .get(ref.file)!
      .filter((s) => (s.kind === 'type' || s.kind === 'class') && s.startLine <= ref.line && s.endLine >= ref.line)
      .sort((a, b) => b.startLine - a.startLine)[0];
    if (innermost) found.set(innermost.id, innermost);
  }
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
}
