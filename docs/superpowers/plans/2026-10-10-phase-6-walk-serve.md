# Phase 6: `walk serve` (web UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `walk serve` opens a local React UI for saved walkthroughs:
- a list with fresh/stale status;
- a reader with code on the left and the explanation on the right, plus the diagram;
- grounded and verified Q&A per step, saved with the walkthrough;
- "predict first, then reveal" mode;
- regeneration of stale walkthroughs.

**Architecture:**
- **Core** gains a structured-output generator, a Q&A prompt plus answer checker, a questions table, and a JSON view model shared by the CLI and the server (`walkthroughList`, `walkthroughDetail`, `askQuestion`). Q&A rebuilds the walkthrough's context with the same builder the CLI uses.
- **The CLI** gains a dependency-free `node:http` server (localhost only, Host-checked, header-guarded POSTs). It serves the API and the built Vite app, and regenerates by calling the existing `run*` commands.
- **`web/`** becomes a React + Vite app. Its API, prediction storage and diagram renderer are injected, so it is tested in jsdom.

**Tech Stack:** TypeScript (ESM), React 19, Vite, Mermaid, `node:http`, `pg`, zod, vitest + jsdom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-10-phase-6-walk-serve-design.md` (implements `CLAUDE.md` §5 `walk serve`, §7, §8.3, §9, §11, §12 Phase 6).

## Global Constraints

- Node `>=24`, pnpm workspaces, vitest, tsup (core/cli), Vite (web). TypeScript 7; `pnpm typecheck` must pass at the end.
- Nothing outside `core/src/store` writes SQL (CLAUDE.md §8.1a).
- Database tests use the real compose Postgres with throwaway `cw_test_*` schemas (CLAUDE.md §14). LLM calls use recorded responses (CLAUDE.md §14).
- Docs URLs are never produced by the LLM (CLAUDE.md §8.4). Q&A references are verified like steps (CLAUDE.md §8.3).
- The server binds `127.0.0.1` only, checks `Host`, requires `X-Codewalk: 1` plus JSON on POSTs, limits bodies to 64 KB, and never serves files outside the web root.
- The web app imports **types only** from `@codewalk/core`.
- `SAVED_VERSION` stays `2`. The fixture is unchanged (edits happen in temp copies).
- **Do not commit** (CLAUDE.md §15). Each task ends with a checkpoint.
- Run tests from the repo root with Postgres up. Baseline: `pnpm test` → 42 files, 291 tests passing.

## Review Focus

1. **A malicious web page the user visits while `walk serve` runs** must not be able to trigger LLM calls, read code, or rebind via DNS: foreign Host → 403, POST without `X-Codewalk` → 403. Tested in Task 5.
2. **Path traversal on static files** (`/..%2Fpackage.json`) must return 404, never a file outside `web/dist`. Tested in Task 5.
3. **A question about a step whose code has since changed** must show its answer as stale, not as current. Tested in Task 4.
4. **The web UI not built yet** must still let the API work and show build instructions, not crash. Tested in Tasks 5 and 6.
5. **Typing in the question or prediction box** must not trigger the ←/→ step keys. Tested in Task 9.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/llm/generate.ts`, `anthropic.ts` (modify) | `generateStructured`; provider `schema` option |
| `core/src/llm/answer.ts` (create), `__fixtures__/enrollAnswer.response.json` (create) | `answerSchema`, Q&A prompt, `generateAnswer`; recorded answer |
| `core/src/verify/verify.ts` (modify) | `fnVerifyFacts`, `checkAnswer` |
| `core/src/store/migrations/1795000000000_walkthrough-questions.ts`, `types.ts`, `store.ts` | questions table; `saveQuestion`, `listQuestions` |
| `core/src/render/markdown.ts`, `walkthrough/persist.ts` (modify) | Q&A in Markdown |
| `core/src/walkthrough/question.ts` (create) | `locateStep`, `askQuestion` |
| `core/src/walkthrough/status.ts` (create), `staleness.ts`, `saved.ts` (modify) | `walkthroughStatus(es)`, `describeStaleness`, `walkthroughNotes` |
| `core/src/walkthrough/detail.ts` (create), `core/src/api.ts` (create) | `walkthroughList`, `walkthroughDetail`, `toQuestionView`; the JSON types |
| `core/src/walkthrough/__fixtures__/seed.ts` (create) | Seeds the recorded endpoint walkthrough into a temp repo |
| `cli/src/serve/server.ts`, `regenerate.ts` (create) | HTTP server; regeneration through `run*` |
| `cli/src/commands/serve.ts` (create), `shared.ts`, `index.ts`, `list.ts`, `ui/format.ts`, `ui/output.ts` (modify) | `walk serve`; shared status/notes |
| `web/` (rewrite) | Vite + React app: `api.ts`, `route.ts`, `storage.ts`, `App.tsx`, `WalkthroughList.tsx`, `WalkthroughView.tsx`, `CodePanel.tsx`, `StepPanel.tsx`, `QuestionPanel.tsx`, `Diagram.tsx`, `Inline.tsx`, `styles.css` |

---

### Task 1: Structured generation, answer schema and answer checking

**Files:**
- Modify: `core/src/llm/generate.ts`, `core/src/llm/anthropic.ts`, `core/src/llm/index.ts`, `core/src/verify/verify.ts`, `core/src/verify/index.ts`
- Create: `core/src/llm/answer.ts`
- Test: `core/src/llm/answer.test.ts`

