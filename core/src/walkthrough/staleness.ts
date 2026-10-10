import { walkableSymbols } from '../context/order.js';
import type { Store } from '../store/index.js';
import type { SymbolRecord } from '../store/types.js';
import type { WalkthroughStep } from './fn.js';
import { hashLines, readLines, type BlockRef, type SavedWalkthrough, type ScopeKind, type Section } from './saved.js';

// Staleness (CLAUDE.md §9). A section is fresh when its block's text is unchanged, wherever it now
// sits. When the block changed, each step stays fresh if its exact lines still appear in the block,
// so editing one function marks only the steps whose code changed.

export interface CurrentFile {
  lines: string[];
  symbols: Pick<SymbolRecord, 'name' | 'kind' | 'startLine' | 'endLine'>[];
}

/** The current lines and indexed symbols of a file; null when it no longer exists. */
export type CurrentSource = (file: string) => CurrentFile | null;

export interface StepStatus {
  stepId: string;
  fresh: boolean;
  /** Where the step's lines are now (fresh) or were when generated (stale). */
  file: string;
  start: number;
  end: number;
}

export type SectionState = 'fresh' | 'changed' | 'missing';

export interface SectionStatus {
  symbol: string | null;
  file: string;
  state: SectionState;
  /** Where the block is now; null when it can't be found. */
  current: { start: number; end: number } | null;
  steps: StepStatus[];
  /** Endpoint sections: blocks whose code changed or is gone, by symbol (or file:line for registrations). */
  changedBlocks?: string[];
}

export interface WalkthroughStatus {
  fresh: boolean;
  sections: SectionStatus[];
  /** File walkthroughs only: functions in the file that no section explains (new, or failed last time). */
  uncovered: string[];
  /** File walkthroughs only: the file itself no longer exists. */
  fileRemoved: boolean;
  /** Endpoint: the middleware chain resolves differently now. Component: its hooks, children, handlers or API calls changed. Trace: the component, chain or link changed. */
  chainChanged: boolean;
  /** Endpoint: the route is gone. Component: the component is gone. Trace: the route, component or link is gone. */
  routeRemoved: boolean;
  staleSteps: number;
  totalSteps: number;
}

/** Where the block is now: by symbol name (nearest to its old line if repeated), or the same range. */
export function locateBlock(block: BlockRef, file: CurrentFile): { start: number; end: number } | null {
  if (block.symbol === null) return block.end <= file.lines.length ? { start: block.start, end: block.end } : null;
  const matches = file.symbols.filter((s) => s.name === block.symbol);
  if (matches.length === 0) return null;
  const best = matches.reduce((a, b) => (Math.abs(b.startLine - block.start) < Math.abs(a.startLine - block.start) ? b : a));
  return { start: best.startLine, end: best.endLine };
}

export function checkSection(section: Section, source: CurrentSource): SectionStatus {
  if (section.blocks) return checkBlocks(section, section.blocks, source);
  const { block } = section;
  const steps = section.walkthrough.stages.flatMap((s) => s.steps);
  const base = { symbol: block.symbol, file: block.file };
  const file = source(block.file);
  const at = file && locateBlock(block, file);
  if (!file || !at) return { ...base, state: 'missing', current: null, steps: steps.map((s) => stepAt(s, false, s.code_ref.start)) };

  const delta = at.start - block.start;
  if (hashLines(file.lines.slice(at.start - 1, at.end)) === block.hash) {
    // A step citing code outside its block can't be carried along with it (reuseSection regenerates
    // such a section), so it is stale even though the block itself is unchanged.
    const inBlock = (s: WalkthroughStep) => s.code_ref.file === block.file && s.code_ref.start >= block.start && s.code_ref.end <= block.end;
    const status = steps.map((s) => (inBlock(s) ? stepAt(s, true, s.code_ref.start + delta) : stepAt(s, false, s.code_ref.start)));
    return { ...base, state: status.every((s) => s.fresh) ? 'fresh' : 'changed', current: at, steps: status };
  }
  return {
    ...base,
    state: 'changed',
    current: at,
    steps: steps.map((s) => findStep(s, section.stepHashes[s.id], file.lines, at, s.code_ref.start + delta)),
  };
}

/** An endpoint section: fresh when every block is unchanged; each step is judged within the block that holds it. */
function checkBlocks(section: Section, blocks: BlockRef[], source: CurrentSource): SectionStatus {
  const steps = section.walkthrough.stages.flatMap((s) => s.steps);
  const located = blocks.map((b) => {
    const file = source(b.file);
    // Registration lines have no symbol: follow their exact text when lines above them moved.
    const at = file && ((b.symbol === null && findText(b, file.lines)) || locateBlock(b, file));
    const same = Boolean(file && at && hashLines(file.lines.slice(at.start - 1, at.end)) === b.hash);
    return { b, file, at, same };
  });
  const base = { symbol: section.block.symbol, file: section.block.file };
  const changedBlocks = located.filter((l) => !l.same).map((l) => l.b.symbol ?? `${l.b.file}:${l.b.start}`);
  const head = located[0];
  if (!head?.file || !head.at) {
    return { ...base, state: 'missing', current: null, steps: steps.map((s) => stepAt(s, false, s.code_ref.start)), changedBlocks };
  }
  const status = steps.map((s) => {
    const owner = located.find(({ b }) => b.file === s.code_ref.file && s.code_ref.start >= b.start && s.code_ref.end <= b.end);
    if (!owner?.file || !owner.at) return stepAt(s, false, s.code_ref.start);
    const expected = s.code_ref.start + owner.at.start - owner.b.start;
    return owner.same ? stepAt(s, true, expected) : findStep(s, section.stepHashes[s.id], owner.file.lines, owner.at, expected);
  });
  const fresh = changedBlocks.length === 0 && status.every((s) => s.fresh);
  return { ...base, state: fresh ? 'fresh' : 'changed', current: head.at, steps: status, changedBlocks };
}

