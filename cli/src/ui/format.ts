import { describeTrigger, endpointDiagram, type ComponentContext, type EndpointContext, type EndpointNode, type FileContext, type ScopeKind, type WalkthroughStatus, type CodeBlock, type FnContext, type FnWalkthrough, type WalkthroughStep } from '@codewalk/core';

// Plain-text renderings: the `--no-llm` facts and the non-interactive walkthrough (piped output).

export function formatFacts(ctx: FnContext): string {
  const out: string[] = [];
  const { target } = ctx;
  const name = target.symbol ? `${target.symbol.kind} ${target.symbol.name}` : 'code block';
  out.push(`${name} — ${target.file}:${target.start}-${target.end}`);
  if (target.symbol?.signature) out.push(`  ${target.symbol.signature}`);
  out.push('', numbered(target.code));

  section(out, 'Declared inside', ctx.innerSymbols.map((s) => `${s.kind} ${s.name}  ${s.file}:${s.startLine}`));
  section(out, 'Callers', ctx.callers.map((c) => `${c.symbol.name}  ${c.symbol.file}:${c.callLine}`));
  section(out, 'Callees', calleeTree(ctx));
  section(out, 'Types used', ctx.types.map((t) => `${t.symbol.name}  ${t.symbol.file}:${t.symbol.startLine}`));
  section(out, 'Values used', ctx.values.map((v) => `${v.name}  ${v.file}:${v.startLine}`));
  section(out, 'Packages', ctx.packages.map((p) => `${p.name}${p.version ? `@${p.version}` : ''}: ${p.importedNames.join(', ')}`));
  section(out, 'Unresolved', ctx.unresolved.map((u) => u.note));
  section(out, 'Omitted (context budget)', ctx.omitted);
  section(out, 'Warnings', ctx.warnings);
  return out.join('\n');
}

export function formatFileFacts(ctx: FileContext): string {
  const out = [`file ${ctx.file} — ${ctx.lineCount} lines`];
  section(out, 'Imported by', ctx.importers.map((i) => `${i.file}${i.importedNames.length ? `  (${i.importedNames.join(', ')})` : ''}`));
  section(out, 'Exports', ctx.exports.map((s) => `${s.kind} ${s.name}  ${s.file}:${s.startLine}`));
  section(out, 'Internal helpers', ctx.helpers.map((s) => `${s.kind} ${s.name}  ${s.file}:${s.startLine}`));
  section(out, 'Walk order (helpers first)', ctx.order.map((s, i) => `${i + 1}. ${s.name}  ${s.file}:${s.startLine}-${s.endLine}`));
  section(out, 'Call cycles', ctx.cycleBreaks);
  section(out, 'Warnings', ctx.warnings);
  return out.join('\n');
}

export function formatEndpointFacts(ctx: EndpointContext): string {
  const out = [`endpoint ${ctx.route.method} ${ctx.route.fullPath}`];
  section(out, 'Mounted through', ctx.route.mounts.map((m) => `${m.prefix}  ${m.file}:${m.line}`));
  section(out, 'Middleware chain', ctx.chain.map((n, i) => `${i + 1}. ${n.label} [${n.phase}]  ${nodeAt(n)}`));
  section(out, 'Error handlers', ctx.errorHandlers.map((n) => `${n.label}  ${nodeAt(n)}`));
  section(out, 'Side effects', ctx.sideEffects.map((e) => `${e.kind} ${e.detail}  (${e.symbol.name} ${e.symbol.file}:${e.line})`));
  section(out, 'Error paths', ctx.errorPaths.map((p) => `${p.error}${p.status !== null ? ` → ${p.status}` : ''}  (${p.symbol.name} ${p.symbol.file}:${p.line})`));
  section(
    out,
    'Calls',
    ctx.callees.map((c) => {
      const target = c.callee ? `${c.callee.name}  ${c.callee.file}:${c.callee.startLine}` : `${c.calleeText}  ${c.resolved ? '(package / built-in)' : '(unresolved)'}`;
      return `${'  '.repeat(c.depth - 1)}${c.caller.name} → ${target}`;
    }),
  );
  section(out, 'Unresolved', ctx.unresolved.map((u) => u.note));
  section(out, 'Omitted (context budget)', ctx.omitted);
  section(out, 'Warnings', ctx.warnings);
  section(out, 'Sequence diagram (Mermaid)', endpointDiagram(ctx).split('\n'));
  return out.join('\n');
}

