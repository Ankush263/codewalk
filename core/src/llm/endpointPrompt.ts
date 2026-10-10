import type { EndpointContext, EndpointNode } from '../context/endpoint.js';
import { citeFiles, describe, fence } from './prompt.js';

// Turns an EndpointContext into the prompt. Same contract as `walk fn` (CLAUDE.md §8.2): the model
// sees only these facts and cites only them; the verifier enforces it afterwards.

export const ENDPOINT_SYSTEM_PROMPT = `You explain how one HTTP endpoint of a TypeScript Express backend works, to a developer who must be able to explain it to someone else afterwards.

You are given facts from static analysis: the route and the routers it is mounted through, the middleware chain in execution order, the handler, the code they call, the side effects found in each function (database, Redis, outbound HTTP, events, thrown errors) and the error handlers. Explain only what these facts show.

Rules:
- Never invent files, line numbers, symbols or behaviour. If something is not in the facts, say it is unknown or put it in "unresolved".
- Use these stages, in this order, and leave out any with no steps: "Request", "Middleware", "Validation", "Business logic", "Persistence", "Response". "Request" is how the request reaches the chain (registrations, body parsing); "Validation" is code that checks the input; "Persistence" is code that reads or writes databases, caches or queues.
- Steps follow the order a request executes: middleware in chain order, then the handler and what it calls. Each step covers a contiguous group of lines in ONE file: "code_ref" is a file listed under "Files you may cite" and a start/end line inside code shown to you.
- "explanation": what the lines do and why, in plain English. Wrap every identifier and code expression in backticks, and only use identifiers that appear in the given code or facts.
- "example": invent ONE concrete, realistic request at the first step (method, path, the headers that matter, JSON body) and trace that same request through every step. "input" names the request in effect; "state_after" lists what changed: \`req\` fields, local variables, rows written, keys set, the response. Compute values carefully from the code; when a value depends on code you were not shown (a database, a package, an unresolved call), say what it is assumed to be.
- "references": only file:line locations given in the facts (registrations, function definitions, call sites), with role "caller", "callee" or "type". Use an empty list when none apply.
- "docs": only for calls into packages listed under "Packages". "package" is the package name exactly as listed and "symbol" is the API used (e.g. "express.json", "Router", "pool.query"). Never write URLs.
- "concepts": short names of general ideas a reader should know (e.g. "middleware chain", "database transaction").
- "risks": what can go wrong at this step and what the client then receives, using the "Error paths" and error handlers given (e.g. "Missing token: UnauthorizedError, 401 via errorHandler"). Empty list if none.
- Step ids are unique, e.g. "s1", "s2".
- "unresolved": copy every note listed under "Unresolved", plus anything else you could not determine.`;

export function endpointPromptSections(ctx: EndpointContext): string[] {
  const out: string[] = [];
  const { route } = ctx;
  out.push(`# Endpoint: ${route.method} ${route.fullPath}`);

  out.push('## Mounted through');
  if (route.mounts.length === 0) out.push('(registered directly on the app)');
  for (const m of route.mounts) out.push(`- \`${m.prefix}\` at ${m.file}:${m.line}`);

  out.push('## Registrations');
  for (const b of ctx.registrations) out.push(fence(b));

  out.push('## Middleware chain and handler, in execution order');
  ctx.chain.forEach((n, i) => pushNode(out, n, `${i + 1}.`));

  out.push('## Error handlers (run when a step above fails)');
  if (ctx.errorHandlers.length === 0) out.push('(none registered: Express answers with its default 500 handler)');
  for (const n of ctx.errorHandlers) pushNode(out, n, '-');

  out.push('## Called code');
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

  out.push('## Side effects');
  if (ctx.sideEffects.length === 0) out.push('(none found)');
  for (const e of ctx.sideEffects) out.push(`- ${e.symbol.name} (${e.symbol.file}:${e.line}): ${e.kind} ${e.detail}`);

  out.push('## Error paths');
  if (ctx.errorPaths.length === 0) out.push('(none found)');
  for (const p of ctx.errorPaths) {
    out.push(`- ${p.symbol.name} (${p.symbol.file}:${p.line}): ${p.error}${p.status !== null ? ` -> HTTP ${p.status}` : ' -> status decided by the error handler'}`);
  }

  out.push('## Packages (imported by the files above)');
  if (ctx.packages.length === 0) out.push('(none)');
  for (const p of ctx.packages) out.push(`- ${p.name}${p.version ? `@${p.version}` : ''} (from "${p.importedPath}"): ${p.importedNames.join(', ')}`);

  if (ctx.unresolved.length > 0) {
    out.push('## Unresolved');
    for (const u of ctx.unresolved) out.push(`- ${u.note}`);
  }
  if (ctx.omitted.length > 0) {
    out.push('## Left out to fit the context budget');
    for (const o of ctx.omitted) out.push(`- ${o}`);
  }

  return out;
}

export function renderEndpointPrompt(ctx: EndpointContext): string {
  const { route } = ctx;
  return [...endpointPromptSections(ctx), ...citeFiles(ctx.files), `Write the walkthrough of ${route.method} ${route.fullPath}.`].join('\n\n');
}

function pushNode(out: string[], n: EndpointNode, bullet: string): void {
  const what = n.symbol ? describe(n.symbol) : '(package or unresolved: its code is not in the repo)';
  out.push(`${bullet} [${n.phase}] \`${n.label}\`, registered at ${n.registeredAt.file}:${n.registeredAt.line}: ${what}`);
  if (n.note) out.push(`note: ${n.note}`);
  if (n.code) out.push(fence(n.code));
}