**Interfaces:**
- Produces: `LlmProvider.generate(request: { system: string; messages: LlmMessage[]; schema?: z.ZodType })`; `generateStructured<S extends z.ZodType>(provider, { system, prompt, schema, name? }): Promise<{ value: z.infer<S>; attempts: number }>`; `answerSchema`, `type Answer = { answer: string; references: Reference[] }`; `QA_SYSTEM_PROMPT`; `renderQuestionPrompt({ facts, step, code, question }): string`; `generateAnswer(provider, input): Promise<Answer>`; `fnVerifyFacts(ctx: FnContext): VerifyFacts`; `checkAnswer(answer: Answer, facts: VerifyFacts): { references: Reference[]; warnings: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `core/src/llm/answer.test.ts`:

```ts
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
```

Run: `pnpm vitest run core/src/llm/answer.test.ts`
Expected: FAIL: cannot resolve `./answer.js`.

- [ ] **Step 2: Generalise generation**

In `core/src/llm/generate.ts`:

1. Change the provider interface to:

```ts
/** A model that returns raw JSON text matching `schema` (the walkthrough schema when omitted). Tests use recorded responses. */
export interface LlmProvider {
  generate(request: { system: string; messages: LlmMessage[]; schema?: z.ZodType }): Promise<string>;
}
```

2. Replace `generateWalkthrough` and `validate` with:

```ts
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
```

In `core/src/llm/anthropic.ts`, change `generate` to take and use the schema:

```ts
  async generate({ system, messages, schema }: { system: string; messages: LlmMessage[]; schema?: z.ZodType }): Promise<string> {
```

and set `output_config: { format: zodOutputFormat((schema ?? walkthroughSchema) as typeof walkthroughSchema) },`, adding `import type { z } from 'zod';`. The cast only satisfies the SDK helper's generic; every schema used is a zod object. Also change the two walkthrough-specific error messages to neutral ones: `'The model declined to answer.'` and `'The response was cut off at max_tokens; try a smaller target or a lower --depth.'`.

In `core/src/llm/index.ts`, export `generateStructured` from `./generate.js`, and append `export { answerSchema, generateAnswer, QA_SYSTEM_PROMPT, renderQuestionPrompt, type Answer } from './answer.js';`.

- [ ] **Step 3: The answer prompt**

Create `core/src/llm/answer.ts`:

```ts
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
```

- [ ] **Step 4: Checking answers; `fnVerifyFacts`**

In `core/src/verify/verify.ts`:
1. Add `import type { Answer } from '../llm/answer.js';` and `Reference` to the schema type import (`import type { Reference, Step, Walkthrough } from '../llm/schema.js';`).
2. Replace `verifyFnWalkthrough` with:

```ts
/** Everything a `walk fn` (or file section) walkthrough may name or cite. */
export function fnVerifyFacts(ctx: FnContext): VerifyFacts {
  return { files: ctx.files, vocabulary: buildVocabulary(ctx), packages: new Set(ctx.packages.map((p) => p.name)) };
}

export function verifyFnWalkthrough(walkthrough: Walkthrough, ctx: FnContext): VerifyResult {
  return verifyWalkthrough(walkthrough, fnVerifyFacts(ctx));
}
```

3. Add:

```ts
/**
 * The verifier rules for an answer (CLAUDE.md §8.3): references outside the context are removed; names the
 * facts don't contain are reported. An answer is kept either way, with its warnings shown next to it.
 */
export function checkAnswer(answer: Answer, facts: VerifyFacts): { references: Reference[]; warnings: string[] } {
  const warnings: string[] = [];
  const references = answer.references.filter((r) => {
    const lines = facts.files[r.file];
    if (lines === undefined) {
      warnings.push(`Removed reference ${r.file}:${r.line}: not part of the indexed context.`);
      return false;
    }
    if (r.line < 1 || r.line > lines) {
      warnings.push(`Removed reference ${r.file}:${r.line}: outside the file's lines 1-${lines}.`);
      return false;
    }
    return true;
  });
  const unknown = [...new Set(codeSpans(answer.answer).flatMap(identifiers))].filter((id) => !facts.vocabulary.has(id));
  if (unknown.length > 0) warnings.push(`Names identifiers not found in the code or index: ${unknown.map((u) => `\`${u}\``).join(', ')}`);
  return { references, warnings };
}
```

In `core/src/verify/index.ts`, add `checkAnswer`, `fnVerifyFacts`, `vocabularyOf` and `type VerifyFacts` to the exports.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run core/src/llm core/src/verify core/src/walkthrough`
Expected: PASS (existing generation tests unchanged; the walkthrough correction text is still "…corrected walkthrough as JSON.").

- [ ] **Step 6: Checkpoint**

Do not commit. `pnpm --filter @codewalk/core exec tsc --noEmit` is clean. If the SDK's `zodOutputFormat` typing rejects the cast, type the parameter via `Parameters<typeof zodOutputFormat>[0]` instead, and ledger it.

---

### Task 2: Saved questions and Q&A in Markdown

**Files:**
- Create: `core/src/store/migrations/1795000000000_walkthrough-questions.ts`
- Modify: `core/src/store/types.ts`, `core/src/store/store.ts`, `core/src/render/markdown.ts`, `core/src/walkthrough/persist.ts`
- Test: `core/src/store/store.test.ts` (append), `core/src/render/markdown.test.ts` (append)

**Interfaces:**
- Produces (types): `AnswerFact { answer: string; references: Reference-like[]; warnings: string[] }`; `QuestionFact { scopeKind; scopeRef; stepId; question; answer: AnswerFact; stepHash; model }`; `QuestionRecord extends QuestionFact { id: number; createdAt: Date }`.
- Produces (`Store`): `saveQuestion(q: QuestionFact): Promise<QuestionRecord>`; `listQuestions(scopeKind: string, scopeRef: string): Promise<QuestionRecord[]>`, ordered by id.
- Produces: `renderMarkdown(saved, codeLines, questions: QuestionRecord[] = [])`; `persistWalkthrough` includes the saved questions. Question `stepId`s are flattened ids (`<symbol>/<id>` for file walkthroughs).

- [ ] **Step 1: Write the failing tests**

Append to `core/src/store/store.test.ts`:

```ts
describe('store: walkthrough questions', () => {
  let store: Store;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_qa_${randomBytes(4).toString('hex')}` });
    await store.migrate();
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('saves questions per walkthrough and lists them in order', async () => {
    const base = { scopeKind: 'endpoint', scopeRef: 'POST /x', stepHash: 'h2', model: 'm' };
    const first = await store.saveQuestion({ ...base, stepId: 's2', question: 'Why?', answer: { answer: 'Because `a`.', references: [{ file: 'a.ts', line: 3, role: 'callee' }], warnings: [] } });
    await store.saveQuestion({ ...base, stepId: 's1', question: 'How?', answer: { answer: 'Like so.', references: [], warnings: ['w'] } });
    await store.saveQuestion({ ...base, scopeRef: 'GET /y', stepId: 's1', question: 'Other?', answer: { answer: '-', references: [], warnings: [] } });
    expect(first).toMatchObject({ id: expect.any(Number), stepId: 's2', createdAt: expect.any(Date) });
    expect((await store.listQuestions('endpoint', 'POST /x')).map((q) => `${q.stepId} ${q.question} ${q.answer.warnings.length}`)).toEqual(['s2 Why? 0', 's1 How? 1']);
  });
});
```

Append to `core/src/render/markdown.test.ts` (import `SAVED_VERSION` and `type SavedWalkthrough` from `../walkthrough/saved.js` and `type QuestionRecord` from `../store/types.js` if they aren't imported yet):

```ts
describe('renderMarkdown: questions', () => {
  const step = { id: 's1', code_ref: { file: 'a.ts', start: 1, end: 1 }, explanation: 'It adds.', example: { input: 'x', state_after: 'y' }, references: [], docs: [], docLinks: [], concepts: [], risks: [] };
  const saved: SavedWalkthrough = {
    version: SAVED_VERSION,
    scopeKind: 'fn',
    scopeRef: 'a.ts#f',
    overview: null,
    sections: [
      {
        block: { file: 'a.ts', symbol: 'f', start: 1, end: 1, hash: 'h' },
        stepHashes: { s1: 'h' },
        fileHashes: {},
        refLines: {},
        generatedAt: '2026-10-10T00:00:00Z',
        model: 'm',
        depth: 2,
        walkthrough: {
          scope: { file: 'a.ts', start: 1, end: 1, symbol: 'f' },
          title: 'How f works',
          summary: 'S.',
          stages: [{ name: 'Do', steps: [step] }],
          unresolved: [],
          verification: { attempts: 1, keptSteps: 1, dropped: [], removedDocs: [] },
        },
      },
    ],
  };
  const question: QuestionRecord = {
    id: 1, scopeKind: 'fn', scopeRef: 'a.ts#f', stepId: 's1', question: 'Why add?', stepHash: 'h', model: 'm', createdAt: new Date(),
    answer: { answer: 'Because `f` sums.', references: [], warnings: [] },
  };

  it('lists each step’s questions under it', () => {
    const md = renderMarkdown(saved, () => ['const f = 1;'], [question]);
    expect(md).toContain('**Questions**\n- **Q:** Why add?\n  **A:** Because `f` sums.');
    expect(renderMarkdown(saved, () => ['const f = 1;'])).not.toContain('**Questions**');
  });
});
```

Run: `pnpm vitest run core/src/store/store.test.ts core/src/render/markdown.test.ts -t "questions"`
Expected: FAIL: `store.saveQuestion is not a function`; Markdown without questions.

- [ ] **Step 2: Migration, types and store**

Create `core/src/store/migrations/1795000000000_walkthrough-questions.ts`:

```ts
import type { MigrationBuilder } from 'node-pg-migrate';

// Phase 6 (walk serve): questions asked on a walkthrough's steps and their verified answers. step_hash is
// the step's hash when asked, so an answer to code that has since changed is shown as stale.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('walkthrough_questions', {
    id: 'id',
    scope_kind: { type: 'text', notNull: true },
    scope_ref: { type: 'text', notNull: true },
    step_id: { type: 'text', notNull: true },
    question: { type: 'text', notNull: true },
    answer: { type: 'jsonb', notNull: true },
    step_hash: { type: 'text', notNull: true },
    model: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('walkthrough_questions', ['scope_kind', 'scope_ref']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('walkthrough_questions');
}
```

In `core/src/store/types.ts`, after `WalkthroughRecord`, add:

```ts
/** A verified answer: references outside the context removed, problems listed as warnings. */
export interface AnswerFact {
  answer: string;
  references: { file: string; line: number; role: 'caller' | 'callee' | 'type' }[];
  warnings: string[];
}

export interface QuestionFact {
  scopeKind: string;
  scopeRef: string;
  /** Flattened step id: "s2", or "<symbol>/s2" in a file walkthrough. */
  stepId: string;
  question: string;
  answer: AnswerFact;
  /** The step's hash when asked; the answer is stale once the step's code changes. */
  stepHash: string;
  model: string;
}

export interface QuestionRecord extends QuestionFact {
  id: number;
  createdAt: Date;
}
```

In `core/src/store/store.ts`, import `QuestionFact` and `QuestionRecord`, and add after `listWalkthroughs`:

```ts
  async saveQuestion(q: QuestionFact): Promise<QuestionRecord> {
    const { rows } = await this.pool.query<QuestionRow>(
      `INSERT INTO walkthrough_questions (scope_kind, scope_ref, step_id, question, answer, step_hash, model)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING ${QUESTION_COLUMNS}`,
      [q.scopeKind, q.scopeRef, q.stepId, q.question, JSON.stringify(q.answer), q.stepHash, q.model],
    );
    return toQuestionRecord(rows[0]);
  }

  /** Questions on one walkthrough, oldest first. */
  async listQuestions(scopeKind: string, scopeRef: string): Promise<QuestionRecord[]> {
    const { rows } = await this.pool.query<QuestionRow>(
      `SELECT ${QUESTION_COLUMNS} FROM walkthrough_questions WHERE scope_kind = $1 AND scope_ref = $2 ORDER BY id`,
      [scopeKind, scopeRef],
    );
    return rows.map(toQuestionRecord);
  }
```

and, next to the other row helpers:

```ts
const QUESTION_COLUMNS = 'id, scope_kind, scope_ref, step_id, question, answer, step_hash, model, created_at';

interface QuestionRow {
  id: string;
  scope_kind: string;
  scope_ref: string;
  step_id: string;
  question: string;
  answer: QuestionRecord['answer'];
  step_hash: string;
  model: string;
  created_at: Date;
}

function toQuestionRecord(r: QuestionRow): QuestionRecord {
  return {
    id: Number(r.id), scopeKind: r.scope_kind, scopeRef: r.scope_ref, stepId: r.step_id, question: r.question, answer: r.answer,
    stepHash: r.step_hash, model: r.model, createdAt: r.created_at,
  };
}
```

- [ ] **Step 3: Markdown with questions**

In `core/src/render/markdown.ts`:
1. Import `type QuestionRecord` from `../store/types.js`.
2. Change the signature to `export function renderMarkdown(saved: SavedWalkthrough, codeLines: (file: string) => string[], questions: QuestionRecord[] = []): string {`.
3. Pass `questions` to every `renderStages(...)` call. For the file branch, also pass the flattened-id mapper: `renderStages(out, w, 3, codeLines, questions, (id) => `${s.block.symbol ?? 'block'}/${id}`)`.
4. Change `renderStages` to:

```ts
function renderStages(
  out: string[],
  w: FnWalkthrough,
  level: number,
  codeLines: (file: string) => string[],
  questions: QuestionRecord[] = [],
  keyOf: (stepId: string) => string = (id) => id,
) {
  const h = '#'.repeat(level);
  let n = 0;
  for (const stage of w.stages) {
    out.push('', `${h} ${stage.name}`);
    for (const step of stage.steps) {
      n++;
      const { file, start, end } = step.code_ref;
      out.push('', `${h}# Step ${n} · \`${file}:${start}-${end}\``, '', fence(file, start, end, codeLines(file)), '', ...stepBody(step));
      out.push(...questionLines(questions.filter((q) => q.stepId === keyOf(step.id))));
    }
  }
}

function questionLines(questions: QuestionRecord[]): string[] {
  if (questions.length === 0) return [];
  return ['', '**Questions**', ...questions.flatMap((q) => [`- **Q:** ${q.question}`, `  **A:** ${q.answer.answer}`])];
}
```

In `core/src/walkthrough/persist.ts`, change the Markdown write to:

```ts
  writeFileSync(join(repoRoot, paths.markdown), renderMarkdown(saved, codeReader(repoRoot), await store.listQuestions(saved.scopeKind, saved.scopeRef)));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Do not commit. Core typecheck is clean.

---

### Task 3: Asking a question about a step

**Files:**
- Create: `core/src/llm/__fixtures__/enrollAnswer.response.json`, `core/src/walkthrough/__fixtures__/seed.ts`, `core/src/walkthrough/question.ts`
- Modify: `core/src/walkthrough/index.ts`
- Test: `core/src/walkthrough/question.test.ts`

**Interfaces:**
- Consumes: `generateAnswer`, `checkAnswer`, `fnVerifyFacts`, `endpointVerifyFacts`, `componentVerifyFacts`, `traceVerifyFacts`; the context builders and prompt renderers; `saveQuestion`; `persistWalkthrough`.
- Produces: `locateStep(saved, stepId): { section: Section; step: WalkthroughStep; localId: string }`; `askQuestion(provider, store, repoRoot, saved, stepId, question, { model, maxContextTokens }): Promise<QuestionRecord>`; test helper `seedEndpointWalkthrough(store, repo): Promise<SavedWalkthrough>`, `recordedEndpoint: LlmProvider`, `ENDPOINT_REF`.

- [ ] **Step 1: Recorded answer and seed helper**

Create `core/src/llm/__fixtures__/enrollAnswer.response.json`:

```json
{
  "answer": "When `redis.get` finds no session, `requireAuth` passes an `UnauthorizedError` to `next`, and `errorHandler` answers 401.",
  "references": [
    { "file": "api/middleware/auth.ts", "line": 19, "role": "callee" },
    { "file": "api/nowhere.ts", "line": 3, "role": "callee" }
  ]
}
```

Create `core/src/walkthrough/__fixtures__/seed.ts`:

```ts
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../config.js';
import { buildEndpointContext } from '../../context/endpoint.js';
import { indexRepo } from '../../indexer/index.js';
import type { LlmProvider } from '../../llm/generate.js';
import type { Store } from '../../store/index.js';
import { endpointOverviewOf, generateEndpointSection } from '../endpoint.js';
import { persistWalkthrough } from '../persist.js';
import { SAVED_VERSION, type SavedWalkthrough } from '../saved.js';

// Saves the recorded walkthrough of POST /api/patients/enroll into a temp copy of the fixture, exactly
// as `walk endpoint` would. Never call it on the fixture itself: it writes .walkthrough/walkthroughs/.

export const ENDPOINT_REF = 'POST /api/patients/enroll';
const RECORDED = readFileSync(new URL('../../llm/__fixtures__/enrollEndpoint.response.json', import.meta.url), 'utf8');
export const recordedEndpoint: LlmProvider = { generate: async () => RECORDED };

export async function seedEndpointWalkthrough(store: Store, repo: string): Promise<SavedWalkthrough> {
  await indexRepo(repo, loadConfig(repo), store);
  const ctx = await buildEndpointContext(store, repo, { method: 'POST', path: '/api/patients/enroll' }, { depth: 3, maxContextTokens: 60000 });
  const section = await generateEndpointSection(recordedEndpoint, ctx, repo, { model: 'recorded', depth: 3 });
  const saved: SavedWalkthrough = { version: SAVED_VERSION, scopeKind: 'endpoint', scopeRef: ctx.scopeRef, overview: null, endpoint: endpointOverviewOf(ctx), sections: [section] };
  await persistWalkthrough(store, repo, saved);
  return saved;
}
```

- [ ] **Step 2: Write the failing test**

Create `core/src/walkthrough/question.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmProvider } from '../llm/generate.js';
import { openStore, type Store } from '../store/index.js';
import { seedEndpointWalkthrough } from './__fixtures__/seed.js';
import { WALKTHROUGHS_DIR, walkthroughSlug } from './persist.js';
import { askQuestion, locateStep } from './question.js';
import type { SavedWalkthrough } from './saved.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const ANSWER = readFileSync(new URL('../llm/__fixtures__/enrollAnswer.response.json', import.meta.url), 'utf8');

describe('locateStep', () => {
  const section = (symbol: string | null, ids: string[]) => ({
    block: { file: 'a.ts', symbol, start: 1, end: 9, hash: 'h' },
    stepHashes: {},
    walkthrough: { stages: [{ name: 'x', steps: ids.map((id) => ({ id })) }] },
  });

  it('maps flattened file-walkthrough ids to their section', () => {
    const saved = { scopeKind: 'file', scopeRef: 'a.ts', sections: [section('f', ['s1']), section('g', ['s1', 's2']), section(null, ['s1'])] } as unknown as SavedWalkthrough;
    expect(locateStep(saved, 'g/s2')).toMatchObject({ localId: 's2', section: { block: { symbol: 'g' } } });
    expect(locateStep(saved, 'block/s1')).toMatchObject({ localId: 's1', section: { block: { symbol: null } } });
    expect(() => locateStep(saved, 'h/s1')).toThrow('No step "h/s1" in the file walkthrough a.ts.');
  });
});

describe('askQuestion on a saved endpoint walkthrough', () => {
  let repo: string;
  let store: Store;
  let saved: SavedWalkthrough;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-qa-'));
    cpSync(FIXTURE, repo, { recursive: true });
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_ask_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    saved = await seedEndpointWalkthrough(store, repo);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('answers from the rebuilt facts, verifies the references, saves it and updates the Markdown (Phase 6 acceptance)', async () => {
    const prompts: string[] = [];
    const provider: LlmProvider = {
      generate: async ({ messages }) => {
        prompts.push(messages[0].content);
        return ANSWER;
      },
    };
    const record = await askQuestion(provider, store, repo, saved, 's2', 'What happens when the session is missing?', { model: 'recorded', maxContextTokens: 60000 });
    expect(record).toMatchObject({
      stepId: 's2',
      stepHash: saved.sections[0].stepHashes.s2,
      answer: {
        references: [{ file: 'api/middleware/auth.ts', line: 19, role: 'callee' }],
        warnings: ['Removed reference api/nowhere.ts:3: not part of the indexed context.'],
      },
    });
    expect(prompts[0]).toContain('# Endpoint: POST /api/patients/enroll');
    expect(prompts[0]).not.toContain('Write the walkthrough of');
    expect(prompts[0]).toContain('Step s2 at api/middleware/auth.ts:11-23');
    expect(await store.listQuestions('endpoint', 'POST /api/patients/enroll')).toHaveLength(1);
    const md = readFileSync(join(repo, WALKTHROUGHS_DIR, `${walkthroughSlug('endpoint', 'POST /api/patients/enroll')}.md`), 'utf8');
    expect(md).toContain('- **Q:** What happens when the session is missing?');
  });

  it('rejects empty questions and unknown steps', async () => {
    const never: LlmProvider = { generate: async () => { throw new Error('not called'); } };
    await expect(askQuestion(never, store, repo, saved, 's2', '   ', { model: 'm', maxContextTokens: 60000 })).rejects.toThrow('Ask a question first.');
    await expect(askQuestion(never, store, repo, saved, 's99', 'Why?', { model: 'm', maxContextTokens: 60000 })).rejects.toThrow('No step "s99"');
  });
});
```

Run: `pnpm vitest run core/src/walkthrough/question.test.ts`
Expected: FAIL: cannot resolve `./question.js`.

- [ ] **Step 3: Implement**

Create `core/src/walkthrough/question.ts`:

```ts
import { buildComponentContext } from '../context/component.js';
import { buildEndpointContext } from '../context/endpoint.js';
import { buildFnContext } from '../context/fn.js';
import { parseComponentTarget, parseFnTarget, TargetError, type FnTarget } from '../context/target.js';
import { buildTraceContext } from '../context/trace.js';
import { generateAnswer } from '../llm/answer.js';
import { renderComponentPrompt } from '../llm/componentPrompt.js';
import { renderEndpointPrompt } from '../llm/endpointPrompt.js';
import type { LlmProvider } from '../llm/generate.js';
import { renderFnPrompt } from '../llm/prompt.js';
import { renderTracePrompt } from '../llm/tracePrompt.js';
import { parseEndpointTarget } from '../routes/match.js';
import type { Store } from '../store/index.js';
import type { QuestionRecord } from '../store/types.js';
import { checkAnswer, componentVerifyFacts, endpointVerifyFacts, fnVerifyFacts, traceVerifyFacts, type VerifyFacts } from '../verify/verify.js';
import type { WalkthroughStep } from './fn.js';
import { persistWalkthrough } from './persist.js';
import { readLines, type SavedWalkthrough, type Section } from './saved.js';

// Drill-down Q&A (CLAUDE.md §12 Phase 6): rebuild the walkthrough's facts from the current index with the
// builder its CLI command uses, answer from them, verify, save, and refresh the Markdown mirror.

const MAX_QUESTION = 2000;

export function locateStep(saved: SavedWalkthrough, stepId: string): { section: Section; step: WalkthroughStep; localId: string } {
  let section: Section | undefined;
  let localId = stepId;
  if (saved.scopeKind === 'file') {
    const slash = stepId.indexOf('/');
    localId = stepId.slice(slash + 1);
    const symbol = stepId.slice(0, slash);
    section = slash > 0 ? saved.sections.find((s) => (s.block.symbol ?? 'block') === symbol) : undefined;
  } else {
    section = saved.sections[0];
  }
  const step = section?.walkthrough.stages.flatMap((s) => s.steps).find((s) => s.id === localId);
  if (!section || !step) throw new TargetError(`No step "${stepId}" in the ${saved.scopeKind} walkthrough ${saved.scopeRef}.`);
  return { section, step, localId };
}

export async function askQuestion(
  provider: LlmProvider,
  store: Store,
  repoRoot: string,
  saved: SavedWalkthrough,
  stepId: string,
  question: string,
  options: { model: string; maxContextTokens: number },
): Promise<QuestionRecord> {
  const text = question.trim();
  if (text === '') throw new TargetError('Ask a question first.');
  if (text.length > MAX_QUESTION) throw new TargetError(`Questions are limited to ${MAX_QUESTION} characters.`);
  const { section, step, localId } = locateStep(saved, stepId);
  const { prompt, verify } = await factsFor(store, repoRoot, saved, section, options.maxContextTokens);
  const { file, start, end } = step.code_ref;
  const code = { file, start, end, lines: (readLines(repoRoot, file) ?? []).slice(start - 1, end) };
  const answer = await generateAnswer(provider, { facts: withoutInstruction(prompt), step, code, question: text });
  const checked = checkAnswer(answer, verify);
  const record = await store.saveQuestion({
    scopeKind: saved.scopeKind,
    scopeRef: saved.scopeRef,
    stepId,
    question: text,
    answer: { answer: answer.answer, ...checked },
    stepHash: section.stepHashes[localId] ?? '',
    model: options.model,
  });
  await persistWalkthrough(store, repoRoot, saved);
  return record;
}

/** The prompt a walkthrough of this scope is written from, and what an answer may cite. */
async function factsFor(store: Store, repoRoot: string, saved: SavedWalkthrough, section: Section, maxContextTokens: number): Promise<{ prompt: string; verify: VerifyFacts }> {
  const options = { depth: section.depth, maxContextTokens };
  switch (saved.scopeKind) {
    case 'fn':
    case 'file': {
      const { block } = section;
      const target: FnTarget =
        saved.scopeKind === 'fn'
          ? parseFnTarget(saved.scopeRef)
          : block.symbol
            ? { kind: 'symbol', file: block.file, name: block.symbol }
            : { kind: 'range', file: block.file, start: block.start, end: block.end };
      const ctx = await buildFnContext(store, repoRoot, target, options);
      return { prompt: renderFnPrompt(ctx), verify: fnVerifyFacts(ctx) };
    }
    case 'endpoint': {
      const ctx = await buildEndpointContext(store, repoRoot, parseEndpointTarget(saved.scopeRef), options);
      return { prompt: renderEndpointPrompt(ctx), verify: endpointVerifyFacts(ctx) };
    }
    case 'component': {
      const ctx = await buildComponentContext(store, repoRoot, parseComponentTarget(saved.scopeRef), options);
      return { prompt: renderComponentPrompt(ctx), verify: componentVerifyFacts(ctx) };
    }
    case 'trace': {
      const [route, from] = saved.scopeRef.split(' <- ');
      const ctx = await buildTraceContext(store, repoRoot, { endpoint: parseEndpointTarget(route), from: parseComponentTarget(from) }, options);
      return { prompt: renderTracePrompt(ctx), verify: traceVerifyFacts(ctx) };
    }
  }
}

/** Every walkthrough prompt ends with a "Write …" instruction; Q&A replaces it with the question. */
function withoutInstruction(prompt: string): string {
  const cut = prompt.lastIndexOf('\n\nWrite ');
  return cut > 0 ? prompt.slice(0, cut) : prompt;
}
```

In `core/src/walkthrough/index.ts`, append `export { askQuestion, locateStep } from './question.js';`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/walkthrough`
Expected: PASS. If `api/middleware/auth.ts:19` is out of the context's files, read `prompts[0]`'s "Files you may cite". The endpoint context includes `requireAuth`'s file, so it should be in.

- [ ] **Step 5: Checkpoint**

Do not commit. Core typecheck is clean.

---

### Task 4: Status, notes and the JSON view model

**Files:**
- Create: `core/src/api.ts`, `core/src/walkthrough/status.ts`, `core/src/walkthrough/detail.ts`
- Modify: `core/src/walkthrough/staleness.ts` (add `describeStaleness`), `core/src/walkthrough/saved.ts` (add `walkthroughNotes`), `core/src/walkthrough/index.ts`, `core/src/index.ts`
- Modify: `cli/src/commands/list.ts`, `cli/src/ui/format.ts`, `cli/src/ui/output.ts`
- Test: `core/src/walkthrough/detail.test.ts`

**Interfaces:**
- Produces (`api.ts`, types only):
  ```ts
  WalkthroughListItem { scopeKind: ScopeKind; scopeRef: string; title: string; savedAt: string; fresh: boolean; staleSteps: number; totalSteps: number; staleSummary: string | null }
  StepState { fresh: boolean; file: string; start: number; end: number }
  QuestionView { id: number; stepId: string; question: string; answer: string; references: Reference[]; warnings: string[]; model: string; createdAt: string; stale: boolean }
  WalkthroughDetail { scopeKind; scopeRef; savedAt: string; walkthrough: FnWalkthrough; notes: string[]; diagram: string | null; fresh: boolean; staleSummary: string | null; steps: Record<string, StepState>; files: Record<string, string[]>; questions: QuestionView[] }
  ```
- Produces: `walkthroughStatus(store, repoRoot, saved): Promise<WalkthroughStatus>`; `walkthroughStatuses(store, repoRoot): Promise<{ saved; savedAt: Date; status }[]>`; `describeStaleness(kind: ScopeKind, s: WalkthroughStatus): string`; `walkthroughNotes(saved): string[]`; `walkthroughList(store, repoRoot): Promise<WalkthroughListItem[]>`; `walkthroughDetail(store, repoRoot, kind, ref): Promise<WalkthroughDetail | null>`; `toQuestionView(q: QuestionRecord, stale: boolean): QuestionView`.

- [ ] **Step 1: Write the failing test**

Create `core/src/walkthrough/detail.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { indexRepo } from '../indexer/index.js';
import { openStore, type Store } from '../store/index.js';
import { ENDPOINT_REF, seedEndpointWalkthrough } from './__fixtures__/seed.js';
import { walkthroughDetail, walkthroughList } from './detail.js';
import type { SavedWalkthrough } from './saved.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;

describe('walkthroughList and walkthroughDetail', () => {
  let repo: string;
  let store: Store;
  let saved: SavedWalkthrough;
  const edit = async (file: string, from: string, to: string) => {
    const path = join(repo, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
    await indexRepo(repo, loadConfig(repo), store);
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-detail-'));
    cpSync(FIXTURE, repo, { recursive: true });
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_det_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    saved = await seedEndpointWalkthrough(store, repo);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('lists saved walkthroughs with their status', async () => {
    expect(await walkthroughList(store, repo)).toEqual([
      { scopeKind: 'endpoint', scopeRef: ENDPOINT_REF, title: 'How POST /api/patients/enroll works', savedAt: expect.any(String), fresh: true, staleSteps: 0, totalSteps: 9, staleSummary: null },
    ]);
  });

  it('returns the walkthrough with step states, cited file lines, notes and diagram', async () => {
    const detail = (await walkthroughDetail(store, repo, 'endpoint', ENDPOINT_REF))!;
    expect(Object.keys(detail.steps)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
    expect(Object.values(detail.steps).every((s) => s.fresh)).toBe(true);
    expect(detail.files['api/app.ts'][8]).toBe('  app.use(express.json());');
    expect(detail.notes).toContain('Route: POST /api/patients/enroll');
    expect(detail.diagram?.startsWith('sequenceDiagram')).toBe(true);
    expect(await walkthroughDetail(store, repo, 'endpoint', 'GET /nope')).toBeNull();
  });

  it('marks the walkthrough stale when a block changes, and a question stale when its step changes', async () => {
    await store.saveQuestion({
      scopeKind: 'endpoint', scopeRef: ENDPOINT_REF, stepId: 's7', question: 'Why a transaction?', stepHash: saved.sections[0].stepHashes.s7, model: 'm',
      answer: { answer: 'So both rows commit together.', references: [], warnings: [] },
    });
    await edit('api/repositories/patientRepository.ts', 'VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())');
    let detail = (await walkthroughDetail(store, repo, 'endpoint', ENDPOINT_REF))!;
    expect(detail.fresh).toBe(false);
    expect(detail.staleSummary).toContain('changed: insertConsent');
    expect(detail.questions.map((q) => `${q.stepId} ${q.stale}`)).toEqual(['s7 false']);

    await edit('api/services/enrollService.ts', "await client.query('BEGIN');", 'await client.query("BEGIN");');
    detail = (await walkthroughDetail(store, repo, 'endpoint', ENDPOINT_REF))!;
    expect(detail.steps.s7.fresh).toBe(false);
    expect(detail.questions.map((q) => `${q.stepId} ${q.stale}`)).toEqual(['s7 true']);
  });
});
```

Run: `pnpm vitest run core/src/walkthrough/detail.test.ts`
Expected: FAIL: cannot resolve `./detail.js`.

- [ ] **Step 2: Move staleness text and notes into core**

In `core/src/walkthrough/staleness.ts`, import `type ScopeKind` from `./saved.js`. Then move the body of the CLI's `staleDetail` here as:

```ts
/** One line describing why a walkthrough is stale, e.g. "1/9 steps stale · changed: insertConsent". */
export function describeStaleness(kind: ScopeKind, s: WalkthroughStatus): string {
  const label = (x: WalkthroughStatus['sections'][number]) => x.symbol ?? `${x.file} lines`;
  const changed = s.sections.filter((x) => x.state === 'changed').flatMap((x) => (x.changedBlocks?.length ? x.changedBlocks : [label(x)]));
  const removed = s.sections.filter((x) => x.state === 'missing').map(label);
  const parts = [`${s.staleSteps}/${s.totalSteps} steps stale`];
  if (s.fileRemoved) parts.push('file removed');
  if (s.routeRemoved) parts.push(kind === 'component' ? 'component removed' : kind === 'trace' ? 'trace removed' : 'route removed');
  if (s.chainChanged) parts.push(kind === 'component' ? 'structure changed' : kind === 'trace' ? 'trace changed' : 'middleware chain changed');
  if (changed.length) parts.push(`changed: ${changed.join(', ')}`);
  if (removed.length) parts.push(`removed: ${removed.join(', ')}`);
  if (s.uncovered.length) parts.push(`not covered: ${s.uncovered.join(', ')}`);
  return parts.join(' · ');
}
```

In `cli/src/ui/format.ts`, delete `staleDetail`, import `describeStaleness` from `@codewalk/core`, and call `describeStaleness(r.scopeKind, s)` where `staleDetail(r.scopeKind, s)` was.

In `core/src/walkthrough/saved.ts`, append:

```ts
/** The scope's overview as plain lines (file, endpoint, component or trace facts); none for `walk fn`. */
export function walkthroughNotes(saved: SavedWalkthrough): string[] {
  if (saved.overview) return overviewNotes(saved.overview);
  if (saved.endpoint) return endpointNotes(saved.endpoint);
  if (saved.component) return componentNotes(saved.component);
  if (saved.trace) return traceNotes(saved.trace);
  return [];
}
```

In `cli/src/ui/output.ts`, replace the `notes` conditional chain with `const notes = walkthroughNotes(saved);` (import it from `@codewalk/core`, and drop imports that are no longer used).

- [ ] **Step 3: Status helpers**

Create `core/src/walkthrough/status.ts`:

```ts
import { currentStructureHash } from '../context/component.js';
import { currentChainHash } from '../context/endpoint.js';
import { currentTraceHash } from '../context/trace.js';
import type { Store } from '../store/index.js';
import { listSavedWalkthroughs } from './persist.js';
import type { SavedWalkthrough } from './saved.js';
import { checkWalkthrough, filesOf, loadCurrentSource, type WalkthroughStatus } from './staleness.js';

// Fresh or stale against the current code (CLAUDE.md §9), for `walk list` and `walk serve`. The index
// must be current. Endpoint, component and trace walkthroughs also compare their structure hash.

export async function walkthroughStatus(store: Store, repoRoot: string, saved: SavedWalkthrough): Promise<WalkthroughStatus> {
  const source = await loadCurrentSource(store, repoRoot, filesOf(saved));
  const hash = await currentHashFor(store, repoRoot, saved);
  return checkWalkthrough(saved, source, () => hash);
}

export async function walkthroughStatuses(store: Store, repoRoot: string): Promise<{ saved: SavedWalkthrough; savedAt: Date; status: WalkthroughStatus }[]> {
  const entries = await listSavedWalkthroughs(store);
  const source = await loadCurrentSource(store, repoRoot, entries.flatMap((e) => filesOf(e.saved)));
  const out: { saved: SavedWalkthrough; savedAt: Date; status: WalkthroughStatus }[] = [];
  for (const entry of entries) {
    const hash = await currentHashFor(store, repoRoot, entry.saved);
    out.push({ ...entry, status: checkWalkthrough(entry.saved, source, () => hash) });
  }
  return out;
}

/** The current chain / structure / trace hash of a structural walkthrough; undefined for fn and file. */
async function currentHashFor(store: Store, repoRoot: string, saved: SavedWalkthrough): Promise<string | null | undefined> {
  const depth = saved.sections[0]?.depth;
  switch (saved.scopeKind) {
    case 'endpoint':
      return currentChainHash(store, saved.scopeRef);
    case 'component':
      return currentStructureHash(store, repoRoot, saved.scopeRef, depth ?? 2);
    case 'trace':
      return currentTraceHash(store, repoRoot, saved.scopeRef, depth ?? 3);
    default:
      return undefined;
  }
}
```

Replace the body of `runList` in `cli/src/commands/list.ts` between `await indexRepo(...)` and the `finally` with:

```ts
    rows = (await walkthroughStatuses(store, repo.repoRoot)).map(({ saved, savedAt, status }) => ({ scopeKind: saved.scopeKind, scopeRef: saved.scopeRef, savedAt, status }));
```

and reduce its core import to `import { indexRepo, walkthroughStatuses } from '@codewalk/core';`.

- [ ] **Step 4: The JSON view model**

Create `core/src/api.ts`:

```ts
import type { Reference } from './llm/schema.js';
import type { FnWalkthrough } from './walkthrough/fn.js';
import type { ScopeKind } from './walkthrough/saved.js';

// The JSON `walk serve` sends to the web UI. Types only: the web app imports these, never core's code.

export interface WalkthroughListItem {
  scopeKind: ScopeKind;
  scopeRef: string;
  title: string;
  /** ISO time the content last changed. */
  savedAt: string;
  fresh: boolean;
  staleSteps: number;
  totalSteps: number;
  /** describeStaleness, when stale. */
  staleSummary: string | null;
}

/** Where a step's lines are now (fresh) or were when explained (stale). */
export interface StepState {
  fresh: boolean;
  file: string;
  start: number;
  end: number;
}

export interface QuestionView {
  id: number;
  stepId: string;
  question: string;
  answer: string;
  references: Reference[];
  warnings: string[];
  model: string;
  createdAt: string;
  /** The step's code changed (or was re-explained) since the question was answered. */
  stale: boolean;
}

export interface WalkthroughDetail {
  scopeKind: ScopeKind;
  scopeRef: string;
  savedAt: string;
  /** Flattened: a file walkthrough's steps have ids "<symbol>/<id>". */
  walkthrough: FnWalkthrough;
  notes: string[];
  /** Mermaid source for endpoints and traces. */
  diagram: string | null;
  fresh: boolean;
  staleSummary: string | null;
  steps: Record<string, StepState>;
  /** Current lines of every file a step or reference cites (missing files are left out). */
  files: Record<string, string[]>;
  questions: QuestionView[];
}
```

Create `core/src/walkthrough/detail.ts`:

```ts
import type { QuestionView, StepState, WalkthroughDetail, WalkthroughListItem } from '../api.js';
import type { Store } from '../store/index.js';
import type { QuestionRecord } from '../store/types.js';
import { loadSavedWalkthrough } from './persist.js';
import { flattenWalkthrough, readLines, walkthroughNotes, type ScopeKind, type Section } from './saved.js';
import { describeStaleness } from './staleness.js';
import { walkthroughStatus, walkthroughStatuses } from './status.js';

// The view model `walk serve` returns. Built from the saved walkthrough, the current code and the index;
// the index must be current.

export async function walkthroughList(store: Store, repoRoot: string): Promise<WalkthroughListItem[]> {
  return (await walkthroughStatuses(store, repoRoot)).map(({ saved, savedAt, status }) => ({
    scopeKind: saved.scopeKind,
    scopeRef: saved.scopeRef,
    title: flattenWalkthrough(saved).title,
    savedAt: savedAt.toISOString(),
    fresh: status.fresh,
    staleSteps: status.staleSteps,
    totalSteps: status.totalSteps,
    staleSummary: status.fresh ? null : describeStaleness(saved.scopeKind, status),
  }));
}

export async function walkthroughDetail(store: Store, repoRoot: string, kind: ScopeKind, ref: string): Promise<WalkthroughDetail | null> {
  const [saved, record] = await Promise.all([loadSavedWalkthrough(store, kind, ref), store.getWalkthrough(kind, ref)]);
  if (!saved || !record) return null;
  const status = await walkthroughStatus(store, repoRoot, saved);
  const keyOf = (section: Section, id: string) => (saved.scopeKind === 'file' ? `${section.block.symbol ?? 'block'}/${id}` : id);

  const steps: Record<string, StepState> = {};
  saved.sections.forEach((section, i) => {
    for (const s of status.sections[i]?.steps ?? []) steps[keyOf(section, s.stepId)] = { fresh: s.fresh, file: s.file, start: s.start, end: s.end };
  });
  const walkthrough = flattenWalkthrough(saved);
  const cited = new Set(walkthrough.stages.flatMap((stage) => stage.steps.flatMap((s) => [s.code_ref.file, ...s.references.map((r) => r.file)])));
  const files = Object.fromEntries(
    [...cited].sort().flatMap((file) => {
      const lines = readLines(repoRoot, file);
      return lines ? [[file, lines] as const] : [];
    }),
  );
  const hashes = new Map(saved.sections.flatMap((section) => Object.entries(section.stepHashes).map(([id, hash]) => [keyOf(section, id), hash] as const)));
  const questions = (await store.listQuestions(kind, ref)).map((q) => toQuestionView(q, !(steps[q.stepId]?.fresh ?? false) || hashes.get(q.stepId) !== q.stepHash));

  return {
    scopeKind: kind,
    scopeRef: ref,
    savedAt: record.createdAt.toISOString(),
    walkthrough,
    notes: walkthroughNotes(saved),
    diagram: saved.endpoint?.diagram ?? saved.trace?.diagram ?? null,
    fresh: status.fresh,
    staleSummary: status.fresh ? null : describeStaleness(kind, status),
    steps,
    files,
    questions,
  };
}

export function toQuestionView(q: QuestionRecord, stale: boolean): QuestionView {
  return {
    id: q.id,
    stepId: q.stepId,
    question: q.question,
    answer: q.answer.answer,
    references: q.answer.references,
    warnings: q.answer.warnings,
    model: q.model,
    createdAt: q.createdAt.toISOString(),
    stale,
  };
}
```

In `core/src/walkthrough/index.ts`, append:

```ts
export { toQuestionView, walkthroughDetail, walkthroughList } from './detail.js';
export { walkthroughStatus, walkthroughStatuses } from './status.js';
```

In `core/src/index.ts`, append `export type * from './api.js';`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run core/src cli/src`
Expected: PASS (the `walk list` tests are unchanged after the refactor).

- [ ] **Step 6: Checkpoint**

Do not commit. `pnpm typecheck` is clean.

---

### Task 5: The local HTTP server

**Files:**
- Create: `cli/src/serve/server.ts`, `cli/src/serve/regenerate.ts`
- Test: `cli/src/serve/server.test.ts`

**Interfaces:**
- Consumes: `walkthroughList`, `walkthroughDetail`, `askQuestion`, `toQuestionView`, `loadSavedWalkthrough`, `indexRepo`, the error classes; `runFn`, `runFile`, `runEndpoint`, `runComponent`, `runTrace`.
- Produces: `createServeServer(ctx: ServeContext): http.Server`, with `ServeContext = { repoRoot: string; config: WalkConfig; store: Store; webRoot: string | null; provider?: LlmProvider }`; `regenerate(repoRoot, saved, deps: { provider?: LlmProvider }): Promise<{ code: number; errors: string[] }>`.

- [ ] **Step 1: Write the failing test**

Create `cli/src/serve/server.test.ts`:

```ts
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerSchema, CONFIG_FILE, loadConfig, openStore, type LlmProvider, type Store } from '@codewalk/core';
import { runEndpoint } from '../commands/endpoint.js';
import { createServeServer } from './server.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const ENDPOINT = readFileSync(new URL('../../../core/src/llm/__fixtures__/enrollEndpoint.response.json', import.meta.url), 'utf8');
const ANSWER = readFileSync(new URL('../../../core/src/llm/__fixtures__/enrollAnswer.response.json', import.meta.url), 'utf8');
const REF = 'POST /api/patients/enroll';

let walkthroughs = 0;
const provider: LlmProvider = {
  generate: async ({ schema }) => {
    if (schema === answerSchema) return ANSWER;
    walkthroughs++;
    return ENDPOINT;
  },
};
const quiet = { log: () => {}, error: () => {} };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function rawGet(base: string, path: string, host: string): Promise<number> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('walk serve HTTP server', () => {
  let repo: string;
  let schema: string;
  let webRoot: string;
  let store: Store;
  let server: Server;
  let base: string;
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'X-Codewalk': '1' }) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const detail = () => fetch(`${base}/api/walkthrough?kind=endpoint&ref=${encodeURIComponent(REF)}`);

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-serve-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_srv_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
    expect(await runEndpoint(repo, REF, { llm: true, depth: 3, out: 'json', refresh: false }, quiet, { provider, interactive: false })).toBe(0);

    webRoot = mkdtempSync(join(tmpdir(), 'cw-web-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), '<h1>ok</h1>');
    writeFileSync(join(webRoot, 'assets/app.js'), 'console.log(1);');

    store = await openStore({ url: DATABASE_URL, schema });
    server = createServeServer({ repoRoot: repo, config: loadConfig(repo), store, webRoot, provider });
    base = await listen(server);
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('lists saved walkthroughs', async () => {
    const res = await fetch(`${base}/api/walkthroughs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([expect.objectContaining({ scopeKind: 'endpoint', scopeRef: REF, fresh: true, totalSteps: 9 })]);
  });

  it('returns a walkthrough with code and diagram (Phase 6 acceptance)', async () => {
    const body = await (await detail()).json();
    expect(body.walkthrough.title).toBe('How POST /api/patients/enroll works');
    expect(body.files['api/app.ts'][8]).toBe('  app.use(express.json());');
    expect(body.diagram).toMatch(/^sequenceDiagram/);
    const missing = await fetch(`${base}/api/walkthrough?kind=endpoint&ref=${encodeURIComponent('GET /nope')}`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('No saved endpoint walkthrough GET /nope.');
  });

  it('answers, verifies and saves a question (Phase 6 acceptance)', async () => {
    const res = await post('/api/questions', { kind: 'endpoint', ref: REF, stepId: 's2', question: 'What happens when the session is missing?' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stepId: 's2',
      references: [{ file: 'api/middleware/auth.ts', line: 19, role: 'callee' }],
      warnings: ['Removed reference api/nowhere.ts:3: not part of the indexed context.'],
      stale: false,
    });
    expect((await (await detail()).json()).questions).toHaveLength(1);
  });

  it('refuses cross-site POSTs, foreign hosts and bad input', async () => {
    expect((await post('/api/questions', { kind: 'endpoint', ref: REF, stepId: 's2', question: 'x' }, {})).status).toBe(403);
    expect(await rawGet(base, '/api/walkthroughs', 'evil.example')).toBe(403);
    expect((await post('/api/questions', '{not json')).status).toBe(400);
    expect((await post('/api/questions', { kind: 'nope', ref: REF, stepId: 's2', question: 'x' })).status).toBe(400);
    expect((await post('/api/questions', { kind: 'endpoint', ref: REF, stepId: 's2', question: 'x'.repeat(70_000) })).status).toBe(413);
  });

  it('regenerates a stale walkthrough', async () => {
    const path = join(repo, 'api/repositories/patientRepository.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())'));
    expect((await (await detail()).json()).fresh).toBe(false);
    const before = walkthroughs;
    const res = await post('/api/regenerate', { kind: 'endpoint', ref: REF });
    expect(res.status).toBe(200);
    expect((await res.json()).fresh).toBe(true);
    expect(walkthroughs).toBe(before + 1);
  });

  it('serves the built app, and nothing outside it', async () => {
    const index = await fetch(`${base}/`);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await index.text()).toBe('<h1>ok</h1>');
    expect((await fetch(`${base}/assets/app.js`)).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await fetch(`${base}/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  });

  it('explains how to build the app when it is missing, while the API keeps working', async () => {
    const bare = createServeServer({ repoRoot: repo, config: loadConfig(repo), store, webRoot: null, provider });
    const url = await listen(bare);
    try {
      const res = await fetch(`${url}/`);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('pnpm --filter @codewalk/web build');
      expect((await fetch(`${url}/api/walkthroughs`)).status).toBe(200);
    } finally {
      bare.closeAllConnections();
      await new Promise((resolve) => bare.close(resolve));
    }
  });
});
```

Run: `pnpm vitest run cli/src/serve/server.test.ts`
Expected: FAIL: cannot resolve `./server.js`.

- [ ] **Step 2: Regeneration through the CLI commands**

Create `cli/src/serve/regenerate.ts`:

```ts
import type { LlmProvider, SavedWalkthrough } from '@codewalk/core';
import { runComponent } from '../commands/component.js';
import { runEndpoint } from '../commands/endpoint.js';
import { runFile } from '../commands/file.js';
import { runFn } from '../commands/fn.js';
import { runTrace } from '../commands/trace.js';

/**
 * Re-runs the command that made `saved`, with its depth and without --refresh: fresh sections are reused,
 * only stale code is re-explained. Returns the exit code and the command's error lines.
 */
export async function regenerate(repoRoot: string, saved: SavedWalkthrough, deps: { provider?: LlmProvider }): Promise<{ code: number; errors: string[] }> {
  const errors: string[] = [];
  const io = { log: () => {}, error: (line: string) => errors.push(line) };
  const options = { llm: true, depth: saved.sections[0]?.depth ?? 2, out: 'json' as const, refresh: false };
  const d = { provider: deps.provider, interactive: false };
  const ref = saved.scopeRef;
  let code: number;
  switch (saved.scopeKind) {
    case 'fn':
      code = await runFn(repoRoot, ref, options, io, d);
      break;
    case 'file':
      code = await runFile(repoRoot, ref, options, io, d);
      break;
    case 'endpoint':
      code = await runEndpoint(repoRoot, ref, options, io, d);
      break;
    case 'component':
      code = await runComponent(repoRoot, ref, options, io, d);
      break;
    case 'trace': {
      const [route, from] = ref.split(' <- ');
      code = await runTrace(repoRoot, route, { ...options, from }, io, d);
      break;
    }
  }
  return { code, errors: errors.filter((line) => line.startsWith('✖') || line.startsWith('  ')) };
}
```

- [ ] **Step 3: The server**

Create `cli/src/serve/server.ts`:

```ts
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import {
  AnthropicProvider,
  askQuestion,
  indexRepo,
  LlmOutputError,
  LlmRequestError,
  loadSavedWalkthrough,
  NoVerifiedStepsError,
  PinNeededError,
  TargetError,
  toQuestionView,
  walkthroughDetail,
  walkthroughList,
  type LlmProvider,
  type ScopeKind,
  type Store,
  type WalkConfig,
} from '@codewalk/core';
import { regenerate } from './regenerate.js';

// `walk serve` (CLAUDE.md §5): the JSON API and the built web app, for this machine only. Every request
// must name 127.0.0.1/localhost as its Host (blocks DNS rebinding); POSTs, which can spend LLM credits,
// also need `X-Codewalk: 1` and a JSON body, which a cross-site page can't send without a CORS preflight
// this server never answers.

export interface ServeContext {
  repoRoot: string;
  config: WalkConfig;
  store: Store;
  /** The built web app (web/dist); null when it hasn't been built. */
  webRoot: string | null;
  provider?: LlmProvider;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const KINDS: ReadonlySet<string> = new Set(['fn', 'file', 'endpoint', 'component', 'trace']);
const MAX_BODY = 64 * 1024;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>codewalk</title><h1>codewalk</h1>
<p>The web UI is not built yet. In the codewalk checkout run <code>pnpm --filter @codewalk/web build</code>, then restart <code>walk serve</code>.</p>`;

export function createServeServer(ctx: ServeContext): Server {
  let provider: LlmProvider | undefined = ctx.provider;
  const llm = () => (provider ??= new AnthropicProvider(ctx.config.llm.model));
  // Index passes and regenerations write to the same schema: run them one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };
  const reindex = () => exclusive(() => indexRepo(ctx.repoRoot, ctx.config, ctx.store));

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => sendError(res, err));
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { port } = server.address() as AddressInfo;
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, `Refusing a request for host "${host}"; open http://127.0.0.1:${port} instead.`);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, ctx.webRoot, url.pathname);

    if (req.method === 'POST') {
      if (req.headers['x-codewalk'] !== '1') throw new HttpError(403, 'POST requests need the header X-Codewalk: 1.');
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'POST requests must send JSON.');
    }

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/walkthroughs':
        await reindex();
        return sendJson(res, 200, await walkthroughList(ctx.store, ctx.repoRoot));
      case 'GET /api/walkthrough': {
        const { kind, ref } = scope(url.searchParams.get('kind'), url.searchParams.get('ref'));
        await reindex();
        const detail = await walkthroughDetail(ctx.store, ctx.repoRoot, kind, ref);
        if (!detail) throw new HttpError(404, `No saved ${kind} walkthrough ${ref}.`);
        return sendJson(res, 200, detail);
      }
      case 'POST /api/questions': {
        const body = await readJson(req);
        const { kind, ref } = scope(body.kind, body.ref);
        const stepId = field(body.stepId, 'stepId');
        const question = field(body.question, 'question');
        await reindex();
        const saved = await loadSavedWalkthrough(ctx.store, kind, ref);
        if (!saved) throw new HttpError(404, `No saved ${kind} walkthrough ${ref}.`);
        const record = await askQuestion(llm(), ctx.store, ctx.repoRoot, saved, stepId, question, {
          model: ctx.config.llm.model,
          maxContextTokens: ctx.config.llm.maxContextTokens,
        });
        return sendJson(res, 200, toQuestionView(record, false));
      }
      case 'POST /api/regenerate': {
        const body = await readJson(req);
        const { kind, ref } = scope(body.kind, body.ref);
        const saved = await loadSavedWalkthrough(ctx.store, kind, ref);
        if (!saved) throw new HttpError(404, `No saved ${kind} walkthrough ${ref}.`);
        const result = await exclusive(() => regenerate(ctx.repoRoot, saved, { provider }));
        if (result.code !== 0) throw new HttpError(502, result.errors.join('\n') || 'Regenerating the walkthrough failed.');
        await reindex();
        return sendJson(res, 200, await walkthroughDetail(ctx.store, ctx.repoRoot, kind, ref));
      }
      default:
        throw new HttpError(404, `No route ${req.method} ${url.pathname}.`);
    }
  };

  return server;
}

