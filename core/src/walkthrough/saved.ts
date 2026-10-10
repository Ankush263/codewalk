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

export type ScopeKind = 'fn' | 'file' | 'endpoint' | 'component' | 'trace';

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
  /** Endpoint and component sections: every code block sent to the LLM, `block` first. */
  blocks?: BlockRef[];
  /** Endpoint sections: chainHashOf the route; component sections: structureHashOf the component. */
  chainHash?: string;
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

/** An endpoint's route facts (CLAUDE.md §6.3), from the index alone; rebuilt on every run. */
export interface EndpointOverview {
  method: string;
  path: string;
  mounts: { file: string; line: number; prefix: string }[];
  chain: { phase: string; label: string; at: string }[];
  errorHandlers: { phase: string; label: string; at: string }[];
  sideEffects: { symbol: string; kind: string; detail: string; at: string }[];
  errorPaths: { symbol: string; error: string; status: number | null; at: string }[];
  warnings: string[];
  /** Mermaid sequenceDiagram source. */
  diagram: string;
}

/** A component's React facts (CLAUDE.md §6.4), from the index alone; rebuilt on every run. */
export interface ComponentOverview {
  file: string;
  name: string;
  propsType: string | null;
  props: string[];
  state: { name: string; setter: string | null; hook: string; initial: string | null; at: string }[];
  context: { context: string; at: string }[];
  /** Hooks the component calls directly. */
  hooks: { name: string; package: string | null; expanded: boolean; at: string }[];
  children: { element: string; condition: string | null; props: string[]; at: string }[];
  handlers: { event: string; element: string; handler: string; at: string }[];
  /** Effects of the component and of every expanded hook. */
  effects: { hook: string; deps: string[] | null; owner: string; at: string }[];
  apiCalls: { method: string; urlPattern: string; at: string; triggers: string[] }[];
  limits: string[];
  warnings: string[];
}

/** A full-stack trace's facts (CLAUDE.md §6.5), from the index alone; rebuilt on every run. */
export interface TraceOverview {
  method: string;
  path: string;
  /** "file#Component" that triggers the call. */
  component: string;
  /** describeTrigger of the first trigger, or a note that none was found. */
  trigger: string;
  /** "POST /api/patients/enroll in useEnrollMutation.mutate (web/hooks/useEnrollMutation.ts:19)". */
  call: string;
  /** describeLink: how the call was matched to the route. */
  link: string;
  /** Labels of the route's middleware chain and handler. */
  chain: string[];
  /** Calls made after the response, in order, each once. */
  afterResponse: string[];
  warnings: string[];
  /** Mermaid sequenceDiagram source. */
  diagram: string;
}

export interface SavedWalkthrough {
  version: typeof SAVED_VERSION;
  scopeKind: ScopeKind;
  /** "file#symbol" or "file:start-end" for fn, "file" for file, "METHOD /path" for endpoint, "file#Component" for component, "METHOD /path <- file#Component" for trace. */
  scopeRef: string;
  overview: FileOverview | null;
  /** Endpoint walkthroughs only. */
  endpoint?: EndpointOverview;
  /** Component walkthroughs only. */
  component?: ComponentOverview;
  /** Trace walkthroughs only. */
  trace?: TraceOverview;
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
  const keys = sections.flatMap((s) => (s.blocks ?? [s.block]).map((b) => `${b.file}#${b.symbol ?? `${b.start}-${b.end}`}:${b.hash}`));
  return createHash('sha256').update(keys.join('\n')).digest('hex');
}

export function fnScopeRef(target: FnTarget): string {
  return target.kind === 'symbol' ? `${target.file}#${target.name}` : `${target.file}:${target.start}-${target.end}`;
}

