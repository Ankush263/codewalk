import { z } from 'zod';

// The LLM output contract (CLAUDE.md §8.2). Kept free of constraints that JSON-schema structured
// outputs can't express; range and existence checks belong to the verifier.

export const codeRefSchema = z.object({
  file: z.string(),
  start: z.number().int(),
  end: z.number().int(),
});

export const referenceSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  role: z.enum(['caller', 'callee', 'type']),
});

export const docRefSchema = z.object({
  package: z.string(),
  symbol: z.string(),
});

export const stepSchema = z.object({
  id: z.string(),
  code_ref: codeRefSchema,
  explanation: z.string(),
  example: z.object({ input: z.string(), state_after: z.string() }),
  references: z.array(referenceSchema),
  docs: z.array(docRefSchema),
  concepts: z.array(z.string()),
  risks: z.array(z.string()),
});

export const walkthroughSchema = z.object({
  title: z.string(),
  summary: z.string(),
  stages: z.array(z.object({ name: z.string(), steps: z.array(stepSchema) })),
  unresolved: z.array(z.string()),
});

export type CodeRef = z.infer<typeof codeRefSchema>;
export type Reference = z.infer<typeof referenceSchema>;
export type DocRef = z.infer<typeof docRefSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Walkthrough = z.infer<typeof walkthroughSchema>;
