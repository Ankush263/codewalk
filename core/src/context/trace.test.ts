import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addPinnedEdge, loadConfig } from '../config.js';
import { indexRepo } from '../indexer/index.js';
import { openStore, type Store } from '../store/index.js';
import { buildTraceContext, currentTraceHash, describeCandidate, PinNeededError, pinFor, type TraceContext } from './trace.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const OPTIONS = { depth: 3, maxContextTokens: 60000 };
const ENROLL = { method: 'POST', path: '/api/patients/enroll' };
const schema = (tag: string) => `cw_test_${tag}_${Math.random().toString(16).slice(2, 10)}`;

describe('buildTraceContext on the fixture', () => {
  let store: Store;
  let ctx: TraceContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: schema('trc') });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildTraceContext(store, FIXTURE, { endpoint: ENROLL, from: null }, OPTIONS);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('links the click in EnrollForm to the route (Phase 5 acceptance)', () => {
    expect(ctx.scopeRef).toBe('POST /api/patients/enroll <- web/components/EnrollForm.tsx#EnrollForm');
    expect(ctx.link).toMatchObject({ match: 'exact', confidence: 1, pinned: false, call: { method: 'POST', urlPattern: '/api/patients/enroll', line: 19 } });
    expect(ctx.link.call.symbol.name).toBe('useEnrollMutation.mutate');
    expect(ctx.link.call.triggers.map((t) => `${t.label}: ${t.path.join(' → ')}`)).toEqual(['onSubmit on <form>: EnrollForm.handleSubmit → useEnrollMutation.mutate']);
  });

  it('carries the server side and what the frontend does after the response (Phase 5 acceptance)', () => {
    expect(ctx.endpoint.chain.map((n) => n.label)).toEqual(['express.json()', 'requireAuth', 'rateLimit', 'validate.validateBody', 'enrollHandler']);
    expect(ctx.endpoint.sideEffects.map((e) => `${e.kind} ${e.detail}`)).toEqual(expect.arrayContaining(['db_write INSERT patients', 'db_write INSERT consents']));
    expect(ctx.afterResponse.map((a) => `${a.calleeText}:${a.line}`)).toEqual(['setStatus:20', 'onSuccess:21', 'setStatus:23', 'setError:24']);
    expect(Object.keys(ctx.files)).toEqual(expect.arrayContaining(['api/services/enrollService.ts', 'web/components/EnrollForm.tsx', 'web/hooks/useEnrollMutation.ts']));
  });

  it('accepts a concrete path and follows an effect-triggered call', async () => {
    const get = await buildTraceContext(store, FIXTURE, { endpoint: { method: 'GET', path: '/api/patients/42' }, from: null }, OPTIONS);
    expect(get.scopeRef).toBe('GET /api/patients/:id <- web/components/PatientSummary.tsx#PatientSummary');
    expect(get.link.call.triggers[0]).toMatchObject({ kind: 'effect', label: 'useEffect [id] in usePatient' });
  });

  it('recomputes the trace hash from the index alone', async () => {
    expect(await currentTraceHash(store, '/nonexistent-repo-root', ctx.scopeRef, 3)).toBe(ctx.traceHash);
    expect(await currentTraceHash(store, FIXTURE, 'POST /api/gone <- web/components/EnrollForm.tsx#EnrollForm', 3)).toBeNull();
  });
});

