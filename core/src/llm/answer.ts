import { z } from 'zod';
import type { CodeBlock } from '../context/fn.js';
import { generateStructured, type LlmProvider } from './generate.js';
import { fence } from './prompt.js';
import { referenceSchema, type CodeRef } from './schema.js';

// Drill-down Q&A on one step (CLAUDE.md §12 Phase 6): answered from the same facts the walkthrough was
// written from, cited like steps, checked like steps (verify.checkAnswer).

export const answerSchema = z.object({
  answer: z.string(),
  references: z.array(referenceSchema),
});

export type Answer = z.infer<typeof answerSchema>;

export const QA_SYSTEM_PROMPT = `You answer a developer's question about one step of a code walkthrough. You are given the facts the walkthrough was written from (static analysis of the repository), the step they are reading with its code, and their question.

Rules:
- Answer only from the facts given. If they don't contain the answer, say exactly what is unknown and why (for example, the code is in a package or behind an unresolved call). Never invent files, line numbers, symbols or behaviour.
- Be concise: a few sentences, or a short list when the answer has several parts.
- Wrap every identifier and code expression in backticks, and only use identifiers that appear in the facts.
- "references": file:line locations from the facts that support the answer, with role "caller", "callee" or "type". Use an empty list when none apply.`;

export interface QuestionInput {
  /** The scope's rendered facts, without the final "Write …" instruction. */
  facts: string;
  step: { id: string; code_ref: CodeRef; explanation: string };
  /** The step's current lines. */
  code: CodeBlock;
  question: string;
}

export function renderQuestionPrompt({ facts, step, code, question }: QuestionInput): string {
  const { file, start, end } = step.code_ref;
  return [
    '# Facts',
    facts,
    '# The step being read',
    `Step ${step.id} at ${file}:${start}-${end}`,
    fence(code),
    `Its explanation: ${step.explanation}`,
    '# Question',
    question,
    'Answer the question.',
  ].join('\n\n');
}

export async function generateAnswer(provider: LlmProvider, input: QuestionInput): Promise<Answer> {
  const { value } = await generateStructured(provider, { system: QA_SYSTEM_PROMPT, prompt: renderQuestionPrompt(input), schema: answerSchema, name: 'answer' });
  return value;
}
