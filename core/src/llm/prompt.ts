import type { CodeBlock, FnContext } from '../context/fn.js';
import type { SymbolRecord } from '../store/types.js';

// Turns an FnContext into the prompt. The model sees only these facts and is told to cite only
// them; the verifier enforces it afterwards.

export const FN_SYSTEM_PROMPT = `You explain TypeScript code to a developer who must be able to explain it to someone else afterwards.

You are given facts from static analysis: the target code with line numbers, its callers, its callees, the types it uses and the packages its file imports. Explain only what these facts show.

Rules:
- Never invent files, line numbers, symbols or behaviour. If something is not in the facts, say it is unknown or put it in "unresolved".
- Steps follow execution order through the target code. Each step covers a contiguous group of lines: "code_ref" is the target file and a start/end line inside the target's range.
- "explanation": what the lines do and why, in plain English. Wrap every identifier and code expression in backticks, and only use identifiers that appear in the given code or facts.
- "example": pick ONE concrete, realistic input at the first step and trace that same input through every step. "input" names the input in effect; "state_after" lists the relevant variables and their exact values after this step. Compute values carefully from the code shown; if a value depends on code you were not shown (a database, a package, an unresolved call), say what it is assumed to be.
- "references": only file:line locations given in the facts (caller call sites, callee definitions, type and value definitions), with role "caller", "callee" or "type". Use an empty list when none apply.
- "docs": only for calls into packages listed under "Packages" (including calls on values created from them, e.g. a \`pool\` declared as \`new Pool()\` from "pg"). "package" is the package name exactly as listed and "symbol" is the API used (e.g. "Router", "res.json", "useState"). Never write URLs.
- "concepts": short names of general ideas a reader should know (e.g. "database transaction").
- "risks": what can go wrong at this step (errors thrown, edge cases, failure paths). Empty list if none.
- Group steps into a few named "stages" (e.g. "Validate input", "Persist", "Respond"). Step ids are unique, e.g. "s1", "s2".
- "unresolved": copy every note listed under "Unresolved calls", plus anything else you could not determine.`;

export function renderFnPrompt(ctx: FnContext): string {
  const { target } = ctx;
  const out: string[] = [];
  const kind = target.symbol ? `${target.symbol.kind} ${target.symbol.name}` : 'code block';

  out.push(`# Target: ${kind} at ${target.file}:${target.start}-${target.end}`);
  out.push(fence(target.code));

  if (ctx.innerSymbols.length > 0) {
    out.push('## Declared inside the target');
    for (const s of ctx.innerSymbols) out.push(`- ${describe(s)}`);
  }

  out.push('## Callers');
  if (ctx.callers.length === 0) out.push('(none found in the index)');
  for (const c of ctx.callers) {
    out.push(`- ${describe(c.symbol)} calls it at ${c.symbol.file}:${c.callLine}`);
    if (c.code) out.push(fence(c.code));
  }

  out.push('## Callees');
  if (ctx.callees.length === 0) out.push('(none)');
  for (const c of ctx.callees) {
    const where = `${c.caller.name} at ${c.caller.file}:${c.callLine}`;
    if (c.callee) {
      out.push(`- [depth ${c.depth}] ${where} calls ${describe(c.callee)}`);
      if (c.code) out.push(fence(c.code));
    } else if (c.resolved) {
      out.push(`- [depth ${c.depth}] ${where} calls \`${c.calleeText}\` (package or built-in)`);
    } else {
      out.push(`- [depth ${c.depth}] ${where} calls \`${c.calleeText}\` (UNRESOLVED dynamic call)`);
    }
  }

  if (ctx.types.length > 0) {
    out.push('## Types used');
    for (const t of ctx.types) {
      out.push(`- ${describe(t.symbol)}`);
      if (t.code) out.push(fence(t.code));
    }
  }

  if (ctx.values.length > 0) {
    out.push('## Module-level values used');
    for (const v of ctx.values) {
      out.push(`- \`${v.name}\` (${v.file}:${v.startLine})`);
      if (v.code) out.push(fence(v.code));
    }
  }

  out.push('## Packages (imported by the target file or by the files declaring the values above)');
  if (ctx.packages.length === 0) out.push('(none)');
  for (const p of ctx.packages) {
    out.push(`- ${p.name}${p.version ? `@${p.version}` : ''} (from "${p.importedPath}"): ${p.importedNames.join(', ')}`);
  }

  if (ctx.unresolved.length > 0) {
    out.push('## Unresolved calls');
    for (const u of ctx.unresolved) out.push(`- ${u.note}`);
  }

  if (ctx.omitted.length > 0) {
    out.push('## Left out to fit the context budget');
    for (const o of ctx.omitted) out.push(`- ${o}`);
  }

  out.push('## Files you may cite (with line counts)');
  for (const [file, lines] of Object.entries(ctx.files)) out.push(`- ${file}: ${lines} lines`);

  out.push(`Write the walkthrough of ${target.file}:${target.start}-${target.end}.`);
  return out.join('\n\n');
}

function describe(s: SymbolRecord): string {
  const sig = s.signature ? ` — \`${s.signature}\`` : '';
  return `${s.kind} \`${s.name}\` (${s.file}:${s.startLine}-${s.endLine})${sig}`;
}

/** A fenced block with right-aligned line numbers, e.g. " 36 | const phone = ...". */
export function fence(block: CodeBlock): string {
  const width = String(block.end).length;
  const body = block.lines.map((line, i) => `${String(block.start + i).padStart(width)} | ${line}`).join('\n');
  return `\`\`\`ts title="${block.file}:${block.start}-${block.end}"\n${body}\n\`\`\``;
}
