import { describeTrigger } from '../context/component.js';
import { describeLink, type TraceContext } from '../context/trace.js';
import type { LlmProvider } from '../llm/generate.js';
import { renderTracePrompt, TRACE_SYSTEM_PROMPT } from '../llm/tracePrompt.js';
import { traceDiagram } from '../render/mermaid.js';
import { traceVerifyFacts } from '../verify/verify.js';
import { componentBlocks } from './component.js';
import { endpointBlocks } from './endpoint.js';
import { explainGrounded } from './explain.js';
import type { FnWalkthrough } from './fn.js';
import type { BlockRef, Section, TraceOverview } from './saved.js';
import { recordSection } from './section.js';

// `walk trace` after the facts are gathered: LLM -> verifier -> docs links (CLAUDE.md §6.5, §8.3).

export async function explainTrace(provider: LlmProvider, ctx: TraceContext, repoRoot: string): Promise<FnWalkthrough> {
  const s = ctx.component.component.symbol;
  return explainGrounded(
    provider,
    {
      system: TRACE_SYSTEM_PROMPT,
      prompt: renderTracePrompt(ctx),
      facts: traceVerifyFacts(ctx),
      packages: ctx.packages,
      unresolved: ctx.unresolved.map((u) => u.note),
      scope: { file: s.file, start: s.startLine, end: s.endLine, symbol: ctx.scopeRef },
    },
    repoRoot,
  );
}

/** Every block either side explained, the component first; a block shared by both is listed once. */
export function traceBlocks(ctx: TraceContext): BlockRef[] {
  const blocks = new Map<string, BlockRef>();
  for (const b of [...componentBlocks(ctx.component), ...endpointBlocks(ctx.endpoint)]) {
    const key = `${b.file}:${b.start}-${b.end}`;
    if (!blocks.has(key)) blocks.set(key, b);
  }
  return [...blocks.values()];
}

export async function generateTraceSection(
  provider: LlmProvider,
  ctx: TraceContext,
  repoRoot: string,
  options: { model: string; depth: number },
): Promise<Section> {
  const walkthrough = await explainTrace(provider, ctx, repoRoot);
  const blocks = traceBlocks(ctx);
  return { ...recordSection(walkthrough, blocks[0], Object.keys(ctx.files), repoRoot, options), blocks, chainHash: ctx.traceHash };
}

export function traceOverviewOf(ctx: TraceContext): TraceOverview {
  const { call } = ctx.link;
  const trigger = call.triggers[0];
  return {
    method: ctx.endpoint.route.method,
    path: ctx.endpoint.route.fullPath,
    component: ctx.component.scopeRef,
    trigger: trigger ? describeTrigger(trigger) : 'no user action or effect found',
    call: `${call.method} ${call.urlPattern} in ${call.symbol.name} (${call.symbol.file}:${call.line})`,
    link: describeLink(ctx.link),
    chain: ctx.endpoint.chain.map((n) => n.label),
    afterResponse: [...new Set(ctx.afterResponse.map((a) => a.calleeText))],
    warnings: ctx.warnings,
    diagram: traceDiagram(ctx),
  };
}
