import { describeTrigger, type ComponentContext, type ReactUnit } from '../context/component.js';
import { citeFiles, describe, fence } from './prompt.js';

// Turns a ComponentContext into the prompt. Same contract as `walk fn` (CLAUDE.md §8.2): the model
// sees only these facts and cites only them; the verifier enforces it afterwards.

export const COMPONENT_SYSTEM_PROMPT = `You explain how one React component of a TypeScript frontend works, to a developer who must be able to explain it to someone else afterwards.

You are given facts from static analysis: the component's props, the state it owns, the context it reads, the hooks it calls (custom hooks from the repo are expanded with their code), its render tree, its event handlers, the code those call, and the API calls it can trigger with the handler or effect that leads to each. Explain only what these facts show.

Rules:
- Never invent files, line numbers, symbols or behaviour. If something is not in the facts, say it is unknown or put it in "unresolved".
- Use these stages, in this order, and leave out any with no steps: "Inputs and state" (props, state, context), "Render" (what it renders, the children and props passed down, conditional branches), "Effects and derived values" (useEffect, useMemo, useCallback in the component itself), then one stage per expanded custom hook named exactly "Hook: <hook name>" in the order the hooks are listed, then "Event handlers" (one step per user action or callback: what state changes and what calls fire), then "Data fetching" (one step per API call: its method, URL pattern and the handler or effect that triggers it).
- Each step covers a contiguous group of lines in ONE file: "code_ref" is a file listed under "Files you may cite" and a start/end line inside code shown to you.
- "explanation": what the lines do and why, in plain English. Wrap every identifier and code expression in backticks, and only use identifiers that appear in the given code or facts.
- "example": invent ONE concrete set of props and ONE realistic user interaction (or the first render, if the component has no handlers) at the first step, and trace that same example through every step. "input" names the props, event or call in effect; "state_after" lists the state variables, hook results and requests after the step. Compute values carefully from the code; when a value depends on code you were not shown (a server response, a package, an unresolved call), say what it is assumed to be.
- "references": only file:line locations given in the facts (definitions, call sites, handler attributes), with role "caller", "callee" or "type". Use an empty list when none apply.
- "docs": only for calls into packages listed under "Packages". "package" is the package name exactly as listed and "symbol" is the API used (e.g. "useState", "useEffect"). Never write URLs.
- "concepts": short names of general ideas a reader should know (e.g. "controlled input", "effect dependencies").
- "risks": what can go wrong at this step and what the user then sees (failed requests, missing effect dependencies, stale state). Empty list if none.
- Step ids are unique, e.g. "s1", "s2".
- "unresolved": copy every note listed under "Unresolved", plus anything else you could not determine.`;

