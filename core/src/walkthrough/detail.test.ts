import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { indexRepo } from '../indexer/index.js';
import { openStore, type Store } from '../store/index.js';
import { ENDPOINT_REF, seedEndpointWalkthrough } from './__fixtures__/seed.js';
import { walkthroughDetail, walkthroughList } from './detail.js';
import { persistWalkthrough } from './persist.js';
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

  it('gives each step the time it was explained, and marks questions asked before a re-explanation stale', async () => {
    const before = (await walkthroughDetail(store, repo, 'endpoint', ENDPOINT_REF))!;
    expect(before.steps.s1.explainedAt).toBe(saved.sections[0].generatedAt);
    await store.saveQuestion({
      scopeKind: 'endpoint', scopeRef: ENDPOINT_REF, stepId: 's3', question: 'Re-explained?', stepHash: saved.sections[0].stepHashes.s3, model: 'm',
      answer: { answer: 'Yes.', references: [], warnings: [] },
    });
    const later = new Date(Date.now() + 60_000).toISOString();
    await persistWalkthrough(store, repo, { ...saved, sections: [{ ...saved.sections[0], generatedAt: later }] });
    const after = (await walkthroughDetail(store, repo, 'endpoint', ENDPOINT_REF))!;
    expect(after.steps.s1.explainedAt).toBe(later);
    expect(after.questions.find((q) => q.question === 'Re-explained?')?.stale).toBe(true);
    await persistWalkthrough(store, repo, saved);
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
    expect(detail.questions.filter((q) => q.stepId === 's7').map((q) => `${q.stepId} ${q.stale}`)).toEqual(['s7 false']);

    await edit('api/services/enrollService.ts', "await client.query('BEGIN');", 'await client.query("BEGIN");');
    detail = (await walkthroughDetail(store, repo, 'endpoint', ENDPOINT_REF))!;
    expect(detail.steps.s7.fresh).toBe(false);
    expect(detail.questions.filter((q) => q.stepId === 's7').map((q) => `${q.stepId} ${q.stale}`)).toEqual(['s7 true']);
  });
});
