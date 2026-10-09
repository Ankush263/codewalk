import type { FnContext } from '../context/fn.js';
import type { LlmProvider } from '../llm/generate.js';
import type { Reference } from '../llm/schema.js';
import { explainFn } from './fn.js';
import { hashLines, sourceFiles, type Section, type SourceFiles } from './saved.js';

/**
 * Explains ctx's target and records what staleness checks need. `symbol` names the block so it can
 * be found again after its lines move; null pins it to the exact range (`walk fn file:a-b`).
 */
export async function generateSection(
  provider: LlmProvider,
  ctx: FnContext,
  repoRoot: string,
  options: { symbol: string | null; model: string; depth: number; condensed?: boolean },
): Promise<Section> {
  const walkthrough = await explainFn(provider, ctx, repoRoot, { condensed: options.condensed });
  const files = sourceFiles(repoRoot);
  const lines = (file: string) => files.lines(file) ?? [];
  const steps = walkthrough.stages.flatMap((s) => s.steps);
  const { target } = ctx;
  const refLines: Record<string, string> = {};
  for (const r of steps.flatMap((s) => s.references)) {
    const text = lines(r.file)[r.line - 1];
    if (text !== undefined) refLines[`${r.file}:${r.line}`] = text;
  }
  return {
    block: { file: target.file, symbol: options.symbol, start: target.start, end: target.end, hash: hashLines(target.code.lines) },
    stepHashes: Object.fromEntries(steps.map((s) => [s.id, hashLines(lines(s.code_ref.file).slice(s.code_ref.start - 1, s.code_ref.end))])),
    fileHashes: Object.fromEntries(Object.keys(ctx.files).map((f) => [f, files.hash(f) ?? ''])),
    refLines,
    generatedAt: new Date().toISOString(),
    model: options.model,
    depth: options.depth,
    walkthrough,
  };
}

/**
 * The saved section moved to where its block is now, or null when it must be regenerated (the
 * block's text changed, a step cites code outside the block, or it was built with another --depth). Lines inside the block shift with
 * it. A reference elsewhere stays as is when its file is unchanged; otherwise it moves to the
 * nearest line with exactly its old text, and is dropped (with a note) when that text is gone.
 */
export function reuseSection(
  prev: Section,
  current: { start: number; end: number; lines: string[] },
  files: SourceFiles,
  depth: number,
): Section | null {
  if (prev.depth !== depth || hashLines(current.lines) !== prev.block.hash) return null;
  const { file, start: oldStart, end: oldEnd } = prev.block;
  const inBlock = (f: string, line: number) => f === file && line >= oldStart && line <= oldEnd;
  const w = prev.walkthrough;
  const steps = w.stages.flatMap((s) => s.steps);
  if (steps.some((s) => !inBlock(s.code_ref.file, s.code_ref.start) || !inBlock(s.code_ref.file, s.code_ref.end))) return null;

  const delta = current.start - oldStart;
  const refLines: Record<string, string> = {};
  const dropped: string[] = [];
  const relocate = (r: Reference): Reference[] => {
    const text = prev.refLines[`${r.file}:${r.line}`];
    const line = inBlock(r.file, r.line) ? r.line + delta : files.hash(r.file) === prev.fileHashes[r.file] ? r.line : findLine(files.lines(r.file), text, r.line);
    if (line === null) {
      dropped.push(`${r.file}:${r.line}`);
      return [];
    }
    if (text !== undefined) refLines[`${r.file}:${line}`] = text;
    return [{ ...r, line }];
  };

  const stages = w.stages.map((stage) => ({
    ...stage,
    steps: stage.steps.map((step) => ({
      ...step,
      code_ref: { ...step.code_ref, start: step.code_ref.start + delta, end: step.code_ref.end + delta },
      references: step.references.flatMap(relocate),
    })),
  }));
  const note = dropped.length
    ? [`${dropped.length} reference${dropped.length === 1 ? '' : 's'} dropped because the code ${dropped.length === 1 ? 'it' : 'they'} pointed to changed: ${dropped.join(', ')}`]
    : [];
  return {
    ...prev,
    block: { ...prev.block, start: current.start, end: current.end },
    fileHashes: Object.fromEntries(Object.keys(prev.fileHashes).map((f) => [f, files.hash(f) ?? ''])),
    refLines,
    walkthrough: { ...w, scope: { ...w.scope, start: current.start, end: current.end }, stages, unresolved: [...w.unresolved, ...note] },
  };
}

/** The line holding exactly `text` nearest to `near`; null if gone. Lines without an identifier ("}") are too ambiguous to match. */
function findLine(lines: string[] | null, text: string | undefined, near: number): number | null {
  if (!lines || text === undefined || !/[A-Za-z_$]/.test(text)) return null;
  let best: number | null = null;
  lines.forEach((l, i) => {
    if (l === text && (best === null || Math.abs(i + 1 - near) < Math.abs(best - near))) best = i + 1;
  });
  return best;
}