function scope(kind: unknown, ref: unknown): { kind: ScopeKind; ref: string } {
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw new HttpError(400, 'kind must be one of fn, file, endpoint, component, trace.');
  return { kind: kind as ScopeKind, ref: field(ref, 'ref') };
}

function field(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${name} is required.`);
  return value;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, `Request bodies are limited to ${MAX_BODY / 1024} KB.`);
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'The request body must be a JSON object.');
  }
}

function serveStatic(res: ServerResponse, webRoot: string | null, pathname: string): void {
  if (!webRoot) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(NOT_BUILT);
    return;
  }
  let relative: string;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    throw new HttpError(400, 'Malformed path.');
  }
  const root = resolve(webRoot);
  const file = resolve(root, relative);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'Not found.');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  createReadStream(file).pipe(res);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown): void {
  const status =
    err instanceof HttpError
      ? err.status
      : err instanceof PinNeededError
        ? 409
        : err instanceof TargetError
          ? 400
          : err instanceof LlmRequestError || err instanceof LlmOutputError || err instanceof NoVerifiedStepsError
            ? 502
            : 500;
  if (status === 500) console.error(err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, status, { error: status === 500 ? 'Internal error; see the walk serve output.' : (err as Error).message });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run cli/src/serve`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Do not commit. `pnpm typecheck` is clean.

---

### Task 6: `walk serve` command

**Files:**
- Create: `cli/src/commands/serve.ts`
- Modify: `cli/src/commands/shared.ts` (`findWebRoot`), `cli/src/index.ts`
- Test: `cli/src/commands/serve.test.ts`

**Interfaces:**
- Consumes: `createServeServer` (Task 5).
- Produces: `runServe(cwd, options: { port: number }, io, deps?: { provider?; webRoot?: string | null; onListening?: (url: string, server: Server) => void }): Promise<number>`, which resolves when the server closes; `findWebRoot(): string | null`.

- [ ] **Step 1: Write the failing test**

Create `cli/src/commands/serve.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, openStore } from '@codewalk/core';
import { runServe } from './serve.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;

describe('walk serve', () => {
  let repo: string;
  let schema: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-servecmd-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_srvc_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  });

  afterAll(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('indexes, serves the API on 127.0.0.1 and stops cleanly', async () => {
    const out: string[] = [];
    const err: string[] = [];
    let status = 0;
    const code = await runServe(repo, { port: 0 }, { log: (l) => out.push(l), error: (l) => err.push(l) }, {
      webRoot: null,
      onListening: async (url, server) => {
        status = (await fetch(`${url}/api/walkthroughs`)).status;
        server.closeAllConnections();
        server.close();
      },
    });
    expect(code).toBe(0);
    expect(status).toBe(200);
    expect(out.join('\n')).toMatch(/Serving walkthroughs of .* at http:\/\/127\.0\.0\.1:\d+/);
    expect(err.join('\n')).toContain('The web UI is not built');
  });

  it('exits 1 with advice when the port is taken', async () => {
    const busy: Server = createServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const { port } = busy.address() as AddressInfo;
    const err: string[] = [];
    try {
      expect(await runServe(repo, { port }, { log: () => {}, error: (l) => err.push(l) }, { webRoot: null })).toBe(1);
      expect(err.join('\n')).toContain(`Port ${port} is in use; pass --port <n>.`);
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });
});
```

Run: `pnpm vitest run cli/src/commands/serve.test.ts`
Expected: FAIL: cannot resolve `./serve.js`.

- [ ] **Step 2: Implement**

In `cli/src/commands/shared.ts`, add:

```ts
/** The built web app in this codewalk checkout (web/dist), or null when it hasn't been built. */
export function findWebRoot(): string | null {
  const root = codewalkRoot();
  const dir = root && join(root, 'web', 'dist');
  return dir && existsSync(join(dir, 'index.html')) ? dir : null;
}
```

Create `cli/src/commands/serve.ts`:

```ts
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { indexRepo, type LlmProvider } from '@codewalk/core';
import { createServeServer } from '../serve/server.js';
import { connectStore, findWebRoot, loadRepo, printIndexResult, type IO } from './shared.js';

export interface ServeOptions {
  port: number;
}

export interface ServeDeps {
  provider?: LlmProvider;
  /** Overrides web/dist discovery; null serves the API only. */
  webRoot?: string | null;
  /** Called once listening (tests use it to make requests and close the server). */
  onListening?: (url: string, server: Server) => void;
}

/** `walk serve`: runs until Ctrl-C (or until the server is closed). Returns an exit code. */
export async function runServe(cwd: string, options: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;
  try {
    await store.migrate();
    printIndexResult(await indexRepo(repo.repoRoot, repo.config, store), io);
    const webRoot = deps.webRoot !== undefined ? deps.webRoot : findWebRoot();
    if (!webRoot) io.error('! The web UI is not built: run `pnpm --filter @codewalk/web build` in the codewalk checkout. The API still works.');

    const server = createServeServer({ repoRoot: repo.repoRoot, config: repo.config, store, webRoot, provider: deps.provider });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, '127.0.0.1', () => resolve());
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        io.error(`✖ Port ${options.port} is in use; pass --port <n>.`);
        return 1;
      }
      throw err;
    }
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    io.log(`✔ Serving walkthroughs of ${repo.repoRoot} at ${url} (Ctrl-C to stop)`);
    const closed = new Promise<void>((resolve) => server.on('close', () => resolve()));
    const stop = () => {
      server.closeAllConnections();
      server.close();
    };
    process.once('SIGINT', stop);
    deps.onListening?.(url, server);
    await closed;
    process.off('SIGINT', stop);
    return 0;
  } finally {
    await store.close();
  }
}
```

In `cli/src/index.ts`, import `runServe, type ServeOptions` and register it before `list`:

```ts
program
  .command('serve')
  .description('open the local web UI for saved walkthroughs (127.0.0.1 only)')
  .option('--port <n>', 'port to listen on', parseDepth, 4321)
  .action(async (opts: ServeOptions) => {
    process.exitCode = await runServe(process.cwd(), opts, io);
  });
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm vitest run cli/src`
Expected: PASS.

- [ ] **Step 4: Checkpoint**

Do not commit. `pnpm typecheck` is clean.

---

### Task 7: Web app scaffold and the walkthrough list

**Files:**
- Rewrite: `web/package.json`, `web/tsconfig.json`; delete `web/src/index.ts`
- Create: `web/index.html`, `web/vite.config.ts`, `web/src/main.tsx`, `web/src/api.ts`, `web/src/route.ts`, `web/src/storage.ts`, `web/src/App.tsx`, `web/src/WalkthroughList.tsx`, `web/src/styles.css`, `web/src/__fixtures__/api.ts`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes (types only): `WalkthroughListItem`, `WalkthroughDetail`, `QuestionView`, `ScopeKind` from `@codewalk/core`.
- Produces: `Api { list(); detail(kind, ref); ask(kind, ref, stepId, question); regenerate(kind, ref) }`; `httpApi(base?)`; `parseHash(hash): Route`; `hrefFor(kind, ref)`; `PredictionStore { get(key); set(key, value) }`, `browserStorage()`, `memoryStorage()`; `App({ api, storage, renderDiagram? })`.

- [ ] **Step 1: Dependencies and config**

```bash
pnpm --filter @codewalk/web add react react-dom mermaid
pnpm --filter @codewalk/web add -D vite @vitejs/plugin-react @types/react @types/react-dom "@codewalk/core@workspace:*"
pnpm add -Dw jsdom @testing-library/react
rm web/src/index.ts
```

Then set `web/package.json`'s fields other than dependencies to:

```json
{
  "name": "@codewalk/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "typecheck": "tsc --noEmit"
  }
}
```

(Keep the `dependencies` and `devDependencies` that pnpm added; remove `main` and `types`.)

Replace `web/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "noEmit": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src", "vite.config.ts"]
}
```

Create `web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm --filter @codewalk/web dev` proxies the API to a running `walk serve` (default port).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:4321', changeOrigin: true } } },
});
```

Create `web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>codewalk</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the failing test and its fixtures**

