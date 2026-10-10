import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { LlmMessage, LlmProvider } from './generate.js';
import { walkthroughSchema } from './schema.js';
import type { z } from 'zod';

export class LlmRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LlmRequestError';
  }
}

/**
 * Calls Claude with structured outputs constrained to the walkthrough schema. Credentials come
 * from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile).
 */
export class AnthropicProvider implements LlmProvider {
  constructor(
    private readonly model: string,
    private client?: Anthropic,
  ) {}

  async generate({ system, messages, schema }: { system: string; messages: LlmMessage[]; schema?: z.ZodType }): Promise<string> {
    let response: Anthropic.Message;
    try {
      // Streamed so a long walkthrough (plus thinking) doesn't hit the HTTP timeout.
      this.client ??= new Anthropic();
      response = await this.client.messages
        .stream({
          model: this.model,
          max_tokens: 32000,
          system,
          messages,
          output_config: { format: zodOutputFormat((schema ?? walkthroughSchema) as typeof walkthroughSchema) },
        })
        .finalMessage();
    } catch (err) {
      throw new LlmRequestError(describeApiError(err), { cause: err });
    }

    if (response.stop_reason === 'refusal') {
      throw new LlmRequestError('The model declined to answer.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new LlmRequestError('The response was cut off at max_tokens; try a smaller target or a lower --depth.');
    }
    return response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  }
}

function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic API authentication failed: set ANTHROPIC_API_KEY (or run `ant auth login`).';
  }
  if (err instanceof Anthropic.NotFoundError) {
    return `Model not found: check llm.model in .walkthrough/config.json (${err.message}).`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Anthropic API rate limit reached; try again shortly.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}`;
  }
  if (err instanceof Error && /api key|apiKey|authentication/i.test(err.message)) {
    return 'No Anthropic credentials found: set ANTHROPIC_API_KEY (or run `ant auth login`).';
  }
  return `LLM request failed: ${err instanceof Error ? err.message : String(err)}`;
}
