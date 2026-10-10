import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmProvider } from '../llm/generate.js';
import { openStore, type Store } from '../store/index.js';
import { ENDPOINT_REF, seedEndpointWalkthrough } from './__fixtures__/seed.js';
import { loadConfig } from '../config.js';
import { indexRepo } from '../indexer/index.js';
import { persistWalkthrough, WALKTHROUGHS_DIR, walkthroughSlug } from './persist.js';
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

describe('askQuestion: review fixes', () => {
  let repo: string;
  let store: Store;
  let saved: SavedWalkthrough;
  const answering: LlmProvider = { generate: async () => ANSWER };
  const prompts: string[] = [];
  const recording: LlmProvider = {
    generate: async ({ messages }) => {
      prompts.push(messages[0].content);
      return ANSWER;
    },
  };
  const options = { model: 'recorded', maxContextTokens: 60000 };
  const edit = async (file: string, from: string, to: string) => {
    const path = join(repo, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
    await indexRepo(repo, loadConfig(repo), store);
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-qa-fix-'));
    cpSync(FIXTURE, repo, { recursive: true });
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_askf_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    saved = await seedEndpointWalkthrough(store, repo);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('never writes an older copy of the walkthrough back over a newer one', async () => {
    const newer: SavedWalkthrough = { ...saved, sections: [{ ...saved.sections[0], walkthrough: { ...saved.sections[0].walkthrough, title: 'Regenerated meanwhile' } }] };
    await persistWalkthrough(store, repo, newer);
    await askQuestion(answering, store, repo, saved, 's2', 'Still there?', options);
    expect(((await store.getWalkthrough('endpoint', ENDPOINT_REF))!.content as SavedWalkthrough).sections[0].walkthrough.title).toBe('Regenerated meanwhile');
    const md = readFileSync(join(repo, WALKTHROUGHS_DIR, `${walkthroughSlug('endpoint', ENDPOINT_REF)}.md`), 'utf8');
    expect(md).toContain('# Regenerated meanwhile');
    expect(md).toContain('- **Q:** Still there?');
    await persistWalkthrough(store, repo, saved);
  });

  it('sends the current lines of a step after code above it moved', async () => {
    await edit('api/services/enrollService.ts', "import { pool } from '../db/pool';", "// one\n// two\n// three\nimport { pool } from '../db/pool';");
    await askQuestion(recording, store, repo, saved, 's7', 'Why a transaction?', options);
    expect(prompts.at(-1)).toContain('Step s7 at api/services/enrollService.ts:50-61');
    expect(prompts.at(-1)).toContain("52 |     await client.query('BEGIN');");
  });

  it('refuses a question on a step whose code changed, until the walkthrough is regenerated', async () => {
    await edit('api/services/enrollService.ts', "await client.query('BEGIN');", 'await client.query("BEGIN");');
    await expect(askQuestion(answering, store, repo, saved, 's7', 'Why?', options)).rejects.toThrow(
      "Step s7's code changed since it was explained; regenerate the walkthrough before asking about it.",
    );
  });
});
