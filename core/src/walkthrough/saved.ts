import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FnTarget } from '../context/target.js';
import type { SymbolKind } from '../store/types.js';
import type { FnWalkthrough } from './fn.js';

// What `walk fn` and `walk file` save (CLAUDE.md §9). A saved walkthrough is a list of sections, one
// per explained code block: `walk fn` has one, `walk file` one per function. Each section keeps the
// hash of its block and of every step's lines, so staleness is decided per step.

/** Bumped when the saved shape changes; older saves are treated as never generated. */
export const SAVED_VERSION = 2;

export type ScopeKind = 'fn' | 'file';

/** The code a section explains: a named symbol (found again by name when lines move) or a fixed range. */
export interface BlockRef {
  file: string;
  /** Symbol name, or null for a `walk fn <file>:<start>-<end>` range. */
  symbol: string | null;
  start: number;
  end: number;
  /** hashLines of lines start..end when the section was generated. */
  hash: string;
}

export interface Section {
  block: BlockRef;
  /** Step id -> hashLines of the step's code_ref lines at generation time. */
  stepHashes: Record<string, string>;
  /** Content hash of every file the context cited, at generation time. */
  fileHashes: Record<string, string>;
  /** "file:line" -> text of that line, for every reference outside the block; lets reuse find it again after edits. */
  refLines: Record<string, string>;
  generatedAt: string;
  /** The LLM model that wrote this section. */
  model: string;
  /** The --depth of callees its context was built with; a different depth regenerates it. */
  depth: number;
  walkthrough: FnWalkthrough;
}

export interface SymbolSummary {
  name: string;
  kind: SymbolKind;
  line: number;
}

/** A file's role and map (CLAUDE.md §6.2 items 1-2), from the index alone; rebuilt on every run. */
export interface FileOverview {
  file: string;
  lineCount: number;
  importers: { file: string; importedNames: string[] }[];
  exports: SymbolSummary[];
  helpers: SymbolSummary[];
  /** Names of the walked functions, helpers first. */
  order: string[];
  cycleBreaks: string[];
  /** Functions with no section this run, and why. */
  failed: { symbol: string; reason: string }[];
}

export interface SavedWalkthrough {
  version: typeof SAVED_VERSION;
  scopeKind: ScopeKind;
  /** "file#symbol" or "file:start-end" for fn, "file" for file. */
  scopeRef: string;
  overview: FileOverview | null;
  sections: Section[];
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** Lines of a repo file, or null when it no longer exists. */
export function readLines(repoRoot: string, file: string): string[] | null {
  const path = join(repoRoot, file);
  return existsSync(path) ? splitLines(readFileSync(path, 'utf8')) : null;
}

/** Content hash of a repo file, or null when it no longer exists. */
export function hashFile(repoRoot: string, file: string): string | null {
  const path = join(repoRoot, file);
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

/** The current state of repo files, each read and hashed at most once per instance. */
export interface SourceFiles {
  hash(file: string): string | null;
  lines(file: string): string[] | null;
}

export function sourceFiles(repoRoot: string): SourceFiles {
  const hashes = new Map<string, string | null>();
  const lines = new Map<string, string[] | null>();
  return {
    hash: (file) => {
      if (!hashes.has(file)) hashes.set(file, hashFile(repoRoot, file));
      return hashes.get(file)!;
    },
    lines: (file) => {
      if (!lines.has(file)) lines.set(file, readLines(repoRoot, file));
      return lines.get(file)!;
    },
  };
}

/** Hash of a block's text alone: moving the block to other lines does not change it. */
export function hashLines(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** walkthroughs.content_hash: changes whenever any section's block changes. */
export function contentHashOf(sections: Section[]): string {
  const keys = sections.map((s) => `${s.block.file}#${s.block.symbol ?? `${s.block.start}-${s.block.end}`}:${s.block.hash}`);
  return createHash('sha256').update(keys.join('\n')).digest('hex');
}

export function fnScopeRef(target: FnTarget): string {
  return target.kind === 'symbol' ? `${target.file}#${target.name}` : `${target.file}:${target.start}-${target.end}`;
}

/** One walkthrough for the stepper and plain-text output: a file's sections become prefixed stages. */
export function flattenWalkthrough(saved: SavedWalkthrough): FnWalkthrough {
  if (saved.scopeKind === 'fn') return saved.sections[0].walkthrough;
  const o = saved.overview!;
  const prefix = (s: Section, id: string) => `${s.block.symbol ?? 'block'}/${id}`;
  const all = saved.sections;
  return {
    scope: { file: o.file, start: 1, end: o.lineCount, symbol: null },
    title: `How ${o.file} works`,
    summary: `${o.file} has ${o.order.length} function(s), walked helpers first.`,
    stages: all.flatMap((s) =>
      s.walkthrough.stages.map((stage) => ({
        name: `${s.block.symbol ?? 'block'} · ${stage.name}`,
        steps: stage.steps.map((step) => ({ ...step, id: prefix(s, step.id) })),
      })),
    ),
    unresolved: [...new Set(all.flatMap((s) => s.walkthrough.unresolved))],
    verification: {
      attempts: all.reduce((n, s) => n + s.walkthrough.verification.attempts, 0),
      keptSteps: all.reduce((n, s) => n + s.walkthrough.verification.keptSteps, 0),
      dropped: all.flatMap((s) => s.walkthrough.verification.dropped.map((d) => ({ ...d, stepId: prefix(s, d.stepId) }))),
      removedDocs: all.flatMap((s) => s.walkthrough.verification.removedDocs.map((d) => ({ ...d, stepId: prefix(s, d.stepId) }))),
    },
  };
}

/** The file overview as plain lines, shared by the terminal, the stepper and Markdown. */
export function overviewNotes(o: FileOverview): string[] {
  const list = (xs: SymbolSummary[]) => xs.map((s) => `${s.name} (${s.kind}, line ${s.line})`).join(', ') || 'none';
  const importers = o.importers.map((i) => (i.importedNames.length ? `${i.file} (${i.importedNames.join(', ')})` : i.file));
  return [
    `Imported by: ${importers.join('; ') || 'no indexed file'}`,
    `Exports: ${list(o.exports)}`,
    `Internal helpers: ${list(o.helpers)}`,
    `Walk order (helpers first): ${o.order.join(' → ') || 'no functions'}`,
    ...o.cycleBreaks.map((c) => `Cycle: ${c}`),
    ...o.failed.map((f) => `Not explained: ${f.symbol}: ${f.reason}`),
  ];
}