Create `web/src/__fixtures__/api.ts`:

```ts
import type { QuestionView, WalkthroughDetail, WalkthroughListItem } from '@codewalk/core';
import { vi } from 'vitest';
import type { Api } from '../api';

const step = (id: string, file: string, start: number, end: number, explanation: string, extra: Partial<WalkthroughDetail['walkthrough']['stages'][number]['steps'][number]> = {}) => ({
  id,
  code_ref: { file, start, end },
  explanation,
  example: { input: `input ${id}`, state_after: `after ${id}` },
  references: [],
  docs: [],
  docLinks: [],
  concepts: ['middleware chain'],
  risks: [`risk ${id}`],
  ...extra,
});

export const detail: WalkthroughDetail = {
  scopeKind: 'endpoint',
  scopeRef: 'POST /api/patients/enroll',
  savedAt: '2026-10-10T10:00:00.000Z',
  walkthrough: {
    scope: { file: 'api/app.ts', start: 1, end: 4, symbol: 'POST /api/patients/enroll' },
    title: 'How POST /api/patients/enroll works',
    summary: 'Enrolls a patient.',
    stages: [
      {
        name: 'Request',
        steps: [
          step('s1', 'api/app.ts', 2, 3, '`express.json` parses the body.', {
            references: [{ file: 'api/routes.ts', line: 2, role: 'callee' }],
            docLinks: [{ package: 'express', symbol: 'express.json', version: '4.19.2', url: 'https://expressjs.com/en/api.html#express.json', source: 'curated' }],
          }),
        ],
      },
      { name: 'Persistence', steps: [step('s2', 'api/service.ts', 4, 4, 'Writes the patient.')] },
    ],
    unresolved: [],
    verification: { attempts: 1, keptSteps: 2, dropped: [], removedDocs: [] },
  },
  notes: ['Route: POST /api/patients/enroll'],
  diagram: 'sequenceDiagram\n  Client->>P1: POST /api/patients/enroll',
  fresh: false,
  staleSummary: '1/2 steps stale · changed: insertPatient',
  steps: {
    s1: { fresh: true, file: 'api/app.ts', start: 2, end: 3 },
    s2: { fresh: false, file: 'api/service.ts', start: 4, end: 4 },
  },
  files: {
    'api/app.ts': ['const app = express();', 'app.use(express.json());', "app.use('/api', apiRouter);", 'export default app;'],
    'api/routes.ts': ['const r = Router();', "r.use('/patients', patients);"],
    'api/service.ts': ['a', 'b', 'c', 'await insertPatient(client, row);', 'e'],
  },
  questions: [
    { id: 1, stepId: 's1', question: 'Why json?', answer: 'Because `express.json` parses bodies.', references: [], warnings: [], model: 'm', createdAt: '2026-10-10T10:01:00.000Z', stale: true },
  ],
};

export const listItems: WalkthroughListItem[] = [
  { scopeKind: 'endpoint', scopeRef: 'POST /api/patients/enroll', title: 'How POST /api/patients/enroll works', savedAt: '2026-10-10T10:00:00.000Z', fresh: false, staleSteps: 1, totalSteps: 2, staleSummary: '1/2 steps stale · changed: insertPatient' },
  { scopeKind: 'fn', scopeRef: 'api/a.ts#f', title: 'How f works', savedAt: '2026-10-09T09:00:00.000Z', fresh: true, staleSteps: 0, totalSteps: 3, staleSummary: null },
];

export const answer: QuestionView = {
  id: 2, stepId: 's1', question: 'What does it parse?', answer: 'It parses `JSON` bodies.', references: [{ file: 'api/app.ts', line: 2, role: 'callee' }],
  warnings: ['Removed reference x.ts:1: not part of the indexed context.'], model: 'm', createdAt: '2026-10-10T10:02:00.000Z', stale: false,
};

export function fakeApi(overrides: Partial<Api> = {}) {
  const api = {
    list: vi.fn(async () => listItems),
    detail: vi.fn(async () => detail),
    ask: vi.fn(async (_kind: string, _ref: string, stepId: string, question: string) => ({ ...answer, stepId, question })),
    regenerate: vi.fn(async () => ({ ...detail, fresh: true, staleSummary: null, steps: { ...detail.steps, s2: { ...detail.steps.s2, fresh: true } } })),
    ...overrides,
  };
  return api as typeof api & Api;
}

export const renderDiagram = async (source: string) => `<svg data-testid="diagram"><text>${source.split('\n')[0]}</text></svg>`;
```