describe('buildTraceContext: choosing a caller and pinning', () => {
  let repo: string;
  let store: Store;
  const reindex = async () => indexRepo(repo, loadConfig(repo), store);

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-trace-'));
    cpSync(FIXTURE, repo, { recursive: true });
    writeFileSync(
      join(repo, 'web/components/QuickEnroll.tsx'),
      [
        "import { useEnrollMutation } from '../hooks/useEnrollMutation';",
        "import type { EnrollFormValues } from '../types';",
        '',
        'export function QuickEnroll({ values }: { values: EnrollFormValues }) {',
        '  const { mutate } = useEnrollMutation();',
        '  return <button onClick={() => mutate(values)}>Enroll again</button>;',
        '}',
        '',
      ].join('\n'),
    );
    store = await openStore({ url: DATABASE_URL, schema: schema('trcp') });
    await store.migrate();
    await reindex();
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('asks which component to trace when several call the endpoint', async () => {
    await expect(buildTraceContext(store, repo, { endpoint: ENROLL, from: null }, OPTIONS)).rejects.toThrow(
      'POST /api/patients/enroll is called from 2 components: web/components/EnrollForm.tsx#EnrollForm, web/components/QuickEnroll.tsx#QuickEnroll. Choose one with --from <file>#<Component>.',
    );
    const quick = await buildTraceContext(store, repo, { endpoint: ENROLL, from: { file: 'web/components/QuickEnroll.tsx', name: null } }, OPTIONS);
    expect(quick.link.call.triggers[0].label).toBe('onClick on <button>');
    await expect(buildTraceContext(store, repo, { endpoint: ENROLL, from: { file: 'web/components/PatientSummary.tsx', name: null } }, OPTIONS)).rejects.toThrow(
      /web\/components\/PatientSummary\.tsx doesn't call POST \/api\/patients\/enroll; callers: /,
    );
  });

  it('needs a pin for a URL that only matches by suffix, then follows the pin', async () => {
    const hook = join(repo, 'web/hooks/useEnrollMutation.ts');
    writeFileSync(hook, readFileSync(hook, 'utf8').replace("'/api/patients/enroll'", "'/patients/enroll'"));
    await reindex();
    const failure = await buildTraceContext(store, repo, { endpoint: ENROLL, from: null }, OPTIONS).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PinNeededError);
    const { candidates, route } = failure as PinNeededError;
    expect(candidates.map(describeCandidate)).toEqual(['POST /patients/enroll in useEnrollMutation.mutate (web/hooks/useEnrollMutation.ts:19): suffix match (0.6)']);

    addPinnedEdge(repo, pinFor(candidates[0], route));
    expect(loadConfig(repo).pinnedEdges).toEqual([
      { caller: 'web/hooks/useEnrollMutation.ts#useEnrollMutation.mutate', method: 'POST', url: '/patients/enroll', route: 'POST /api/patients/enroll' },
    ]);
    await reindex();
    const pinned = await buildTraceContext(store, repo, { endpoint: ENROLL, from: { file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' } }, OPTIONS);
    expect(pinned.link).toMatchObject({ match: 'pinned', pinned: true, confidence: 1 });
  });
});

describe('buildTraceContext: router.all routes (review fix)', () => {
  let repo: string;
  let store: Store;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-trace-all-'));
    cpSync(FIXTURE, repo, { recursive: true });
    const routes = join(repo, 'api/routes/patients.ts');
    writeFileSync(routes, `${readFileSync(routes, 'utf8')}patientsRouter.all('/:id/notes', getPatientHandler);\n`);
    writeFileSync(
      join(repo, 'web/components/NotesView.tsx'),
      [
        "import { useEffect } from 'react';",
        "import { api } from '../apiClient';",
        '',
        'export function NotesView({ id }: { id: string }) {',
        '  useEffect(() => {',
        '    api.get(`/api/patients/${id}/notes`);',
        '  }, [id]);',
        '  return <p>notes</p>;',
        '}',
        '',
      ].join('\n'),
    );
    store = await openStore({ url: DATABASE_URL, schema: schema('trca') });
    await store.migrate();
    await indexRepo(repo, loadConfig(repo), store);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('traces only calls made with the requested method, and names that method in the scope', async () => {
    const get = await buildTraceContext(store, repo, { endpoint: { method: 'GET', path: '/api/patients/1/notes' }, from: null }, OPTIONS);
    expect(get.scopeRef).toBe('GET /api/patients/:id/notes <- web/components/NotesView.tsx#NotesView');
    expect(await currentTraceHash(store, repo, get.scopeRef, 3)).toBe(get.traceHash);
    await expect(buildTraceContext(store, repo, { endpoint: { method: 'DELETE', path: '/api/patients/1/notes' }, from: null }, OPTIONS)).rejects.toThrow(
      /No frontend API call matches DELETE \/api\/patients\/:id\/notes/,
    );
  });
});