/** Where a block's exact lines are now, nearest to where they were; null if its text is gone. */
function findText(block: BlockRef, lines: string[]): { start: number; end: number } | null {
  const length = block.end - block.start + 1;
  let best: number | null = null;
  for (let start = 1; start + length - 1 <= lines.length; start++) {
    if (hashLines(lines.slice(start - 1, start - 1 + length)) !== block.hash) continue;
    if (best === null || Math.abs(start - block.start) < Math.abs(best - block.start)) best = start;
  }
  return best === null ? null : { start: best, end: best + length - 1 };
}

/**
 * `chains` gives the current chain hash of an endpoint scope or structure hash of a component scope
 * (null: gone). Without it, endpoint and component walkthroughs are judged by their code alone.
 */
export function checkWalkthrough(saved: SavedWalkthrough, source: CurrentSource, chains?: (scopeRef: string) => string | null | undefined): WalkthroughStatus {
  const sections = saved.sections.map((s) => checkSection(s, source));
  let uncovered: string[] = [];
  let fileRemoved = false;
  if (saved.scopeKind === 'file') {
    const file = source(saved.scopeRef);
    const covered = new Set(saved.sections.map((s) => s.block.symbol));
    uncovered = file ? walkableSymbols(file.symbols).map((s) => s.name).filter((name) => !covered.has(name)) : [];
    fileRemoved = file === null;
  }
  const structural = saved.scopeKind === 'endpoint' || saved.scopeKind === 'component' || saved.scopeKind === 'trace';
  const chain = structural && chains ? chains(saved.scopeRef) : undefined;
  const routeRemoved = chain === null;
  const chainChanged = typeof chain === 'string' && chain !== saved.sections[0]?.chainHash;
  const steps = sections.flatMap((s) => s.steps);
  return {
    fresh: sections.every((s) => s.state === 'fresh') && uncovered.length === 0 && !fileRemoved && !chainChanged && !routeRemoved,
    sections,
    uncovered,
    fileRemoved,
    chainChanged,
    routeRemoved,
    staleSteps: steps.filter((s) => !s.fresh).length,
    totalSteps: steps.length,
  };
}

/** Every file whose current state decides the walkthrough's staleness. */
export function filesOf(saved: SavedWalkthrough): string[] {
  return [...new Set([...saved.sections.flatMap((s) => (s.blocks ?? [s.block]).map((b) => b.file)), ...(saved.scopeKind === 'file' ? [saved.scopeRef] : [])])];
}

/** Reads each file once, with its indexed symbols (the index must be current). */
export async function loadCurrentSource(store: Store, repoRoot: string, files: string[]): Promise<CurrentSource> {
  const loaded = new Map<string, CurrentFile | null>();
  for (const file of new Set(files)) {
    const lines = readLines(repoRoot, file);
    loaded.set(file, lines && { lines, symbols: await store.getSymbolsInFile(file) });
  }
  return (file) => loaded.get(file) ?? null;
}

function stepAt(step: WalkthroughStep, fresh: boolean, start: number): StepStatus {
  return { stepId: step.id, fresh, file: step.code_ref.file, start, end: start + (step.code_ref.end - step.code_ref.start) };
}

/** The occurrence of the step's exact lines inside the block nearest to where it is expected. */
function findStep(step: WalkthroughStep, hash: string | undefined, lines: string[], at: { start: number; end: number }, expected: number): StepStatus {
  const length = step.code_ref.end - step.code_ref.start + 1;
  let best: number | null = null;
  if (hash !== undefined) {
    for (let start = at.start; start + length - 1 <= at.end; start++) {
      if (hashLines(lines.slice(start - 1, start - 1 + length)) !== hash) continue;
      if (best === null || Math.abs(start - expected) < Math.abs(best - expected)) best = start;
    }
  }
  return best === null ? stepAt(step, false, step.code_ref.start) : stepAt(step, true, best);
}

/** One line describing why a walkthrough is stale, e.g. "1/9 steps stale · changed: insertConsent". */
export function describeStaleness(kind: ScopeKind, s: WalkthroughStatus): string {
  const label = (x: WalkthroughStatus['sections'][number]) => x.symbol ?? `${x.file} lines`;
  const changed = s.sections.filter((x) => x.state === 'changed').flatMap((x) => (x.changedBlocks?.length ? x.changedBlocks : [label(x)]));
  const removed = s.sections.filter((x) => x.state === 'missing').map(label);
  const parts = [`${s.staleSteps}/${s.totalSteps} steps stale`];
  if (s.fileRemoved) parts.push('file removed');
  if (s.routeRemoved) parts.push(kind === 'component' ? 'component removed' : kind === 'trace' ? 'trace removed' : 'route removed');
  if (s.chainChanged) parts.push(kind === 'component' ? 'structure changed' : kind === 'trace' ? 'trace changed' : 'middleware chain changed');
  if (changed.length) parts.push(`changed: ${changed.join(', ')}`);
  if (removed.length) parts.push(`removed: ${removed.join(', ')}`);
  if (s.uncovered.length) parts.push(`not covered: ${s.uncovered.join(', ')}`);
  return parts.join(' · ');
}
