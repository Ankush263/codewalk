import { z } from 'zod';
import type { FnContext } from '../context/fn.js';
import { FN_SYSTEM_PROMPT, renderFnPrompt, type FnPromptOptions } from './prompt.js';
import { walkthroughSchema, type Walkthrough } from './schema.js';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A model that returns raw JSON text matching `schema` (the walkthrough schema when omitted). Tests use recorded responses. */
export interface LlmProvider {
  generate(request: { system: string; messages: LlmMessage[]; schema?: z.ZodType }): Promise<string>;
}

export class LlmOutputError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = 'LlmOutputError';
  }
}

export interface GenerateResult {
  walkthrough: Walkthrough;
  /** 1 when the first response was valid. */
  attempts: number;
}

const MAX_RETRIES = 2;

/** Asks for a walkthrough of `ctx`; a response that fails the §8.2 schema is re-requested up to twice. */
export async function generateFnWalkthrough(provider: LlmProvider, ctx: FnContext, options: FnPromptOptions = {}): Promise<GenerateResult> {
  return generateWalkthrough(provider, { system: FN_SYSTEM_PROMPT, prompt: renderFnPrompt(ctx, options) });
}

/** One structured request: the response must match `schema`; invalid output is re-requested up to twice. */
export async function generateStructured<S extends z.ZodType>(
  provider: LlmProvider,
  request: { system: string; prompt: string; schema: S; name?: string },
): Promise<{ value: z.infer<S>; attempts: number }> {
  const messages: LlmMessage[] = [{ role: 'user', content: request.prompt }];
  let lastProblem = '';
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const raw = await provider.generate({ system: request.system, messages, schema: request.schema });
    const result = validate(raw, request.schema);
    if (result.ok) return { value: result.value, attempts: attempt };
    lastProblem = result.problem;
    messages.push(
      { role: 'assistant', content: raw },
      { role: 'user', content: `That response is not valid:\n${result.problem}\nReturn the complete corrected ${request.name ?? 'response'} as JSON.` },
    );
  }
  throw new LlmOutputError(`The model returned invalid output ${MAX_RETRIES + 1} times. Last problem:\n${lastProblem}`, MAX_RETRIES + 1);
}

/** One walkthrough request (CLAUDE.md §8.2). */
export async function generateWalkthrough(provider: LlmProvider, request: { system: string; prompt: string }): Promise<GenerateResult> {
  const { value, attempts } = await generateStructured(provider, { ...request, schema: walkthroughSchema, name: 'walkthrough' });
  return { walkthrough: value, attempts };
}

function validate<S extends z.ZodType>(raw: string, schema: S): { ok: true; value: z.infer<S> } | { ok: false; problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, problem: `Not valid JSON: ${(err as Error).message}` };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: z.prettifyError(parsed.error) };
}
