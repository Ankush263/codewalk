import type { EndpointContext, EndpointNode } from '../context/endpoint.js';
import type { CodeBlock } from '../context/fn.js';
import { ENDPOINT_SYSTEM_PROMPT, renderEndpointPrompt } from '../llm/endpointPrompt.js';
import type { LlmProvider } from '../llm/generate.js';
import type { Reference } from '../llm/schema.js';
import { endpointDiagram } from '../render/mermaid.js';
import { endpointVerifyFacts } from '../verify/verify.js';
import { explainGrounded } from './explain.js';
import type { FnWalkthrough } from './fn.js';
import { hashLines, type BlockRef, type EndpointOverview, type Section, type SourceFiles } from './saved.js';
import { droppedNote, findLine, recordSection } from './section.js';

// `walk endpoint` after the facts are gathered: LLM -> verifier -> docs links (CLAUDE.md §6.3, §8.3).

export async function explainEndpoint(provider: LlmProvider, ctx: EndpointContext, repoRoot: string): Promise<FnWalkthrough> {
  const handler = ctx.chain.at(-1)!;
  return explainGrounded(
    provider,
    {
      system: ENDPOINT_SYSTEM_PROMPT,
      prompt: renderEndpointPrompt(ctx),
      facts: endpointVerifyFacts(ctx),
      packages: ctx.packages,
      unresolved: ctx.unresolved.map((u) => u.note),
      scope: {
        file: handler.symbol?.file ?? handler.registeredAt.file,
        start: handler.symbol?.startLine ?? handler.registeredAt.line,
        end: handler.symbol?.endLine ?? handler.registeredAt.endLine,
        symbol: ctx.scopeRef,
      },
    },
    repoRoot,
  );
}

/** The blocks an endpoint walkthrough explains: the handler first, then chain, error handlers, callees, registrations. */
export function endpointBlocks(ctx: EndpointContext): BlockRef[] {
  const blocks = new Map<string, BlockRef>();
  const add = (symbol: string | null, code: CodeBlock | null) => {
    if (!code) return;
    const key = `${code.file}:${code.start}-${code.end}`;
    if (!blocks.has(key)) blocks.set(key, { file: code.file, symbol, start: code.start, end: code.end, hash: hashLines(code.lines) });
  };
  const handler = ctx.chain.at(-1)!;
  add(handler.symbol?.name ?? null, handler.code);
  for (const n of [...ctx.chain, ...ctx.errorHandlers]) add(n.symbol?.name ?? null, n.code);
  for (const c of ctx.callees) add(c.callee?.name ?? null, c.code);
  // Registration lines aren't a symbol: they are pinned to their range.
  for (const r of ctx.registrations) add(null, r);
  return [...blocks.values()];
}

export async function generateEndpointSection(
  provider: LlmProvider,
  ctx: EndpointContext,
  repoRoot: string,
  options: { model: string; depth: number },
): Promise<Section> {
  const walkthrough = await explainEndpoint(provider, ctx, repoRoot);
  const blocks = endpointBlocks(ctx);
  return { ...recordSection(walkthrough, blocks[0], Object.keys(ctx.files), repoRoot, options), blocks, chainHash: ctx.chainHash };
}

/**
 * The saved endpoint or component section moved to where its blocks are now, or null when it must be regenerated:
 * the chain or --depth changed, a block was added, removed or edited, or a step cites code outside every
 * block. Steps and references move with their block; other references follow reuseSection's rules.
 */
export function reuseMultiBlockSection(prev: Section, current: { blocks: BlockRef[]; chainHash: string }, files: SourceFiles, depth: number): Section | null {
  if (!prev.blocks || prev.depth !== depth || prev.chainHash !== current.chainHash || prev.blocks.length !== current.blocks.length) return null;
  const moved: { from: BlockRef; to: BlockRef }[] = [];
  for (const from of prev.blocks) {
    // Symbol blocks are found by name; registration lines (no symbol) by their text, nearest to where they were.
    const to = current.blocks
      .filter((c) => c.file === from.file && c.symbol === from.symbol && c.hash === from.hash)
      .sort((a, b) => Math.abs(a.start - from.start) - Math.abs(b.start - from.start))[0];
    if (!to) return null;
    moved.push({ from, to });
  }
  const ownerOf = (file: string, start: number, end: number) => moved.find(({ from }) => from.file === file && start >= from.start && end <= from.end);
  const w = prev.walkthrough;
  if (w.stages.some((s) => s.steps.some((st) => !ownerOf(st.code_ref.file, st.code_ref.start, st.code_ref.end)))) return null;

  const dropped: string[] = [];
  const refLines: Record<string, string> = {};
  const relocate = (r: Reference): Reference[] => {
    const owner = ownerOf(r.file, r.line, r.line);
    const text = prev.refLines[`${r.file}:${r.line}`];
    const line = owner
      ? r.line + owner.to.start - owner.from.start
      : files.hash(r.file) === prev.fileHashes[r.file]
        ? r.line
        : findLine(files.lines(r.file), text, r.line);
    if (line === null) {
      dropped.push(`${r.file}:${r.line}`);
      return [];
    }
    if (text !== undefined) refLines[`${r.file}:${line}`] = text;
    return [{ ...r, line }];
  };

  const stages = w.stages.map((stage) => ({
    ...stage,
    steps: stage.steps.map((step) => {
      const owner = ownerOf(step.code_ref.file, step.code_ref.start, step.code_ref.end)!;
      const delta = owner.to.start - owner.from.start;
      return { ...step, code_ref: { ...step.code_ref, start: step.code_ref.start + delta, end: step.code_ref.end + delta }, references: step.references.flatMap(relocate) };
    }),
  }));
  const head = moved[0];
  const headDelta = head.to.start - head.from.start;
  return {
    ...prev,
    block: head.to,
    blocks: moved.map((m) => m.to),
    fileHashes: Object.fromEntries(Object.keys(prev.fileHashes).map((f) => [f, files.hash(f) ?? ''])),
    refLines,
    walkthrough: {
      ...w,
      scope: { ...w.scope, start: w.scope.start + headDelta, end: w.scope.end + headDelta },
      stages,
      unresolved: [...w.unresolved, ...droppedNote(dropped)],
    },
  };
}

export function endpointOverviewOf(ctx: EndpointContext): EndpointOverview {
  const at = (n: EndpointNode) => (n.symbol ? `${n.symbol.file}:${n.symbol.startLine}` : `${n.registeredAt.file}:${n.registeredAt.line}`);
  const node = (n: EndpointNode) => ({ phase: n.phase, label: n.label, at: at(n) });
  return {
    method: ctx.route.method,
    path: ctx.route.fullPath,
    mounts: ctx.route.mounts.map((m) => ({ file: m.file, line: m.line, prefix: m.prefix })),
    chain: ctx.chain.map(node),
    errorHandlers: ctx.errorHandlers.map(node),
    sideEffects: ctx.sideEffects.map((e) => ({ symbol: e.symbol.name, kind: e.kind, detail: e.detail, at: `${e.symbol.file}:${e.line}` })),
    errorPaths: ctx.errorPaths.map((p) => ({ symbol: p.symbol.name, error: p.error, status: p.status, at: `${p.symbol.file}:${p.line}` })),
    warnings: ctx.warnings,
    diagram: endpointDiagram(ctx),
  };
}
