import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildEndpointContext, type EndpointContext } from '../context/endpoint.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmMessage, LlmProvider } from '../llm/generate.js';
import { openStore, type Store } from '../store/index.js';
import { explainEndpoint } from './endpoint.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollEndpoint.response.json', import.meta.url), 'utf8');

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

describe('explainEndpoint on the fixture', () => {
  let store: Store;
  let ctx: EndpointContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_epw_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildEndpointContext(store, FIXTURE, { method: 'POST', path: '/api/patients/enroll' }, { depth: 3, maxContextTokens: 60000 });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('keeps every grounded step, in the fixed stage order, with docs links and static unresolved notes', async () => {
    const { provider, requests } = replay(RECORDED);
    const w = await explainEndpoint(provider, ctx, FIXTURE);
    expect(w.verification.dropped).toEqual([]);
    expect(w.verification.keptSteps).toBe(9);
    expect(w.stages.map((s) => s.name)).toEqual(['Request', 'Middleware', 'Validation', 'Business logic', 'Persistence', 'Response']);
    expect(w.scope).toMatchObject({ file: 'api/controllers/patientsController.ts', start: 7, end: 15, symbol: 'POST /api/patients/enroll' });
    expect(w.stages[0].steps[0].docLinks[0]).toMatchObject({ package: 'express', symbol: 'express.json' });
    expect(w.unresolved.some((u) => u.includes('bus.emit'))).toBe(true);

    const prompt = requests[0][0].content;
    expect(prompt.split('\n')[0]).toBe('# Endpoint: POST /api/patients/enroll');
    expect(prompt).toContain('2. [router] `requireAuth`, registered at api/routes/patients.ts:11');
    expect(prompt).toContain('insertConsent (api/repositories/patientRepository.ts:46): db_write INSERT consents');
  });

  it('drops a step that cites a file outside the context', async () => {
    const bad = JSON.parse(RECORDED);
    bad.stages[0].steps[0].code_ref.file = 'web/apiClient.ts';
    const { provider } = replay(JSON.stringify(bad));
    const w = await explainEndpoint(provider, ctx, FIXTURE);
    expect(w.verification.dropped.map((d) => d.stepId)).toEqual(['s1']);
  });
});
