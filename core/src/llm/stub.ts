import type { LlmProvider } from './generate.js';

/**
 * An offline provider that answers with one step per line of the target, each citing only that line.
 * Deterministic and always passes the verifier, so tests of caching, staleness and ordering use it
 * where the explanation text doesn't matter.
 */
export interface LineStubProvider extends LlmProvider {
  /** "file:start-end" of every target explained, in call order. */
  targets: string[];
  prompts: string[];
}

const TARGET = /^# Target: .* at (\S+):(\d+)-(\d+)$/m;

export function createLineStubProvider(): LineStubProvider {
  const targets: string[] = [];
  const prompts: string[] = [];
  return {
    targets,
    prompts,
    async generate({ messages }) {
      const prompt = messages[0].content;
      const match = TARGET.exec(prompt);
      if (!match) throw new Error('line stub: no "# Target:" line in the prompt');
      const [, file, s, e] = match;
      const start = Number(s);
      const end = Number(e);
      targets.push(`${file}:${start}-${end}`);
      prompts.push(prompt);
      const steps = Array.from({ length: end - start + 1 }, (_, i) => ({
        id: `s${i + 1}`,
        code_ref: { file, start: start + i, end: start + i },
        explanation: `Line ${start + i} of the target.`,
        example: { input: 'any input', state_after: 'unchanged' },
        references: [],
        docs: [],
        concepts: [],
        risks: [],
      }));
      return JSON.stringify({ title: `Walkthrough of ${file}:${start}-${end}`, summary: 'Stub summary.', stages: [{ name: 'Body', steps }], unresolved: [] });
    },
  };
}
