import { describeTrigger } from '../context/component.js';
import { describeLink, type TraceContext } from '../context/trace.js';
import { componentPromptSections } from './componentPrompt.js';
import { endpointPromptSections } from './endpointPrompt.js';
import { citeFiles } from './prompt.js';

// Turns a TraceContext into one prompt: how the frontend reaches the route, then the component's facts,
// then the endpoint's facts, then one list of citable files. Same contract as every walkthrough (CLAUDE.md §8.2).

export const TRACE_SYSTEM_PROMPT = `You explain one full-stack request of a TypeScript monorepo (React frontend, Express backend), from the user's action to the database and back, to a developer who must be able to explain it to someone else afterwards.

You are given facts from static analysis: the user action or effect that starts it, the frontend code on the way to the API call, how that call was matched to the backend route, the route's middleware chain, handler and the code it calls with their side effects, error paths, and what the frontend does after the response. Explain only what these facts show.

Rules:
- Never invent files, line numbers, symbols or behaviour. If something is not in the facts, say it is unknown or put it in "unresolved".
- Use these stages, in this order, and leave out any with no steps: "UI trigger" (the user action or effect and the handler code), "Request" (from the frontend call through the API client to the route registrations and body parsing), "Server" (middleware, validation, the handler and business logic), "Persistence" (database, cache and queue effects), "Response" (what the server sends back, including error statuses), "UI update" (what the frontend does with the response: state changes and callbacks).
- Follow ONLY the traced API call; other code in the component or endpoint matters only as far as this request uses it.
- Each step covers a contiguous group of lines in ONE file: "code_ref" is a file listed under "Files you may cite" and a start/end line inside code shown to you.
- "explanation": what the lines do and why, in plain English. Wrap every identifier and code expression in backticks, and only use identifiers that appear in the given code or facts.
- "example": invent ONE concrete user input at the first step and trace the same data through every step: form values -> request body -> req fields -> rows written -> response JSON -> UI state. "input" names what is in effect; "state_after" lists what changed. When a value depends on code you were not shown, say what it is assumed to be.
- "references": only file:line locations given in the facts, with role "caller", "callee" or "type". Use an empty list when none apply.
- "docs": only for calls into packages listed under "Packages". "package" is the package name exactly as listed and "symbol" is the API used. Never write URLs.
- "concepts": short names of general ideas a reader should know.
- "risks": what can go wrong at this step and what the user then sees in the UI, using the error paths given. Empty list if none.
- Step ids are unique, e.g. "s1", "s2".
- "unresolved": copy every note listed under "Unresolved", plus anything else you could not determine.`;

export function renderTracePrompt(ctx: TraceContext): string {
  const { link } = ctx;
  const comp = ctx.component.component.symbol;
  const route = `${ctx.endpoint.route.method} ${ctx.endpoint.route.fullPath}`;
  const trigger = link.call.triggers[0];
  const after = ctx.afterResponse.map((a) => `- \`${a.calleeText}\` at ${a.file}:${a.line}${a.callee ? ` (${a.callee})` : ''}`);
  return [
    `# Trace: ${trigger ? trigger.label : 'no trigger found'} in ${comp.name} → ${route}`,
    '## How the frontend reaches the backend',
    [
      `- trigger: ${trigger ? describeTrigger(trigger) : '(none found: explain the call without a user action)'}`,
      `- API call: ${link.call.method} ${link.call.urlPattern} (\`${link.call.urlText}\`) in ${link.call.symbol.name} (${link.call.symbol.file}:${link.call.line})`,
      `- matched to route ${route} by ${describeLink(link)}`,
    ].join('\n'),
    '## After the response, the calling function calls',
    after.length ? after.join('\n') : '(nothing found)',
    ...componentPromptSections(ctx.component),
    ...endpointPromptSections(ctx.endpoint),
    ...citeFiles(ctx.files),
    `Write the trace of ${link.call.method} ${link.call.urlPattern} from ${comp.name} to ${route} and back.`,
  ].join('\n\n');
}
