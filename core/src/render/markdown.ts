import type { FnWalkthrough, WalkthroughStep } from '../walkthrough/fn.js';
import { flattenWalkthrough, overviewNotes, type SavedWalkthrough } from '../walkthrough/saved.js';

// Markdown export (CLAUDE.md §9): saved next to the JSON in .walkthrough/walkthroughs/ and printed
// by `--out md`. Code snippets come from the current source, which matches the saved line numbers.

export function renderMarkdown(saved: SavedWalkthrough, codeLines: (file: string) => string[]): string {
  const out: string[] = [];
  if (saved.scopeKind === 'fn') {
    const w = saved.sections[0].walkthrough;
    out.push(`# ${w.title}`, '', `\`${location(w)}\``, '', w.summary);
    renderStages(out, w, 2, codeLines);
  } else {
    const o = saved.overview!;
    out.push(`# How ${o.file} works`, '', '## Overview', '', ...overviewNotes(o).map((n) => `- ${n}`));
    saved.sections.forEach((s, i) => {
      const w = s.walkthrough;
      out.push('', `## ${i + 1}. ${s.block.symbol ?? 'block'} (\`${location(w)}\`)`, '', w.summary);
      renderStages(out, w, 3, codeLines);
    });
  }
  renderFooter(out, flattenWalkthrough(saved));
  return `${out.join('\n')}\n`;
}

function renderStages(out: string[], w: FnWalkthrough, level: number, codeLines: (file: string) => string[]) {
  const h = '#'.repeat(level);
  let n = 0;
  for (const stage of w.stages) {
    out.push('', `${h} ${stage.name}`);
    for (const step of stage.steps) {
      n++;
      const { file, start, end } = step.code_ref;
      out.push('', `${h}# Step ${n} · \`${file}:${start}-${end}\``, '', fence(file, start, end, codeLines(file)), '', ...stepBody(step));
    }
  }
}

function stepBody(step: WalkthroughStep): string[] {
  const out = [step.explanation, '', `**Example:** ${step.example.input}  `, `**After:** ${step.example.state_after}`];
  if (step.references.length) out.push('', '**References**', ...step.references.map((r) => `- ${r.role} \`${r.file}:${r.line}\``));
  if (step.docLinks.length) out.push('', '**Docs**', ...step.docLinks.map((d) => `- [${d.package} ${d.symbol}](${d.url})`));
  if (step.concepts.length) out.push('', `**Concepts:** ${step.concepts.join(' · ')}`);
  if (step.risks.length) out.push('', '**Risks**', ...step.risks.map((r) => `- ${r}`));
  return out;
}

function renderFooter(out: string[], w: FnWalkthrough) {
  const v = w.verification;
  out.push('', '## Verification', '', `Verified: ${v.keptSteps} step(s) kept, ${v.dropped.length} dropped.`);
  for (const d of v.dropped) out.push(`- dropped ${d.stepId}: ${d.reasons.join('; ')}`);
  if (w.unresolved.length) out.push('', '## Unresolved', '', ...w.unresolved.map((u) => `- ${u}`));
}

function fence(file: string, start: number, end: number, lines: string[]): string {
  const width = String(end).length;
  const body = lines.slice(start - 1, end).map((line, i) => `${String(start + i).padStart(width)} | ${line}`);
  return ['```' + (file.endsWith('.tsx') ? 'tsx' : 'ts'), ...body, '```'].join('\n');
}

const location = (w: FnWalkthrough) => `${w.scope.file}:${w.scope.start}-${w.scope.end}`;
