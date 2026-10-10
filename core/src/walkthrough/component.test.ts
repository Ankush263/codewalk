import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildComponentContext, type ComponentContext } from '../context/component.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmMessage, LlmProvider } from '../llm/generate.js';
import { openStore, type Store } from '../store/index.js';
import { explainComponent } from './component.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollForm.response.json', import.meta.url), 'utf8');

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

describe('explainComponent on the fixture', () => {
  let store: Store;
  let ctx: ComponentContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_cmpw_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildComponentContext(store, FIXTURE, { file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' }, { depth: 2, maxContextTokens: 60000 });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('keeps every grounded step in the fixed stage order (Phase 4 acceptance)', async () => {
    const { provider, requests } = replay(RECORDED);
    const w = await explainComponent(provider, ctx, FIXTURE);
    expect(w.verification.dropped).toEqual([]);
    expect(w.verification.keptSteps).toBe(8);
    expect(w.stages.map((s) => s.name)).toEqual(['Inputs and state', 'Render', 'Hook: useEnrollMutation', 'Event handlers', 'Data fetching']);
    expect(w.scope).toEqual({ file: 'web/components/EnrollForm.tsx', start: 18, end: 54, symbol: 'EnrollForm' });
    expect(w.stages[0].steps[0].docLinks[0]).toMatchObject({ package: 'react', symbol: 'useState' });
    expect(w.unresolved).toEqual(expect.arrayContaining([expect.stringContaining('`onSuccess` callback EnrollForm passes to useEnrollMutation')]));

    const prompt = requests[0][0].content;
    expect(prompt.split('\n')[0]).toBe('# Component: EnrollForm (web/components/EnrollForm.tsx:18-54)');
    expect(prompt).toContain('## Hook: useEnrollMutation (depth 1, called by EnrollForm at web/components/EnrollForm.tsx:20)');
    expect(prompt).toContain(
      '- POST /api/patients/enroll in useEnrollMutation.mutate (web/hooks/useEnrollMutation.ts:19) ← onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate',
    );
  });

  it('drops a step that names an identifier outside the context', async () => {
    const bad = JSON.parse(RECORDED);
    bad.stages[1].steps[0].explanation = 'It renders `ModalDialog`.';
    const { provider } = replay(JSON.stringify(bad));
    const w = await explainComponent(provider, ctx, FIXTURE);
    expect(w.verification.dropped.map((d) => d.stepId)).toEqual(['s2']);
  });
});