Create `web/src/App.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { fakeApi, renderDiagram } from './__fixtures__/api';
import { hrefFor, parseHash } from './route';
import { memoryStorage } from './storage';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('routes', () => {
  it('round-trips a scope through the hash', () => {
    const href = hrefFor('trace', 'POST /api/x <- web/A.tsx#A');
    expect(href).toBe('#/w/trace/POST%20%2Fapi%2Fx%20%3C-%20web%2FA.tsx%23A');
    expect(parseHash(href)).toEqual({ page: 'walkthrough', kind: 'trace', ref: 'POST /api/x <- web/A.tsx#A' });
    expect(parseHash('#/w/nope/x')).toEqual({ page: 'list' });
    expect(parseHash('#/w/fn/%E0%A4%A')).toEqual({ page: 'list' });
  });
});

describe('walkthrough list', () => {
  const show = (api = fakeApi()) => render(<App api={api} storage={memoryStorage()} renderDiagram={renderDiagram} />);

  it('lists saved walkthroughs with their status and links to each', async () => {
    show();
    const link = await screen.findByRole('link', { name: 'How POST /api/patients/enroll works' });
    expect(link.getAttribute('href')).toBe('#/w/endpoint/POST%20%2Fapi%2Fpatients%2Fenroll');
    expect(screen.getByText('1/2 steps stale · changed: insertPatient')).toBeTruthy();
    expect(screen.getAllByText('stale')).toHaveLength(1);
    expect(screen.getAllByText('fresh')).toHaveLength(1);
  });

  it('explains how to create one when none are saved', async () => {
    show(fakeApi({ list: async () => [] }));
    expect(await screen.findByText(/No saved walkthroughs yet/)).toBeTruthy();
  });

  it('shows API errors', async () => {
    show(fakeApi({ list: async () => { throw new Error('Cannot connect to Postgres'); } }));
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot connect to Postgres');
  });
});
```

