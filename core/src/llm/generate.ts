import { z } from 'zod';
import type { FnContext } from '../context/fn.js';
import { FN_SYSTEM_PROMPT, renderFnPrompt, type FnPromptOptions } from './prompt.js';
import { walkthroughSchema, type Walkthrough } from './schema.js';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A model that returns the raw JSON text of a walkthrough. Tests use recorded responses. */
export interface LlmProvider {
  generate(request: { system: string; messages: LlmMessage[] }): Promise<string>;
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

/** One walkthrough request: the response must match the §8.2 schema; invalid output is re-requested up to twice. */
export async function generateWalkthrough(provider: LlmProvider, request: { system: string; prompt: string }): Promise<GenerateResult> {
  const messages: LlmMessage[] = [{ role: 'user', content: request.prompt }];
  let lastProblem = '';

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const raw = await provider.generate({ system: request.system, messages });
    const problem = validate(raw);
    if (typeof problem !== 'string') return { walkthrough: problem, attempts: attempt };

    lastProblem = problem;
    messages.push(
      { role: 'assistant', content: raw },
      { role: 'user', content: `That response is not valid:\n${problem}\nReturn the complete corrected walkthrough as JSON.` },
    );
  }
  throw new LlmOutputError(`The model returned invalid output ${MAX_RETRIES + 1} times. Last problem:\n${lastProblem}`, MAX_RETRIES + 1);
}

/** The parsed walkthrough, or a description of what is wrong with `raw`. */
function validate(raw: string): Walkthrough | string {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return `Not valid JSON: ${(err as Error).message}`;
  }
  const parsed = walkthroughSchema.safeParse(json);
  return parsed.success ? parsed.data : z.prettifyError(parsed.error);
}