export function formatComponentFacts(ctx: ComponentContext): string {
  const c = ctx.component;
  const f = c.facts;
  const out = [`component ${c.symbol.name} — ${c.symbol.file}:${c.symbol.startLine}-${c.symbol.endLine}`];
  if (c.symbol.signature) out.push(`  ${c.symbol.signature}`);
  section(out, 'Props', f.props.length || f.propsType ? [`${f.props.join(', ') || '(not destructured)'}${f.propsType ? `  : ${f.propsType}` : ''}`] : []);
  section(out, 'State', f.state.map((s) => `${s.name}${s.setter ? ` / ${s.setter}` : ''}  ${s.hook}(${s.initial ?? ''})  line ${s.line}`));
  section(out, 'Context', f.context.map((x) => `${x.context}  line ${x.line}`));
  section(out, 'Hooks called', f.hooks.map((h) => `${h.name}  line ${h.line}  ${h.callee ? '(custom)' : h.package ? `(${h.package})` : ''}`.trimEnd()));
  section(out, 'Custom hooks (expanded)', ctx.hooks.map((h) => `${'  '.repeat(h.depth - 1)}${h.symbol.name}  ${h.symbol.file}:${h.symbol.startLine}  (used by ${h.usedBy} at ${h.calledAt})`));
  section(
    out,
    'Render tree',
    f.render.map((r) => `${'  '.repeat(r.depth)}<${r.element}>  line ${r.line}${r.condition ? `  when ${r.condition}` : ''}${r.props.length ? `  ${r.props.map((p) => `${p.name}=${p.value}`).join(' ')}` : ''}`),
  );
  section(out, 'Event handlers', f.handlers.map((h) => `${h.event} on <${h.element}> → ${h.handler}  line ${h.line}`));
  section(
    out,
    'Effects and derived values',
    [c, ...ctx.hooks].flatMap((u) => u.facts.effects.map((e) => `${e.hook} ${e.deps ? `[${e.deps.join(', ')}]` : '(every render)'}  ${u.symbol.name} ${u.symbol.file}:${e.line}`)),
  );
  section(
    out,
    'API calls',
    ctx.apiCalls.flatMap((a) => [
      `${a.method} ${a.urlPattern}  ${a.symbol.name} ${a.symbol.file}:${a.line}`,
      ...(a.triggers.length ? a.triggers.map((t) => `  ← ${describeTrigger(t)}`) : ['  ← no trigger found in this component']),
    ]),
  );
  section(
    out,
    'Calls',
    ctx.callees.map((k) => {
      const target = k.callee ? `${k.callee.name}  ${k.callee.file}:${k.callee.startLine}` : `${k.calleeText}  ${k.resolved ? '(package / built-in)' : '(unresolved)'}`;
      return `${'  '.repeat(k.depth - 1)}${k.caller.name} → ${target}`;
    }),
  );
  section(out, 'Unresolved', ctx.unresolved.map((u) => u.note));
  section(out, 'Not expanded', ctx.limits);
  section(out, 'Omitted (context budget)', ctx.omitted);
  section(out, 'Warnings', ctx.warnings);
  return out.join('\n');
}

function nodeAt(n: EndpointNode): string {
  return n.symbol ? `${n.symbol.file}:${n.symbol.startLine}` : `${n.registeredAt.file}:${n.registeredAt.line}`;
}

export function formatWalkthrough(w: FnWalkthrough, codeLines: (file: string) => string[], notes: string[] = []): string {
  const out: string[] = [w.title, '', w.summary];
  if (notes.length) out.push('', ...notes);
  const total = w.stages.reduce((n, s) => n + s.steps.length, 0);
  let index = 0;
  for (const stage of w.stages) {
    out.push('', `== ${stage.name} ==`);
    for (const step of stage.steps) {
      index++;
      out.push('', `-- Step ${index}/${total}: ${step.code_ref.file}:${step.code_ref.start}-${step.code_ref.end}`);
      out.push(numbered(sliceBlock(codeLines(step.code_ref.file), step.code_ref.file, step.code_ref.start, step.code_ref.end)));
      out.push('', ...formatStepBody(step));
    }
  }
  out.push('', ...formatVerification(w));
  return out.join('\n');
}

export function formatStepBody(step: WalkthroughStep): string[] {
  const out = [step.explanation, '', `Example  ${step.example.input}`, `  after  ${step.example.state_after}`];
  if (step.references.length) out.push('', 'References', ...step.references.map((r) => `  ${r.role.padEnd(6)} ${r.file}:${r.line}`));
  if (step.docLinks.length) out.push('', 'Docs', ...step.docLinks.map((d) => `  ${d.package} ${d.symbol}  ${d.url}`));
  if (step.concepts.length) out.push('', `Concepts  ${step.concepts.join(' · ')}`);
  if (step.risks.length) out.push('', 'Risks', ...step.risks.map((r) => `  ! ${r}`));
  return out;
}