Run: `pnpm vitest run web/src`
Expected: FAIL: cannot resolve `./App`.

- [ ] **Step 3: Implement the scaffold and list**

Create `web/src/api.ts`:

```ts
import type { QuestionView, ScopeKind, WalkthroughDetail, WalkthroughListItem } from '@codewalk/core';

// The `walk serve` API. POSTs carry X-Codewalk: 1, which the server requires (a cross-site page can't send it).

export interface Api {
  list(): Promise<WalkthroughListItem[]>;
  detail(kind: ScopeKind, ref: string): Promise<WalkthroughDetail>;
  ask(kind: ScopeKind, ref: string, stepId: string, question: string): Promise<QuestionView>;
  regenerate(kind: ScopeKind, ref: string): Promise<WalkthroughDetail>;
}

export function httpApi(base = ''): Api {
  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}${path}`, init);
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    return body as T;
  };
  const post = <T,>(path: string, data: unknown) =>
    request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codewalk': '1' }, body: JSON.stringify(data) });
  const scope = (kind: string, ref: string) => `kind=${encodeURIComponent(kind)}&ref=${encodeURIComponent(ref)}`;
  return {
    list: () => request('/api/walkthroughs'),
    detail: (kind, ref) => request(`/api/walkthrough?${scope(kind, ref)}`),
    ask: (kind, ref, stepId, question) => post('/api/questions', { kind, ref, stepId, question }),
    regenerate: (kind, ref) => post('/api/regenerate', { kind, ref }),
  };
}
```

Create `web/src/route.ts`:

```ts
import type { ScopeKind } from '@codewalk/core';

export type Route = { page: 'list' } | { page: 'walkthrough'; kind: ScopeKind; ref: string };

const KINDS: readonly string[] = ['fn', 'file', 'endpoint', 'component', 'trace'];

export function parseHash(hash: string): Route {
  const m = /^#\/w\/([a-z]+)\/(.+)$/.exec(hash);
  if (m && KINDS.includes(m[1])) {
    try {
      return { page: 'walkthrough', kind: m[1] as ScopeKind, ref: decodeURIComponent(m[2]) };
    } catch {
      // A malformed link falls back to the list.
    }
  }
  return { page: 'list' };
}

export function hrefFor(kind: ScopeKind, ref: string): string {
  return `#/w/${kind}/${encodeURIComponent(ref)}`;
}
```

Create `web/src/storage.ts`:

```ts
// Where predictions live: this browser only (spec Decision 3). localStorage can throw (private mode,
// blocked site data), so every access is guarded and the page works without it.

export interface PredictionStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function browserStorage(): PredictionStore {
  return {
    get: (key) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Not persisted; the prediction still shows for this page view.
      }
    },
  };
}

export function memoryStorage(): PredictionStore {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => void values.set(key, value) };
}
```

Create `web/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { Api } from './api';
import { parseHash } from './route';
import type { PredictionStore } from './storage';
import { WalkthroughList } from './WalkthroughList';
import { WalkthroughView } from './WalkthroughView';

export interface AppProps {
  api: Api;
  storage: PredictionStore;
  /** Mermaid by default; tests pass a stub. */
  renderDiagram?: (source: string) => Promise<string>;
}

export function App({ api, storage, renderDiagram }: AppProps) {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const route = parseHash(hash);
  return (
    <div className="app">
      <header className="topbar">
        <a href="#/">codewalk</a>
      </header>
      <main>
        {route.page === 'list' ? (
          <WalkthroughList api={api} />
        ) : (
          <WalkthroughView key={`${route.kind}:${route.ref}`} api={api} kind={route.kind} scopeRef={route.ref} storage={storage} renderDiagram={renderDiagram} />
        )}
      </main>
    </div>
  );
}
```

Create a placeholder `web/src/WalkthroughView.tsx` (Task 8 replaces it):

```tsx
import type { ScopeKind } from '@codewalk/core';
import type { Api } from './api';
import type { PredictionStore } from './storage';

export interface WalkthroughViewProps {
  api: Api;
  kind: ScopeKind;
  scopeRef: string;
  storage: PredictionStore;
  renderDiagram?: (source: string) => Promise<string>;
}

