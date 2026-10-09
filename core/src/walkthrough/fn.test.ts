import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildFnContext, type FnContext } from '../context/fn.js';
import { parseFnTarget } from '../context/target.js';
import { indexRepo } from '../indexer/index.js';
import { LlmOutputError, type LlmMessage, type LlmProvider } from '../llm/generate.js';
import type { Walkthrough } from '../llm/schema.js';
import { openStore, type Store } from '../store/index.js';
import { explainFn, NoVerifiedStepsError } from './fn.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
// A real claude-sonnet-5 response for fixture enrollService.ts#enrollPatient, recorded once.
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollPatient.response.json', import.meta.url), 'utf8');

/** Replays responses in order and remembers what it was sent. */
function replay(...responses: string[]) {
  const requests: LlmMessage[][] = [];
  const provider: LlmProvider = {
    generate: async ({ messages }) => {
      requests.push([...messages]);
      const next = responses.shift();
      if (next === undefined) throw new Error('no more recorded responses');
      return next;
    },
  };
  return { provider, requests };
}

const recorded = (): Walkthrough => JSON.parse(RECORDED);

describe('explainFn on the fixture with a recorded response', () => {
  let store: Store;
  let ctx: FnContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_fn_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildFnContext(store, FIXTURE, parseFnTarget('api/services/enrollService.ts#enrollPatient'), { depth: 2, maxContextTokens: 60000 });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('keeps every grounded step and resolves docs links', async () => {
    const w = await explainFn(replay(RECORDED).provider, ctx, FIXTURE);

    expect(w.scope).toEqual({ file: 'api/services/enrollService.ts', start: 35, end: 69, symbol: 'enrollPatient' });
    expect(w.verification).toMatchObject({ attempts: 1, keptSteps: 13, dropped: [], removedDocs: [] });

    const links = w.stages.flatMap((s) => s.steps.flatMap((step) => step.docLinks.map((d) => `${d.symbol} ${d.url}`)));
    expect(links).toContain('redis.set https://redis.io/docs/latest/commands/set/');
    expect(links).toContain('Pool.connect https://node-postgres.com/apis/pool');

    expect(w.unresolved).toContain('unresolved: likely bus.emit (dynamic call in enrollPatient at api/services/enrollService.ts:61)');
  });

  it('traces one worked example: the normalized phone and age match the code', async () => {
    const w = await explainFn(replay(RECORDED).provider, ctx, FIXTURE);
    const first = w.stages[0].steps[0];
    // normalizePhone("(555) 123-4567") keeps the last 10 digits; calculateAge("1990-05-01") on 2024-06-01 is 34.
    expect(first.example.input).toContain("phone: '(555) 123-4567'");
    expect(first.example.state_after).toContain("phone = '5551234567'");
    expect(first.example.state_after).toContain('age = 34');
  });

  it('drops a step that cites lines past the end of the file', async () => {
    const tampered = recorded();
    tampered.stages[0].steps[0].code_ref.end = 999;
    const w = await explainFn(replay(JSON.stringify(tampered)).provider, ctx, FIXTURE);
    expect(w.verification.keptSteps).toBe(12);
    expect(w.verification.dropped).toEqual([
      { stepId: tampered.stages[0].steps[0].id, reasons: [expect.stringContaining('is outside the file')] },
    ]);
  });

  it('drops a step that names an invented symbol', async () => {
    const tampered = recorded();
    tampered.stages[0].steps[0].explanation += ' It then calls `auditTrail.record(phone)`.';
    const w = await explainFn(replay(JSON.stringify(tampered)).provider, ctx, FIXTURE);
    expect(w.verification.dropped[0].reasons[0]).toMatch(/`auditTrail`, `record`/);
  });

  it('re-requests schema-invalid output with the problem, then succeeds', async () => {
    const missingSummary = JSON.stringify({ ...recorded(), summary: undefined });
    const { provider, requests } = replay('not json', missingSummary, RECORDED);
    const w = await explainFn(provider, ctx, FIXTURE);

    expect(w.verification.attempts).toBe(3);
    expect(requests[1].at(-1)?.content).toMatch(/Not valid JSON/);
    expect(requests[2].at(-1)?.content).toMatch(/summary/);
  });

  it('gives up after two retries', async () => {
    await expect(explainFn(replay('{}', '{}', '{}').provider, ctx, FIXTURE)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it('fails when no step survives verification', async () => {
    const tampered = recorded();
    for (const stage of tampered.stages) for (const step of stage.steps) step.code_ref.file = 'api/invented.ts';
    await expect(explainFn(replay(JSON.stringify(tampered)).provider, ctx, FIXTURE)).rejects.toBeInstanceOf(NoVerifiedStepsError);
  });
});