/** One walkthrough for the stepper and plain-text output: a file's sections become prefixed stages. */
export function flattenWalkthrough(saved: SavedWalkthrough): FnWalkthrough {
  if (saved.scopeKind !== 'file') return saved.sections[0].walkthrough;
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

/** The endpoint overview as plain lines, shared by the terminal, the stepper and Markdown. */
export function endpointNotes(o: EndpointOverview): string[] {
  return [
    `Route: ${o.method} ${o.path}`,
    `Mounted via: ${o.mounts.map((m) => `${m.prefix} (${m.file}:${m.line})`).join(' → ') || 'directly on the app'}`,
    `Middleware chain: ${o.chain.map((n) => `${n.label} [${n.phase}]`).join(' → ')}`,
    `Error handlers: ${o.errorHandlers.map((n) => `${n.label} (${n.at})`).join(', ') || 'none (Express default)'}`,
    ...o.sideEffects.map((e) => `Side effect: ${e.kind} ${e.detail} in ${e.symbol} (${e.at})`),
    ...o.errorPaths.map((p) => `Can fail: ${p.error}${p.status !== null ? ` → ${p.status}` : ''} in ${p.symbol} (${p.at})`),
    ...o.warnings.map((w) => `Warning: ${w}`),
  ];
}

/** The component overview as plain lines, shared by the terminal, the stepper and Markdown. */
export function componentNotes(o: ComponentOverview): string[] {
  const hook = (h: ComponentOverview['hooks'][number]) => `${h.name} (${h.expanded ? 'expanded' : (h.package ?? 'not expanded')})`;
  return [
    `Component: ${o.name} (${o.file})`,
    `Props: ${o.props.join(', ') || 'none'}${o.propsType ? ` — ${o.propsType}` : ''}`,
    ...o.state.map((s) => `State: ${s.name}${s.setter ? ` / ${s.setter}` : ''} (${s.hook}${s.initial !== null ? `, initially ${s.initial}` : ''}) at ${s.at}`),
    ...o.context.map((x) => `Context: ${x.context} at ${x.at}`),
    `Hooks: ${o.hooks.map(hook).join(', ') || 'none'}`,
    ...o.children.map((c) => `Renders: <${c.element}>${c.condition ? ` when ${c.condition}` : ''}${c.props.length ? ` with ${c.props.join(', ')}` : ''} at ${c.at}`),
    ...o.handlers.map((h) => `Handler: ${h.event} on <${h.element}> → ${h.handler} at ${h.at}`),
    ...o.effects.map((e) => `Effect: ${e.hook} ${e.deps ? `[${e.deps.join(', ')}]` : '(every render)'} in ${e.owner} at ${e.at}`),
    ...o.apiCalls.map((a) => `API call: ${a.method} ${a.urlPattern} at ${a.at}${a.triggers.length ? ` ← ${a.triggers.join('; ')}` : ' (no trigger found in this component)'}`),
    ...o.limits.map((l) => `Not expanded: ${l}`),
    ...o.warnings.map((w) => `Warning: ${w}`),
  ];
}

/** The trace overview as plain lines, shared by the terminal, the stepper and Markdown. */
export function traceNotes(o: TraceOverview): string[] {
  return [
    `Trace: ${o.component} → ${o.method} ${o.path}`,
    `Trigger: ${o.trigger}`,
    `API call: ${o.call} — ${o.link}`,
    `Server: ${o.chain.join(' → ')}`,
    `After the response: ${o.afterResponse.join(', ') || 'nothing in the calling function'}`,
    ...o.warnings.map((w) => `Warning: ${w}`),
  ];
}

/** The scope's overview as plain lines (file, endpoint, component or trace facts); none for `walk fn`. */
export function walkthroughNotes(saved: SavedWalkthrough): string[] {
  if (saved.overview) return overviewNotes(saved.overview);
  if (saved.endpoint) return endpointNotes(saved.endpoint);
  if (saved.component) return componentNotes(saved.component);
  if (saved.trace) return traceNotes(saved.trace);
  return [];
}

/** Each step's saved hash and the time its section was explained, by flattened step id ("<symbol>/<id>" in a file walkthrough). */
export function explainedSteps(saved: SavedWalkthrough): Map<string, { hash: string; generatedAt: string }> {
  const steps = new Map<string, { hash: string; generatedAt: string }>();
  for (const section of saved.sections) {
    for (const [id, hash] of Object.entries(section.stepHashes)) {
      steps.set(saved.scopeKind === 'file' ? `${section.block.symbol ?? 'block'}/${id}` : id, { hash, generatedAt: section.generatedAt });
    }
  }
  return steps;
}

/** True when the step's lines or its explanation changed after the question was answered. */
export function questionOutdated(steps: Map<string, { hash: string; generatedAt: string }>, q: { stepId: string; stepHash: string; createdAt: Date }): boolean {
  const step = steps.get(q.stepId);
  return !step || step.hash !== q.stepHash || q.createdAt.getTime() < Date.parse(step.generatedAt);
}