export function componentPromptSections(ctx: ComponentContext): string[] {
  const out: string[] = [];
  const c = ctx.component;
  const f = c.facts;
  out.push(`# Component: ${c.symbol.name} (${c.symbol.file}:${c.symbol.startLine}-${c.symbol.endLine})`);

  out.push('## Props');
  out.push(f.props.length ? `${f.props.map((p) => `\`${p}\``).join(', ')}${f.propsType ? ` (type \`${f.propsType}\`)` : ''}` : '(none)');

  out.push('## State, context, hooks and effects');
  pushUnitFacts(out, c);

  out.push('## Render tree (component elements, and elements with handlers or conditions)');
  if (f.render.length === 0) out.push('(no JSX found)');
  for (const r of f.render) {
    const props = r.props.length ? `: ${r.props.map((p) => `${p.name}={${p.value}}`).join(' ')}` : '';
    out.push(`${'  '.repeat(r.depth)}- <${r.element}> at ${c.symbol.file}:${r.line}${r.condition ? ` when \`${r.condition}\`` : ''}${props}`);
  }

  out.push('## Event handlers');
  if (f.handlers.length === 0) out.push('(none)');
  for (const h of f.handlers) out.push(`- ${h.event} on <${h.element}> at ${c.symbol.file}:${h.line} runs \`${h.handler}\``);

  out.push('## Component code');
  if (c.code) out.push(fence(c.code));

  for (const h of ctx.hooks) {
    out.push(`## Hook: ${h.symbol.name} (depth ${h.depth}, called by ${h.usedBy} at ${h.calledAt})`);
    pushUnitFacts(out, h);
    out.push(h.code ? fence(h.code) : '(body left out to fit the context budget)');
  }

  out.push('## Child components (rendered, not expanded)');
  if (ctx.children.length === 0) out.push('(none)');
  for (const ch of ctx.children) {
    const what = ch.symbol ? describe(ch.symbol) : ch.package ? `from package ${ch.package}` : '(not found in the index)';
    out.push(`- <${ch.element}> at ${c.symbol.file}:${ch.line}${ch.condition ? ` when \`${ch.condition}\`` : ''}: ${what}`);
  }

  out.push('## API calls');
  if (ctx.apiCalls.length === 0) out.push('(none found)');
  for (const a of ctx.apiCalls) {
    const triggers = a.triggers.length ? ` ← ${a.triggers.map(describeTrigger).join('; ')}` : ' (no trigger found in this component)';
    out.push(`- ${a.method} ${a.urlPattern} in ${a.symbol.name} (${a.symbol.file}:${a.line})${triggers}`);
  }

  out.push('## Called code');
  if (ctx.callees.length === 0) out.push('(none)');
  for (const k of ctx.callees) {
    const where = `${k.caller.name} at ${k.caller.file}:${k.callLine}`;
    if (k.callee) {
      out.push(`- [depth ${k.depth}] ${where} calls ${describe(k.callee)}`);
      if (k.code) out.push(fence(k.code));
    } else {
      out.push(`- [depth ${k.depth}] ${where} calls \`${k.calleeText}\` (${k.resolved ? 'package or built-in' : 'UNRESOLVED dynamic call'})`);
    }
  }

  out.push('## Types used');
  if (ctx.types.length === 0) out.push('(none)');
  for (const t of ctx.types) {
    out.push(`- ${describe(t.symbol)}`);
    if (t.code) out.push(fence(t.code));
  }

  out.push('## Module-level values used');
  if (ctx.values.length === 0) out.push('(none)');
  for (const v of ctx.values) {
    out.push(`- \`${v.name}\` (${v.file}:${v.startLine})`);
    if (v.code) out.push(fence(v.code));
  }

  out.push('## Packages (imported by the files above)');
  if (ctx.packages.length === 0) out.push('(none)');
  for (const p of ctx.packages) out.push(`- ${p.name}${p.version ? `@${p.version}` : ''} (from "${p.importedPath}"): ${p.importedNames.join(', ')}`);

  if (ctx.unresolved.length > 0) {
    out.push('## Unresolved');
    for (const u of ctx.unresolved) out.push(`- ${u.note}`);
  }
  if (ctx.limits.length > 0) {
    out.push('## Not expanded (depth limits)');
    for (const l of ctx.limits) out.push(`- ${l}`);
  }
  if (ctx.omitted.length > 0) {
    out.push('## Left out to fit the context budget');
    for (const o of ctx.omitted) out.push(`- ${o}`);
  }

  return out;
}

export function renderComponentPrompt(ctx: ComponentContext): string {
  return [...componentPromptSections(ctx), ...citeFiles(ctx.files), `Write the walkthrough of ${ctx.component.symbol.name}.`].join('\n\n');
}

function pushUnitFacts(out: string[], u: ReactUnit): void {
  const f = u.facts;
  const file = u.symbol.file;
  const lines = [
    ...(u.symbol.kind === 'hook' && f.props.length ? [`- parameters: ${f.props.map((p) => `\`${p}\``).join(', ')}${f.propsType ? ` (type \`${f.propsType}\`)` : ''}`] : []),
    ...f.state.map((s) => `- state \`${s.name}\`${s.setter ? ` (setter \`${s.setter}\`)` : ''} from ${s.hook}${s.initial !== null ? `, initially \`${s.initial}\`` : ''} at ${file}:${s.line}`),
    ...f.context.map((x) => `- reads context \`${x.context}\` at ${file}:${x.line}`),
    ...f.hooks.map((h) => `- calls hook \`${h.name}\` at ${file}:${h.line}${h.callee ? ' (custom hook from this repo)' : h.package ? ` (from ${h.package})` : ''}`),
    ...f.effects.map(
      (e) =>
        `- ${e.hook} at ${file}:${e.line}-${e.endLine}${e.deps ? ` with deps [${e.deps.join(', ')}]` : ' with no deps array (runs after every render)'}${e.binding ? ` -> \`${e.binding}\`` : ''}`,
    ),
  ];
  out.push(lines.length ? lines.join('\n') : '(no state, context, hooks or effects)');
}