export function formatVerification(w: FnWalkthrough): string[] {
  const { verification: v } = w;
  const out = [`Verified: ${v.keptSteps} step(s) kept, ${v.dropped.length} dropped.`];
  for (const d of v.dropped) out.push(`  dropped ${d.stepId}: ${d.reasons.join('; ')}`);
  if (v.removedDocs.length) out.push(`  removed ${v.removedDocs.length} docs link(s) for packages the file does not import`);
  if (w.unresolved.length) out.push('', 'Unresolved', ...w.unresolved.map((u) => `  ? ${u}`));
  return out;
}

/** Lines start..end of a file as a CodeBlock (clipped to the file). */
export function sliceBlock(lines: string[], file: string, start: number, end: number): CodeBlock {
  const first = Math.max(1, start);
  const last = Math.min(lines.length, end);
  return { file, start: first, end: last, lines: lines.slice(first - 1, last) };
}

function numbered(block: CodeBlock): string {
  const width = String(block.end).length;
  return block.lines.map((line, i) => `  ${String(block.start + i).padStart(width)} │ ${line}`).join('\n');
}

/** Callees as a tree: each callee's own calls indented beneath it, in call-line order. */
function calleeTree(ctx: FnContext): string[] {
  const lines: string[] = [];
  const visit = (calls: FnContext['callees'], depth: number, path: Set<number>) => {
    for (const c of calls) {
      const target = c.callee
        ? `${c.callee.name}  ${c.callee.file}:${c.callee.startLine}`
        : `${c.calleeText}  ${c.resolved ? '(package / built-in)' : '(unresolved)'}`;
      lines.push(`${'  '.repeat(depth - 1)}line ${c.callLine}  ${target}`);
      if (c.callee && !path.has(c.callee.id)) {
        const children = ctx.callees.filter((k) => k.depth === depth + 1 && k.caller.id === c.callee!.id);
        visit(children, depth + 1, new Set([...path, c.callee.id]));
      }
    }
  };
  visit(ctx.callees.filter((c) => c.depth === 1), 1, new Set());
  return lines;
}

function section(out: string[], title: string, lines: string[]) {
  if (lines.length === 0) return;
  out.push('', title, ...lines.map((l) => `  ${l}`));
}

export interface ListRow {
  scopeKind: ScopeKind;
  scopeRef: string;
  savedAt: Date;
  status: WalkthroughStatus;
}

export function formatList(rows: ListRow[]): string {
  if (rows.length === 0) return 'No saved walkthroughs yet. Run `walk fn`, `walk file`, `walk endpoint` or `walk component` to create one.';
  const width = Math.max(...rows.map((r) => r.scopeRef.length));
  const kindWidth = Math.max(...rows.map((r) => r.scopeKind.length));
  return rows
    .map((r) => {
      const s = r.status;
      const detail = s.fresh ? `${s.totalSteps} steps` : staleDetail(r.scopeKind, s);
      const saved = new Date(r.savedAt).toISOString().slice(0, 16).replace('T', ' ');
      return `${s.fresh ? 'fresh' : 'stale'}  ${r.scopeKind.padEnd(kindWidth)}  ${r.scopeRef.padEnd(width)}  ${detail} · saved ${saved}`;
    })
    .join('\n');
}

function staleDetail(kind: ScopeKind, s: WalkthroughStatus): string {
  const label = (x: WalkthroughStatus['sections'][number]) => x.symbol ?? `${x.file} lines`;
  const changed = s.sections.filter((x) => x.state === 'changed').flatMap((x) => (x.changedBlocks?.length ? x.changedBlocks : [label(x)]));
  const removed = s.sections.filter((x) => x.state === 'missing').map(label);
  const parts = [`${s.staleSteps}/${s.totalSteps} steps stale`];
  if (s.fileRemoved) parts.push('file removed');
  if (s.routeRemoved) parts.push(kind === 'component' ? 'component removed' : 'route removed');
  if (s.chainChanged) parts.push(kind === 'component' ? 'structure changed' : 'middleware chain changed');
  if (changed.length) parts.push(`changed: ${changed.join(', ')}`);
  if (removed.length) parts.push(`removed: ${removed.join(', ')}`);
  if (s.uncovered.length) parts.push(`not covered: ${s.uncovered.join(', ')}`);
  return parts.join(' · ');
}
