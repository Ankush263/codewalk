import { walkableSymbols } from '../context/order.js';
import type { Store } from '../store/index.js';
import type { SymbolRecord } from '../store/types.js';
import type { WalkthroughStep } from './fn.js';
import { hashLines, readLines, type BlockRef, type SavedWalkthrough, type Section } from './saved.js';

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
}

export interface WalkthroughStatus {
  fresh: boolean;
  sections: SectionStatus[];
  /** File walkthroughs only: functions in the file that no section explains (new, or failed last time). */
  uncovered: string[];
  /** File walkthroughs only: the file itself no longer exists. */
  fileRemoved: boolean;
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

export function checkWalkthrough(saved: SavedWalkthrough, source: CurrentSource): WalkthroughStatus {
  const sections = saved.sections.map((s) => checkSection(s, source));
  let uncovered: string[] = [];
  let fileRemoved = false;
  if (saved.scopeKind === 'file') {
    const file = source(saved.scopeRef);
    const covered = new Set(saved.sections.map((s) => s.block.symbol));
    uncovered = file ? walkableSymbols(file.symbols).map((s) => s.name).filter((name) => !covered.has(name)) : [];
    fileRemoved = file === null;
  }
  const steps = sections.flatMap((s) => s.steps);
  return {
    fresh: sections.every((s) => s.state === 'fresh') && uncovered.length === 0 && !fileRemoved,
    sections,
    uncovered,
    fileRemoved,
    staleSteps: steps.filter((s) => !s.fresh).length,
    totalSteps: steps.length,
  };
}

/** Every file whose current state decides the walkthrough's staleness. */
export function filesOf(saved: SavedWalkthrough): string[] {
  return [...new Set([...saved.sections.map((s) => s.block.file), ...(saved.scopeKind === 'file' ? [saved.scopeRef] : [])])];
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
