import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildTraceContext, type TraceContext } from '../context/trace.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmMessage, LlmProvider } from '../llm/generate.js';
import { openStore, type Store } from '../store/index.js';
import { explainTrace } from './trace.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollTrace.response.json', import.meta.url), 'utf8');

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

describe('explainTrace on the fixture', () => {
  let store: Store;
  let ctx: TraceContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_trw_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildTraceContext(store, FIXTURE, { endpoint: { method: 'POST', path: '/api/patients/enroll' }, from: null }, { depth: 3, maxContextTokens: 60000 });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('keeps every grounded step across both stacks, in the fixed stage order (Phase 5 acceptance)', async () => {
    const { provider, requests } = replay(RECORDED);
    const w = await explainTrace(provider, ctx, FIXTURE);
    expect(w.verification.dropped).toEqual([]);
    expect(w.verification.keptSteps).toBe(9);
    expect(w.stages.map((s) => s.name)).toEqual(['UI trigger', 'Request', 'Server', 'Persistence', 'Response', 'UI update']);
    expect(w.scope).toEqual({ file: 'web/components/EnrollForm.tsx', start: 18, end: 54, symbol: 'POST /api/patients/enroll <- web/components/EnrollForm.tsx#EnrollForm' });
    expect(w.stages[1].steps[1].docLinks[0]).toMatchObject({ package: 'express', symbol: 'express.json' });

    const prompt = requests[0][0].content;
    expect(prompt.split('\n')[0]).toBe('# Trace: onSubmit on <form> in EnrollForm → POST /api/patients/enroll');
    expect(prompt).toContain('- matched to route POST /api/patients/enroll by exact match, confidence 1.0');
    expect(prompt).toContain('# Component: EnrollForm (web/components/EnrollForm.tsx:18-54)');
    expect(prompt).toContain('# Endpoint: POST /api/patients/enroll');
    expect(prompt.match(/## Files you may cite/g)).toHaveLength(1);
  });

  it('drops a step citing a file outside both contexts', async () => {
    const bad = JSON.parse(RECORDED);
    bad.stages[0].steps[0].code_ref.file = 'web/components/PatientSummary.tsx';
    const { provider } = replay(JSON.stringify(bad));
    const w = await explainTrace(provider, ctx, FIXTURE);
    expect(w.verification.dropped.map((d) => d.stepId)).toEqual(['s1']);
  });
});
