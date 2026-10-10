import { describeTrigger, type ComponentContext } from '../context/component.js';
import type { CodeBlock } from '../context/fn.js';
import { COMPONENT_SYSTEM_PROMPT, renderComponentPrompt } from '../llm/componentPrompt.js';
import type { LlmProvider } from '../llm/generate.js';
import { componentVerifyFacts } from '../verify/verify.js';
import { explainGrounded } from './explain.js';
import type { FnWalkthrough } from './fn.js';
import { hashLines, type BlockRef, type ComponentOverview, type Section } from './saved.js';
import { recordSection } from './section.js';

// `walk component` after the facts are gathered: LLM -> verifier -> docs links (CLAUDE.md §6.4, §8.3).

export async function explainComponent(provider: LlmProvider, ctx: ComponentContext, repoRoot: string): Promise<FnWalkthrough> {
  const s = ctx.component.symbol;
  return explainGrounded(
    provider,
    {
      system: COMPONENT_SYSTEM_PROMPT,
      prompt: renderComponentPrompt(ctx),
      facts: componentVerifyFacts(ctx),
      packages: ctx.packages,
      unresolved: ctx.unresolved.map((u) => u.note),
      scope: { file: s.file, start: s.startLine, end: s.endLine, symbol: s.name },
    },
    repoRoot,
  );
}

/** The blocks a component walkthrough explains: the component first, then hooks, direct callees, types, values. */
export function componentBlocks(ctx: ComponentContext): BlockRef[] {
  const blocks = new Map<string, BlockRef>();
  const add = (symbol: string | null, code: CodeBlock | null) => {
    if (!code) return;
    const key = `${code.file}:${code.start}-${code.end}`;
    if (!blocks.has(key)) blocks.set(key, { file: code.file, symbol, start: code.start, end: code.end, hash: hashLines(code.lines) });
  };
  add(ctx.component.symbol.name, ctx.component.code);
  for (const h of ctx.hooks) add(h.symbol.name, h.code);
  for (const c of ctx.callees) if (c.callee) add(c.callee.name, c.code);
  for (const t of ctx.types) add(t.symbol.name, t.code);
  // Module-level values aren't symbols: they are found again by their exact text.
  for (const v of ctx.values) add(null, v.code);
  return [...blocks.values()];
}

export async function generateComponentSection(
  provider: LlmProvider,
  ctx: ComponentContext,
  repoRoot: string,
  options: { model: string; depth: number },
): Promise<Section> {
  const walkthrough = await explainComponent(provider, ctx, repoRoot);
  const blocks = componentBlocks(ctx);
  return { ...recordSection(walkthrough, blocks[0], Object.keys(ctx.files), repoRoot, options), blocks, chainHash: ctx.structureHash };
}

export function componentOverviewOf(ctx: ComponentContext): ComponentOverview {
  const c = ctx.component;
  const file = c.symbol.file;
  const expanded = new Set(ctx.hooks.map((h) => `${h.symbol.file}#${h.symbol.name}`));
  return {
    file,
    name: c.symbol.name,
    propsType: c.facts.propsType,
    props: c.facts.props,
    state: c.facts.state.map((s) => ({ name: s.name, setter: s.setter, hook: s.hook, initial: s.initial, at: `${file}:${s.line}` })),
    context: c.facts.context.map((x) => ({ context: x.context, at: `${file}:${x.line}` })),
    hooks: c.facts.hooks.map((h) => ({ name: h.name, package: h.package, expanded: h.callee !== null && expanded.has(`${h.callee.file}#${h.callee.name}`), at: `${file}:${h.line}` })),
    children: ctx.children.map((ch) => ({ element: ch.element, condition: ch.condition, props: ch.props.map((p) => p.name), at: `${file}:${ch.line}` })),
    handlers: c.facts.handlers.map((h) => ({ event: h.event, element: h.element, handler: h.handler, at: `${file}:${h.line}` })),
    effects: [c, ...ctx.hooks].flatMap((u) => u.facts.effects.map((e) => ({ hook: e.hook, deps: e.deps, owner: u.symbol.name, at: `${u.symbol.file}:${e.line}` }))),
    apiCalls: ctx.apiCalls.map((a) => ({ method: a.method, urlPattern: a.urlPattern, at: `${a.symbol.file}:${a.line}`, triggers: a.triggers.map(describeTrigger) })),
    limits: ctx.limits,
    warnings: ctx.warnings,
  };
}