export function WalkthroughView({ scopeRef }: WalkthroughViewProps) {
  return <p>{scopeRef}</p>;
}
```

Create `web/src/WalkthroughList.tsx`:

```tsx
import type { WalkthroughListItem } from '@codewalk/core';
import { useEffect, useState } from 'react';
import type { Api } from './api';
import { hrefFor } from './route';

export function WalkthroughList({ api }: { api: Api }) {
  const [items, setItems] = useState<WalkthroughListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.list().then(setItems, (e: Error) => setError(e.message));
  }, [api]);

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!items) return <p>Loading…</p>;
  if (items.length === 0) {
    return (
      <p className="empty">
        No saved walkthroughs yet. Create one with <code>walk fn</code>, <code>walk file</code>, <code>walk endpoint</code>, <code>walk component</code> or{' '}
        <code>walk trace</code>.
      </p>
    );
  }
  return (
    <table className="list">
      <thead>
        <tr>
          <th>Status</th>
          <th>Kind</th>
          <th>Walkthrough</th>
          <th>Steps</th>
          <th>Saved</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={`${item.scopeKind}:${item.scopeRef}`}>
            <td>
              <span className={`badge ${item.fresh ? 'fresh' : 'stale'}`}>{item.fresh ? 'fresh' : 'stale'}</span>
            </td>
            <td>{item.scopeKind}</td>
            <td>
              <a href={hrefFor(item.scopeKind, item.scopeRef)}>{item.title}</a>
              <div className="ref">{item.scopeRef}</div>
              {item.staleSummary && <div className="detail">{item.staleSummary}</div>}
            </td>
            <td>{item.totalSteps}</td>
            <td>{item.savedAt.slice(0, 16).replace('T', ' ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

Create `web/src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { httpApi } from './api';
import { browserStorage } from './storage';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App api={httpApi()} storage={browserStorage()} />);
```

Create `web/src/styles.css`:

```css
:root {
  --bg: #ffffff;
  --fg: #1d1f23;
  --muted: #6b7280;
  --line: #e5e7eb;
  --panel: #f7f7f8;
  --hl: #fff4c2;
  --accent: #2563eb;
  --fresh: #15803d;
  --stale: #b45309;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--fg);
  background: var(--bg);
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #15171b; --fg: #e6e6e6; --muted: #9ca3af; --line: #2b2f36; --panel: #1d2026; --hl: #4a3f12; --accent: #60a5fa; }
}
body { margin: 0; background: var(--bg); }
a { color: var(--accent); }
code, pre { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 0.9em; }
.topbar { padding: 10px 20px; border-bottom: 1px solid var(--line); font-weight: 600; }
.topbar a { text-decoration: none; color: var(--fg); }
main { padding: 16px 20px; max-width: 1400px; margin: 0 auto; }
.error { color: #dc2626; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.8em; border: 1px solid currentColor; }
.badge.fresh { color: var(--fresh); }
.badge.stale { color: var(--stale); }
.list { width: 100%; border-collapse: collapse; }
.list th, .list td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.ref, .detail { color: var(--muted); font-size: 0.85em; }
.stale-banner { margin: 8px 0; padding: 8px 12px; border: 1px solid var(--stale); border-radius: 6px; color: var(--stale); display: flex; gap: 12px; align-items: center; }
.toggle { display: inline-flex; gap: 6px; align-items: center; margin: 8px 0; }
.notes, .diagram { margin: 8px 0; }
.diagram svg { max-width: 100%; height: auto; }
.steps { display: flex; flex-wrap: wrap; gap: 4px; margin: 12px 0 4px; }
.steps button { min-width: 2.2em; }
.steps button[aria-current='step'] { background: var(--accent); color: white; border-color: var(--accent); }
.stepnav { display: flex; gap: 12px; align-items: center; margin: 8px 0; }
.columns { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 16px; }
@media (max-width: 900px) { .columns { grid-template-columns: 1fr; } }
.code { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow: auto; max-height: 75vh; }
.code-file { padding: 6px 10px; border-bottom: 1px solid var(--line); color: var(--muted); font-family: ui-monospace, monospace; font-size: 0.85em; }
.code pre { margin: 0; padding: 6px 0; }
.line { white-space: pre; padding: 0 10px; }
.line.dim { opacity: 0.45; }
.line.hl { background: var(--hl); }
.ln { display: inline-block; width: 3.5em; color: var(--muted); user-select: none; }
.step h3, .questions h3 { font-size: 0.95em; margin: 14px 0 6px; }
.example dt { font-weight: 600; }
.example dd { margin: 0 0 6px; }
.chips span { display: inline-block; margin: 2px 4px 2px 0; padding: 1px 8px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); font-size: 0.85em; }
button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button.link { border: none; background: none; color: var(--accent); padding: 0; text-decoration: underline; }
textarea { width: 100%; min-height: 4.5em; font: inherit; box-sizing: border-box; padding: 6px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
.predict, .qa { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
.warning { color: var(--stale); font-size: 0.85em; }
```

- [ ] **Step 4: Run tests and the build**

Run: `pnpm vitest run web/src && pnpm --filter @codewalk/web build`
Expected: tests PASS, and Vite writes `web/dist/index.html` plus assets.

- [ ] **Step 5: Checkpoint**

Do not commit. `pnpm typecheck` is clean. If `tsc` in `web/` can't resolve `@codewalk/core`'s types, run `pnpm --filter @codewalk/core build` first (the root `typecheck` script does). `web/dist` is covered by the existing `**/dist/**` ignore. Confirm with `git status`.

---

### Task 8: The walkthrough reader

**Files:**
- Rewrite: `web/src/WalkthroughView.tsx`
- Create: `web/src/CodePanel.tsx`, `web/src/StepPanel.tsx`, `web/src/Diagram.tsx`, `web/src/Inline.tsx`, `web/src/QuestionPanel.tsx` (a minimal version here; Task 9 fills it in)
- Test: `web/src/WalkthroughView.test.tsx`

**Interfaces:**
- Produces: `CodePanel({ files, file, start, end })`; `StepPanel({ step, state, predict, predictionKey, storage, onReference })`; `Diagram({ source, render? })` plus `renderMermaid(source)`; `Inline({ text })`; `QuestionPanel({ api, kind, scopeRef, stepId, questions, onAsked })`.

- [ ] **Step 1: Write the failing test**

Create `web/src/WalkthroughView.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { fakeApi, renderDiagram } from './__fixtures__/api';
import { memoryStorage } from './storage';

const highlighted = (container: HTMLElement) => [...container.querySelectorAll('.line.hl')].map((l) => l.getAttribute('data-line'));

beforeEach(() => {
  window.location.hash = '#/w/endpoint/POST%20%2Fapi%2Fpatients%2Fenroll';
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('walkthrough reader', () => {
  const show = (api = fakeApi()) => ({ api, ...render(<App api={api} storage={memoryStorage()} renderDiagram={renderDiagram} />) });

  it('shows the first step: code highlighted on the left, explanation on the right (Phase 6 acceptance)', async () => {
    const { api, container } = show();
    expect(await screen.findByRole('heading', { name: 'How POST /api/patients/enroll works' })).toBeTruthy();
    expect(api.detail).toHaveBeenCalledWith('endpoint', 'POST /api/patients/enroll');
    expect(screen.getByText('api/app.ts:2-3')).toBeTruthy();
    expect(highlighted(container)).toEqual(['2', '3']);
    expect(container.querySelectorAll('.line.dim')).toHaveLength(2);
    expect(screen.getByText('express.json', { selector: 'code' })).toBeTruthy();
    expect(screen.getByText('input s1')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'express express.json' }).getAttribute('href')).toBe('https://expressjs.com/en/api.html#express.json');
    expect(await screen.findByTestId('diagram')).toBeTruthy();
  });

  it('moves between steps with the buttons and the arrow keys, and marks stale steps', async () => {
    const { container } = show();
    await screen.findByText('Step 1 of 2 · Request');
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    expect(screen.getByText('Step 2 of 2 · Persistence')).toBeTruthy();
    expect(highlighted(container)).toEqual(['4']);
    expect(screen.getByText("This step's code changed since it was explained.")).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('Step 1 of 2 · Request')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(screen.getByText('Step 2 of 2 · Persistence')).toBeTruthy();
  });

  it('shows a referenced line when its reference is clicked', async () => {
    const { container } = show();
    fireEvent.click(await screen.findByRole('button', { name: 'callee api/routes.ts:2' }));
    expect(screen.getByText('api/routes.ts:2')).toBeTruthy();
    expect(highlighted(container)).toEqual(['2']);
  });

  it('regenerates a stale walkthrough from the banner', async () => {
    const { api } = show();
    expect(await screen.findByText(/1\/2 steps stale · changed: insertPatient/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(api.regenerate).toHaveBeenCalledWith('endpoint', 'POST /api/patients/enroll');
    await screen.findByText('Step 1 of 2 · Request');
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
  });

  it('reports a walkthrough that cannot be loaded', async () => {
    show(fakeApi({ detail: async () => { throw new Error('No saved endpoint walkthrough POST /x.'); } }));
    expect((await screen.findByRole('alert')).textContent).toBe('No saved endpoint walkthrough POST /x.');
  });
});
```

Run: `pnpm vitest run web/src/WalkthroughView.test.tsx`
Expected: FAIL: the placeholder view renders only the ref.

- [ ] **Step 2: Implement the components**

Create `web/src/Inline.tsx`:

```tsx
/** Text with `backticked` spans as code (the LLM is told to backtick every identifier). */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}
    </>
  );
}
```

Create `web/src/CodePanel.tsx`:

```tsx
import { useEffect, useRef } from 'react';

const CONTEXT = 6;

/** The step's lines highlighted, with a few dimmed lines around them (CLAUDE.md §6.1 item 1). */
export function CodePanel({ files, file, start, end }: { files: Record<string, string[]>; file: string; start: number; end: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('.hl')?.scrollIntoView?.({ block: 'center' });
  }, [file, start, end]);

  const lines = files[file];
  const label = `${file}:${start}${end !== start ? `-${end}` : ''}`;
  if (!lines) {
    return (
      <div className="code">
        <div className="code-file">{label}</div>
        <p className="error">This file is no longer in the repository.</p>
      </div>
    );
  }
  const from = Math.max(1, start - CONTEXT);
  const to = Math.min(lines.length, end + CONTEXT);
  return (
    <div className="code" ref={ref}>
      <div className="code-file">{label}</div>
      <pre>
        {lines.slice(from - 1, to).map((text, i) => {
          const n = from + i;
          return (
            <div key={n} className={n >= start && n <= end ? 'line hl' : 'line dim'} data-line={n}>
              <span className="ln">{n}</span>
              {text || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
```

Create `web/src/Diagram.tsx`:

```tsx
import { useEffect, useState } from 'react';

let counter = 0;

/** Renders Mermaid in strict mode (labels come from code, so no HTML or scripts are allowed through). */
export async function renderMermaid(source: string): Promise<string> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  const { svg } = await mermaid.render(`codewalk-diagram-${++counter}`, source);
  return svg;
}

export function Diagram({ source, render = renderMermaid }: { source: string; render?: (source: string) => Promise<string> }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    render(source).then(
      (out) => live && setSvg(out),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [source, render]);
  return (
    <details className="diagram" open>
      <summary>Sequence diagram</summary>
      {failed ? <pre>{source}</pre> : svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <p>Rendering…</p>}
    </details>
  );
}
```

Create `web/src/StepPanel.tsx` (predict mode is added in Task 9; the props are already in place):

```tsx
import type { StepState, WalkthroughDetail } from '@codewalk/core';
import { Inline } from './Inline';
import type { PredictionStore } from './storage';

export type Step = WalkthroughDetail['walkthrough']['stages'][number]['steps'][number];

export interface StepPanelProps {
  step: Step;
  state: StepState | undefined;
  predict: boolean;
  predictionKey: string;
  storage: PredictionStore;
  onReference: (file: string, line: number) => void;
}

export function StepPanel({ step, state, onReference }: StepPanelProps) {
  return (
    <section className="step" aria-label="Explanation">
      {state && !state.fresh && <p className="badge stale">This step's code changed since it was explained.</p>}
      <Explanation step={step} onReference={onReference} />
    </section>
  );
}

export function Explanation({ step, onReference }: { step: Step; onReference: (file: string, line: number) => void }) {
  return (
    <>
      <p className="explanation">
        <Inline text={step.explanation} />
      </p>
      <dl className="example">
        <dt>Example</dt>
        <dd>{step.example.input}</dd>
        <dt>After this step</dt>
        <dd>{step.example.state_after}</dd>
      </dl>
      {step.references.length > 0 && (
        <>
          <h3>References</h3>
          <ul>
            {step.references.map((r) => (
              <li key={`${r.file}:${r.line}:${r.role}`}>
                <button className="link" onClick={() => onReference(r.file, r.line)}>
                  {r.role} {r.file}:{r.line}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {step.docLinks.length > 0 && (
        <>
          <h3>Docs</h3>
          <ul>
            {step.docLinks.map((d) => (
              <li key={`${d.package}:${d.symbol}`}>
                <a href={d.url} target="_blank" rel="noreferrer">
                  {d.package} {d.symbol}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      {step.concepts.length > 0 && (
        <p className="chips">
          {step.concepts.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </p>
      )}
      {step.risks.length > 0 && (
        <>
          <h3>What can go wrong</h3>
          <ul>
            {step.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
```

Create a minimal `web/src/QuestionPanel.tsx` (Task 9 completes it):

```tsx
import type { QuestionView, ScopeKind } from '@codewalk/core';
import type { Api } from './api';

export interface QuestionPanelProps {
  api: Api;
  kind: ScopeKind;
  scopeRef: string;
  stepId: string;
  questions: QuestionView[];
  onAsked: (question: QuestionView) => void;
}

export function QuestionPanel(_props: QuestionPanelProps) {
  return null;
}
```

Replace `web/src/WalkthroughView.tsx`:

```tsx
import type { QuestionView, ScopeKind, WalkthroughDetail } from '@codewalk/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Api } from './api';
import { CodePanel } from './CodePanel';
import { Diagram } from './Diagram';
import { QuestionPanel } from './QuestionPanel';
import { StepPanel } from './StepPanel';
import type { PredictionStore } from './storage';

export interface WalkthroughViewProps {
  api: Api;
  kind: ScopeKind;
  scopeRef: string;
  storage: PredictionStore;
  renderDiagram?: (source: string) => Promise<string>;
}

export function WalkthroughView({ api, kind, scopeRef, storage, renderDiagram }: WalkthroughViewProps) {
  const [detail, setDetail] = useState<WalkthroughDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [focus, setFocus] = useState<{ file: string; line: number } | null>(null);
  const [predict, setPredict] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [asked, setAsked] = useState<QuestionView[]>([]);

  useEffect(() => {
    api.detail(kind, scopeRef).then(setDetail, (e: Error) => setError(e.message));
  }, [api, kind, scopeRef]);

  const steps = useMemo(() => (detail ? detail.walkthrough.stages.flatMap((stage) => stage.steps.map((step) => ({ stage: stage.name, step }))) : []), [detail]);
  const go = useCallback(
    (i: number) => {
      setIndex(Math.max(0, Math.min(steps.length - 1, i)));
      setFocus(null);
    },
    [steps.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
      if (e.key === 'ArrowRight') go(index + 1);
      if (e.key === 'ArrowLeft') go(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index]);

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!detail) return <p>Loading…</p>;

  const regenerate = async () => {
    setRegenerating(true);
    setError(null);
    try {
      setDetail(await api.regenerate(kind, scopeRef));
      setAsked([]);
      go(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRegenerating(false);
    }
  };

  const w = detail.walkthrough;
  const current = steps[index];
  const state = current ? detail.steps[current.step.id] : undefined;
  const codeAt = focus
    ? { file: focus.file, start: focus.line, end: focus.line }
    : current
      ? { file: state?.file ?? current.step.code_ref.file, start: state?.start ?? current.step.code_ref.start, end: state?.end ?? current.step.code_ref.end }
      : null;

  return (
    <div className="walkthrough">
      <header>
        <h1>{w.title}</h1>
        <div className="ref">
          {kind} · {scopeRef}
        </div>
        <p>{w.summary}</p>
        {!detail.fresh && (
          <div className="stale-banner">
            <span>Stale: {detail.staleSummary}</span>
            <button onClick={regenerate} disabled={regenerating}>
              {regenerating ? 'Regenerating…' : 'Regenerate'}
            </button>
          </div>
        )}
        <label className="toggle">
          <input type="checkbox" checked={predict} onChange={(e) => setPredict(e.target.checked)} /> Predict first, then reveal
        </label>
        {detail.notes.length > 0 && (
          <details className="notes">
            <summary>Facts from the index</summary>
            <ul>
              {detail.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        )}
        {detail.diagram && <Diagram source={detail.diagram} render={renderDiagram} />}
      </header>

      {current && codeAt ? (
        <>
          <nav className="steps" aria-label="Steps">
            {steps.map((s, i) => (
              <button key={s.step.id} aria-current={i === index ? 'step' : undefined} title={s.stage} onClick={() => go(i)}>
                {i + 1}
              </button>
            ))}
          </nav>
          <div className="stepnav">
            <button onClick={() => go(index - 1)} disabled={index === 0}>
              ← Prev
            </button>
            <span>
              Step {index + 1} of {steps.length} · {current.stage}
            </span>
            <button onClick={() => go(index + 1)} disabled={index === steps.length - 1}>
              Next →
            </button>
          </div>
          <div className="columns">
            <CodePanel files={detail.files} file={codeAt.file} start={codeAt.start} end={codeAt.end} />
            <div>
              <StepPanel
                key={current.step.id}
                step={current.step}
                state={state}
                predict={predict}
                predictionKey={`codewalk:predict:${kind}:${scopeRef}:${current.step.id}`}
                storage={storage}
                onReference={(file, line) => setFocus({ file, line })}
              />
              <QuestionPanel
                key={`q:${current.step.id}`}
                api={api}
                kind={kind}
                scopeRef={scopeRef}
                stepId={current.step.id}
                questions={[...detail.questions, ...asked].filter((q) => q.stepId === current.step.id)}
                onAsked={(q) => setAsked((list) => [...list, q])}
              />
            </div>
          </div>
        </>
      ) : (
        <p>This walkthrough has no steps.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm vitest run web/src`
Expected: PASS.

- [ ] **Step 4: Checkpoint**

Do not commit. `pnpm typecheck` is clean and `pnpm --filter @codewalk/web build` succeeds.

---

### Task 9: Q&A panel and predict mode

**Files:**
- Rewrite: `web/src/QuestionPanel.tsx`
- Modify: `web/src/StepPanel.tsx`
- Test: `web/src/StepPanel.test.tsx`

**Interfaces:**
- Produces: the finished `QuestionPanel` and predict mode in `StepPanel`. Predictions are stored under `predictionKey`, and revealed state under `${predictionKey}:revealed`.

- [ ] **Step 1: Write the failing test**

Create `web/src/StepPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { fakeApi, renderDiagram } from './__fixtures__/api';
import { memoryStorage, type PredictionStore } from './storage';

beforeEach(() => {
  window.location.hash = '#/w/endpoint/POST%20%2Fapi%2Fpatients%2Fenroll';
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

const show = (api = fakeApi(), storage: PredictionStore = memoryStorage()) => ({ api, storage, ...render(<App api={api} storage={storage} renderDiagram={renderDiagram} />) });

describe('questions', () => {
  it('shows saved answers, marking stale ones', async () => {
    show();
    expect(await screen.findByText('Why json?')).toBeTruthy();
    expect(screen.getByText('stale', { selector: '.qa .badge' })).toBeTruthy();
  });

  it('asks about the current step and shows the verified answer with its warnings (Phase 6 acceptance)', async () => {
    const { api } = show();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'What does it parse?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('JSON', { selector: '.qa code' })).toBeTruthy();
    expect(api.ask).toHaveBeenCalledWith('endpoint', 'POST /api/patients/enroll', 's1', 'What does it parse?');
    expect(screen.getByText('api/app.ts:2')).toBeTruthy();
    expect(screen.getByText(/Removed reference x\.ts:1/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('shows why a question failed', async () => {
    show(fakeApi({ ask: async () => { throw new Error('The model returned invalid output 3 times.'); } }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'Why?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The model returned invalid output 3 times.');
  });

  it('does not change steps while typing a question', async () => {
    show();
    const box = await screen.findByRole('textbox', { name: 'Question' });
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(screen.getByText('Step 1 of 2 · Request')).toBeTruthy();
  });
});

describe('predict first, then reveal', () => {
  it('hides the explanation until a prediction is written and revealed, and remembers it (Phase 6 acceptance)', async () => {
    const { storage } = show();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Predict first, then reveal/ }));
    expect(screen.queryByText('express.json', { selector: '.explanation code' })).toBeNull();
    const reveal = screen.getByRole('button', { name: 'Reveal' }) as HTMLButtonElement;
    expect(reveal.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Your prediction: what do these lines do?' }), { target: { value: 'It parses JSON.' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your prediction: what do these lines do?' }), { key: 'ArrowRight' });
    expect(screen.getByText('Step 1 of 2 · Request')).toBeTruthy();
    fireEvent.click(reveal);
    expect(screen.getByText('express.json', { selector: '.explanation code' })).toBeTruthy();
    expect(storage.get('codewalk:predict:endpoint:POST /api/patients/enroll:s1')).toBe('It parses JSON.');

    cleanup();
    show(fakeApi(), storage);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Predict first, then reveal/ }));
    expect(screen.getByText('express.json', { selector: '.explanation code' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Your prediction: what do these lines do?' }) as HTMLTextAreaElement).value).toBe('It parses JSON.');
  });
});
```

Run: `pnpm vitest run web/src/StepPanel.test.tsx`
Expected: FAIL: no question box, no Reveal button.

- [ ] **Step 2: Implement**

Replace `web/src/QuestionPanel.tsx`:

```tsx
import type { QuestionView, ScopeKind } from '@codewalk/core';
import { useState, type FormEvent } from 'react';
import type { Api } from './api';
import { Inline } from './Inline';

export interface QuestionPanelProps {
  api: Api;
  kind: ScopeKind;
  scopeRef: string;
  stepId: string;
  questions: QuestionView[];
  onAsked: (question: QuestionView) => void;
}

/** Questions on this step, answered from the index's facts and verified like steps (spec Decision 1). */
export function QuestionPanel({ api, kind, scopeRef, stepId, questions, onAsked }: QuestionPanelProps) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const question = text.trim();
    if (!question) return;
    setPending(true);
    setError(null);
    try {
      onAsked(await api.ask(kind, scopeRef, stepId, question));
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="questions" aria-label="Questions">
      <h3>Ask about this step</h3>
      {questions.map((q) => (
        <div key={q.id} className="qa">
          <p>
            <strong>Q:</strong> {q.question} {q.stale && <span className="badge stale">stale</span>}
          </p>
          <p>
            <strong>A:</strong> <Inline text={q.answer} />
          </p>
          {q.references.length > 0 && <p className="ref">{q.references.map((r) => `${r.file}:${r.line}`).join(', ')}</p>}
          {q.warnings.map((w) => (
            <p key={w} className="warning">
              ⚠ {w}
            </p>
          ))}
        </div>
      ))}
      <form onSubmit={ask}>
        <textarea aria-label="Question" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. What happens if the session is missing?" />
        <button type="submit" disabled={pending || text.trim() === ''}>
          {pending ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
```

In `web/src/StepPanel.tsx`, add `import { useState } from 'react';` and replace `StepPanel` with:

```tsx
export function StepPanel({ step, state, predict, predictionKey, storage, onReference }: StepPanelProps) {
  const [prediction, setPrediction] = useState(() => storage.get(predictionKey) ?? '');
  const [revealed, setRevealed] = useState(() => storage.get(`${predictionKey}:revealed`) === '1');
  const hidden = predict && !revealed;
  return (
    <section className="step" aria-label="Explanation">
      {state && !state.fresh && <p className="badge stale">This step's code changed since it was explained.</p>}
      {predict && (
        <div className="predict">
          <label htmlFor={`prediction-${step.id}`}>Your prediction: what do these lines do?</label>
          <textarea
            id={`prediction-${step.id}`}
            value={prediction}
            readOnly={revealed}
            onChange={(e) => {
              setPrediction(e.target.value);
              storage.set(predictionKey, e.target.value);
            }}
          />
          {!revealed && (
            <button
              disabled={prediction.trim() === ''}
              onClick={() => {
                setRevealed(true);
                storage.set(`${predictionKey}:revealed`, '1');
              }}
            >
              Reveal
            </button>
          )}
        </div>
      )}
      {!hidden && <Explanation step={step} onReference={onReference} />}
    </section>
  );
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm vitest run web/src`
Expected: PASS.

- [ ] **Step 4: Full verification and a manual run**

Run: `pnpm test && pnpm typecheck && pnpm --filter @codewalk/web build`
Expected: everything passes; `web/dist/index.html` exists.

Then a manual check on the fixture. It needs a saved walkthrough, so run once with a real model, or reuse one saved by an earlier phase's manual run:

```bash
cd fixture && ../node_modules/.bin/tsx ../cli/src/index.ts serve --port 4321 &
sleep 3
curl -s http://127.0.0.1:4321/ | head -5
curl -s http://127.0.0.1:4321/api/walkthroughs
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4321/api/questions -H 'Content-Type: application/json' -d '{}'
kill %1
```

Expected: the HTML of the app; a JSON list (`[]` if nothing is saved); `403` for the POST without `X-Codewalk`. If a walkthrough exists, open http://127.0.0.1:4321 in a browser, step through it, and try predict mode.

- [ ] **Step 5: Checkpoint (end of Phase 6)**

Do not commit. Stop for review (CLAUDE.md §12, §15): report the test counts against the baseline and the manual-run results.

---

## Self-review notes

- **Spec coverage:** §1 → Task 1; §2 → Task 2; §3 → Tasks 3–4; §4 → Tasks 5–6; §5 → Tasks 7–9; §6 is spread across all tasks.
- **Type consistency:** step ids are flattened everywhere (`locateStep`, `walkthroughDetail.steps`, `QuestionRecord.stepId`, Markdown). `QuestionView` comes only from `toQuestionView`. The web app uses only `import type` from core.
- **Known limits:** no syntax highlighting (line highlighting only); answers aren't streamed; regeneration runs one at a time; predictions are per browser.
