import type { CodeBlock, FnContext, FnWalkthrough, WalkthroughStep } from '@codewalk/core';

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

export function formatWalkthrough(w: FnWalkthrough, codeLines: (file: string) => string[]): string {
  const out: string[] = [w.title, '', w.summary];
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
