import { describe, expect, it } from 'vitest';
import { checkAnswer, vocabularyOf } from '../verify/verify.js';
import { answerSchema, renderQuestionPrompt } from './answer.js';
import { generateStructured, generateWalkthrough, type LlmProvider } from './generate.js';
import { walkthroughSchema } from './schema.js';

function replay(...responses: string[]) {
  const requests: { schema?: unknown; messages: { role: string; content: string }[] }[] = [];
  const provider: LlmProvider = {
    generate: async (request) => {
      requests.push({ schema: request.schema, messages: [...request.messages] });
      return responses.shift()!;
    },
  };
  return { provider, requests };
}

describe('generateStructured', () => {
  it('passes the schema to the provider and re-requests invalid output', async () => {
    const { provider, requests } = replay('{"answer": 3}', '{"answer": "ok", "references": []}');
    const result = await generateStructured(provider, { system: 's', prompt: 'p', schema: answerSchema, name: 'answer' });
    expect(result).toEqual({ value: { answer: 'ok', references: [] }, attempts: 2 });
    expect(requests[0].schema).toBe(answerSchema);
    expect(requests[1].messages.at(-1)!.content).toMatch(/^That response is not valid:[\s\S]*Return the complete corrected answer as JSON\.$/);
  });

  it('asks for walkthroughs with the walkthrough schema', async () => {
    const { provider, requests } = replay('{"title":"t","summary":"s","stages":[],"unresolved":[]}');
    await generateWalkthrough(provider, { system: 's', prompt: 'p' });
    expect(requests[0].schema).toBe(walkthroughSchema);
  });
});

describe('checkAnswer', () => {
  const facts = { files: { 'a.ts': 10 }, vocabulary: vocabularyOf(['const total = 1']), packages: new Set<string>() };

  it('keeps references inside the context and warns about the rest and about unknown identifiers', () => {
    const result = checkAnswer(
      {
        answer: '`total` is set from `missing`.',
        references: [
          { file: 'a.ts', line: 3, role: 'callee' },
          { file: 'a.ts', line: 11, role: 'callee' },
          { file: 'b.ts', line: 1, role: 'type' },
        ],
      },
      facts,
    );
    expect(result.references).toEqual([{ file: 'a.ts', line: 3, role: 'callee' }]);
    expect(result.warnings).toEqual([
      "Removed reference a.ts:11: outside the file's lines 1-10.",
      'Removed reference b.ts:1: not part of the indexed context.',
      'Names identifiers not found in the code or index: `missing`',
    ]);
  });
});

describe('renderQuestionPrompt', () => {
  it('puts the facts, the step with its code, and the question in order', () => {
    const prompt = renderQuestionPrompt({
      facts: '# Endpoint: POST /x',
      step: { id: 's2', code_ref: { file: 'a.ts', start: 2, end: 3 }, explanation: 'It checks `token`.' },
      code: { file: 'a.ts', start: 2, end: 3, lines: ['const token = get();', 'if (!token) throw err;'] },
      question: 'What if the token is empty?',
    });
    const order = ['# Facts', '# Endpoint: POST /x', '# The step being read', 'Step s2 at a.ts:2-3', '2 | const token = get();', 'It checks `token`.', '# Question', 'What if the token is empty?'];
    const positions = order.map((s) => prompt.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
