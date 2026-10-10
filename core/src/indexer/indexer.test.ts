import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type WalkConfig } from '../config.js';
import { openStore, type Store } from '../store/index.js';
import { frontendCalls, indexRepo } from './index.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;

describe('indexRepo on the fixture', () => {
  let repo: string;
  let config: WalkConfig;
  let store: Store;

  beforeAll(async () => {
    // A private copy, because the incremental tests edit and delete files.
    repo = mkdtempSync(join(tmpdir(), 'cw-index-'));
    cpSync(FIXTURE, repo, { recursive: true });
    config = loadConfig(repo);
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_idx_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  const symbol = async (file: string, name: string) => {
    const [s] = await store.findSymbol(file, name);
    expect(s, `${file}#${name}`).toBeDefined();
    return s;
  };
  const callees = async (file: string, name: string) =>
    (await store.getCallees((await symbol(file, name)).id, 1)).map((c) => ({
      text: c.calleeText,
      target: c.callee ? `${c.callee.file}#${c.callee.name}` : c.resolved ? 'external' : 'unresolved',
    }));

  it('indexes every source file on the first run', async () => {
    const result = await indexRepo(repo, config, store);
    expect(result.scanned).toBe(23);
    expect(result.changed).toHaveLength(23);
    expect(result.removed).toEqual([]);
    expect(result.stats.files).toBe(23);
  });

  it('resolves Express mounts into full routes with ordered middleware', async () => {
    const routes = await store.listRoutes();
    expect(routes.map((r) => `${r.method} ${r.fullPath}`).sort()).toEqual(['GET /api/patients/:id', 'POST /api/patients/enroll']);
    const enroll = routes.find((r) => r.method === 'POST')!;
    expect(enroll).toMatchObject({
      handlerLabel: 'enrollHandler',
      handler: { file: 'api/controllers/patientsController.ts', name: 'enrollHandler' },
      file: 'api/routes/patients.ts',
      line: 13,
      mountChain: [
        { file: 'api/app.ts', line: 10, prefix: '/api' },
        { file: 'api/routes/index.ts', line: 6, prefix: '/patients' },
      ],
    });
    expect((await store.getMiddlewareChain(enroll.id)).map((m) => `${m.phase}:${m.label}`)).toEqual([
      'app:express.json()',
      'router:requireAuth',
      'route:rateLimit',
      'route:validate.validateBody',
      'error:errorHandler',
    ]);
  });

  it('tags side effects on the symbols that cause them', async () => {
    const effects = async (file: string, name: string) =>
      (await store.getSideEffects([(await symbol(file, name)).id])).map((e) => `${e.kind} ${e.detail}`);
    expect(await effects('api/middleware/auth.ts', 'requireAuth')).toEqual([
      'throws UnauthorizedError (401)',
      'redis GET session:${token}',
      'throws UnauthorizedError (401)',
    ]);
    expect(await effects('api/repositories/patientRepository.ts', 'insertConsent')).toEqual(['db_write INSERT consents']);
    expect(await effects('api/services/enrollService.ts', 'enrollPatient')).toEqual(expect.arrayContaining([
      'throws ConflictError (409)',
      'redis SET patient:${patient.id}',
      'queue emit patient.enrolled (in-process)',
      'throws rethrows err',
    ]));
  });

  it('extracts symbols with kinds, qualified names and export flags', async () => {
    expect(await symbol('api/services/enrollService.ts', 'enrollPatient')).toMatchObject({
      kind: 'function',
      exported: true,
      startLine: 35,
      endLine: 69,
      signature: 'export async function enrollPatient(input: EnrollInput, enrolledBy: string): Promise<Patient>',
    });
    expect((await symbol('web/components/EnrollForm.tsx', 'EnrollForm')).kind).toBe('component');
    expect((await symbol('web/hooks/useEnrollMutation.ts', 'useEnrollMutation')).kind).toBe('hook');
    expect(await symbol('web/components/EnrollForm.tsx', 'EnrollForm.handleSubmit')).toMatchObject({ kind: 'function', exported: false });
    expect((await symbol('web/apiClient.ts', 'api.post')).kind).toBe('method');
    expect((await symbol('api/errors.ts', 'ConflictError')).kind).toBe('class');
    expect((await symbol('api/repositories/patientRepository.ts', 'Patient')).kind).toBe('type');
    expect((await symbol('api/middleware/validate.ts', 'validate.validateBody')).kind).toBe('function');
  });

  it('resolves cross-file calls, constructors and package calls', async () => {
    const calls = await callees('api/services/enrollService.ts', 'enrollPatient');
    expect(calls).toContainEqual({ text: 'normalizePhone', target: 'api/services/enrollService.ts#normalizePhone' });
    expect(calls).toContainEqual({ text: 'findPatientByPhone', target: 'api/repositories/patientRepository.ts#findPatientByPhone' });
    expect(calls).toContainEqual({ text: 'ConflictError', target: 'api/errors.ts#ConflictError' });
    expect(calls).toContainEqual({ text: 'pool.connect', target: 'external' });
    expect(calls).toContainEqual({ text: 'redis.set', target: 'external' });
  });

  it('resolves functions returned from hooks and object-literal methods', async () => {
    expect(await callees('web/components/EnrollForm.tsx', 'EnrollForm.handleSubmit')).toContainEqual({
      text: 'mutate',
      target: 'web/hooks/useEnrollMutation.ts#useEnrollMutation.mutate',
    });
    expect(await callees('web/hooks/useEnrollMutation.ts', 'useEnrollMutation.mutate')).toContainEqual({
      text: 'api.post',
      target: 'web/apiClient.ts#api.post',
    });
  });

  it('marks dynamic dispatch, event emits and callbacks as unresolved', async () => {
    expect(await callees('api/events/handlers.ts', 'dispatch')).toContainEqual({ text: 'handlers[name]', target: 'unresolved' });
    expect(await callees('api/services/enrollService.ts', 'enrollPatient')).toContainEqual({ text: 'bus.emit', target: 'unresolved' });
    expect(await callees('web/hooks/useEnrollMutation.ts', 'useEnrollMutation.mutate')).toContainEqual({ text: 'onSuccess', target: 'unresolved' });
    // Untyped callback parameters inherit the origin of the call they're passed to (zod here).
    expect(await callees('api/middleware/validate.ts', 'validate.validateBody')).toContainEqual({ text: 'i.path.join', target: 'external' });
  });

  it('finds callers across files', async () => {
    const enroll = await symbol('api/services/enrollService.ts', 'enrollPatient');
    const callers = await store.getCallers(enroll.id);
    expect(callers.map((c) => `${c.caller.file}#${c.caller.name}:${c.callLine}`)).toEqual([
      'api/controllers/patientsController.ts#enrollHandler:10',
    ]);
  });

  it('does nothing when no file changed', async () => {
    const result = await indexRepo(repo, config, store);
    expect(result).toMatchObject({ changed: [], removed: [], refreshed: [] });
  });

  it('re-extracts a changed file and refreshes calls into it without touching other symbols', async () => {
    const controllerBefore = await symbol('api/controllers/patientsController.ts', 'enrollHandler');
    const servicePath = join(repo, 'api/services/enrollService.ts');
    writeFileSync(servicePath, `// moved down two lines\n\n${readFileSync(servicePath, 'utf8')}`);

    const result = await indexRepo(repo, config, store);
    expect(result.changed).toEqual(['api/services/enrollService.ts']);
    expect(result.refreshed).toEqual(['api/controllers/patientsController.ts']);

    expect((await symbol('api/services/enrollService.ts', 'enrollPatient')).startLine).toBe(37);
    const controllerAfter = await symbol('api/controllers/patientsController.ts', 'enrollHandler');
    expect(controllerAfter.id).toBe(controllerBefore.id);
    const [edge] = (await store.getCallees(controllerAfter.id, 1)).filter((c) => c.calleeText === 'enrollPatient');
    expect(edge.callee).toMatchObject({ name: 'enrollPatient', startLine: 37 });
  });

  it('removes deleted files and keeps the edges into them as unresolved after refresh', async () => {
    rmSync(join(repo, 'api/events/handlers.ts'));
    const result = await indexRepo(repo, config, store);
    expect(result.removed).toEqual(['api/events/handlers.ts']);
    expect(result.refreshed).toEqual(['api/events/bus.ts']);
    expect(await store.findSymbol('api/events/handlers.ts', 'dispatch')).toEqual([]);
    expect(await callees('api/events/bus.ts', 'registerEventHandlers')).toContainEqual({ text: 'dispatch', target: 'unresolved' });
  });

  it('rebuilds routes when a router file changes', async () => {
    const path = join(repo, 'api/routes/patients.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('rateLimit, ', ''));
    await indexRepo(repo, config, store);
    const enroll = (await store.listRoutes()).find((r) => r.fullPath === '/api/patients/enroll')!;
    expect((await store.getMiddlewareChain(enroll.id)).map((m) => m.label)).toEqual([
      'express.json()',
      'requireAuth',
      'validate.validateBody',
      'errorHandler',
    ]);
  });
});

describe('indexRepo with middleware imported through a barrel file', () => {
  let repo: string;
  let config: WalkConfig;
  let store: Store;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-barrel-'));
    cpSync(FIXTURE, repo, { recursive: true });
    writeFileSync(join(repo, 'api/middleware/index.ts'), "export { requireAuth } from './auth';\n");
    const routes = join(repo, 'api/routes/patients.ts');
    writeFileSync(routes, readFileSync(routes, 'utf8').replace("from '../middleware/auth'", "from '../middleware'"));
    config = loadConfig(repo);
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_barrel_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(repo, config, store);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('keeps the middleware symbol when the middleware file moves, even though the router imports it indirectly', async () => {
    const auth = join(repo, 'api/middleware/auth.ts');
    writeFileSync(auth, `// one\n// two\n${readFileSync(auth, 'utf8')}`);
    await indexRepo(repo, config, store);
    const enroll = (await store.listRoutes()).find((r) => r.fullPath === '/api/patients/enroll')!;
    const requireAuth = (await store.getMiddlewareChain(enroll.id)).find((m) => m.label === 'requireAuth')!;
    expect(requireAuth.symbol).toMatchObject({ file: 'api/middleware/auth.ts', startLine: 12 });
  });
});

describe('indexRepo: React facts, API calls and extraction settings', () => {
  let store: Store;
  const config = loadConfig(FIXTURE);
  const id = async (file: string, name: string) => (await store.findSymbol(file, name))[0].id;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_idx4_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, config, store);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('stores React facts for components and hooks', async () => {
    const [form] = await store.getReactFacts([await id('web/components/EnrollForm.tsx', 'EnrollForm')]);
    expect(form.hooks.map((h) => h.name)).toEqual(['useState', 'useEnrollMutation']);
    expect(form.handlers[0]).toMatchObject({ event: 'onSubmit', target: { name: 'EnrollForm.handleSubmit' } });
    const [hook] = await store.getReactFacts([await id('web/hooks/usePatient.ts', 'usePatient')]);
    expect(hook.effects).toEqual([{ hook: 'useEffect', line: 9, endLine: 23, deps: ['id'], binding: null }]);
  });

  it('stores API calls found through the configured wrappers', async () => {
    const calls = await store.getApiCalls([await id('web/hooks/useEnrollMutation.ts', 'useEnrollMutation.mutate'), await id('web/hooks/usePatient.ts', 'usePatient')]);
    expect(calls.map((c) => `${c.method} ${c.urlPattern} :${c.line}`).sort()).toEqual(['GET /api/patients/:id :13', 'POST /api/patients/enroll :19']);
  });

  it('re-extracts unchanged files when apiClientWrappers changes, and only once', async () => {
    const noWrappers = { ...config, apiClientWrappers: [] };
    const result = await indexRepo(FIXTURE, noWrappers, store);
    expect(result.changed).toHaveLength(result.scanned);
    expect(await store.getApiCalls([await id('web/hooks/useEnrollMutation.ts', 'useEnrollMutation.mutate')])).toEqual([]);
    expect((await indexRepo(FIXTURE, noWrappers, store)).changed).toEqual([]);
    expect((await indexRepo(FIXTURE, config, store)).changed).toHaveLength(result.scanned);
  });
});

describe('indexRepo: frontend calls linked to routes', () => {
  let store: Store;
  const config = loadConfig(FIXTURE);
  const routeId = async (method: string, path: string) => (await store.listRoutes()).find((r) => r.method === method && r.fullPath === path)!.id;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_idx5_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, config, store);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('lists every API call with its calling function', async () => {
    expect((await store.listApiCalls()).map((a) => `${a.method} ${a.urlPattern} ${a.caller.file}#${a.caller.name}:${a.line}`)).toEqual([
      'POST /v1/messages api/events/handlers.ts#sendWelcomeSms:7',
      'POST /hooks/new-patient api/events/handlers.ts#notifyCareTeam:16',
      'POST /api/patients/enroll web/hooks/useEnrollMutation.ts#useEnrollMutation.mutate:19',
      'GET /api/patients/:id web/hooks/usePatient.ts#usePatient:13',
    ]);
  });

  it('links only frontend calls to routes; outbound HTTP calls from the backend are never candidates', () => {
    expect(frontendCalls([{ caller: { file: 'api/events/handlers.ts' } }, { caller: { file: 'web/hooks/usePatient.ts' } }, { caller: { file: 'webapp/x.ts' } }], config)).toEqual([
      { caller: { file: 'web/hooks/usePatient.ts' } },
    ]);
    for (const frontend of ['./web', 'web/', 'web\\', './web//']) {
      expect(frontendCalls([{ caller: { file: 'web/a.ts' } }, { caller: { file: 'api/b.ts' } }], { roots: { frontend } }), frontend).toEqual([{ caller: { file: 'web/a.ts' } }]);
    }
    expect(frontendCalls([{ caller: { file: 'api/x.ts' } }], { roots: { frontend: './' } })).toEqual([{ caller: { file: 'api/x.ts' } }]);
    const single = { ...config, roots: { backend: 'api' } };
    expect(frontendCalls([{ caller: { file: 'api/x.ts' } }], single)).toEqual([{ caller: { file: 'api/x.ts' } }]);
  });

  it('resolves each fixture call to its route with an exact match', async () => {
    const [enroll] = await store.getCrossEdges(await routeId('POST', '/api/patients/enroll'));
    expect(enroll).toMatchObject({ match: 'exact', confidence: 1, pinned: false, resolved: true, callResolved: true, apiCall: { method: 'POST', caller: { name: 'useEnrollMutation.mutate' } } });
    expect((await store.getCrossEdges(await routeId('GET', '/api/patients/:id'))).map((e) => `${e.apiCall.caller.name} ${e.match} ${e.resolved}`)).toEqual(['usePatient exact true']);
  });

  it('finds the components whose handlers name a function', async () => {
    const owners = await store.getHandlerOwners({ file: 'web/components/EnrollForm.tsx', name: 'EnrollForm.handleSubmit', startLine: 32 });
    expect(owners.map((s) => s.name)).toEqual(['EnrollForm']);
  });

  it('applies pins from config on the next pass, warning about stale ones', async () => {
    const pinned = {
      ...config,
      pinnedEdges: [
        { caller: 'web/hooks/usePatient.ts#usePatient', method: 'GET', url: '/api/patients/:id', route: 'GET /api/patients/:id' },
        { caller: 'web/gone.ts#gone', method: 'GET', url: '/x', route: 'GET /x' },
      ],
    };
    const result = await indexRepo(FIXTURE, pinned, store);
    expect(result.changed).toEqual([]);
    expect(result.warnings).toEqual(['Pinned edge web/gone.ts#gone GET /x → GET /x: no such API call in the index; remove it from pinnedEdges.']);
    const [edge] = await store.getCrossEdges(await routeId('GET', '/api/patients/:id'));
    expect(edge).toMatchObject({ match: 'pinned', pinned: true, resolved: true });
    expect((await indexRepo(FIXTURE, config, store)).warnings).toEqual([]);
  });

  it('rebuilds the links only when files or pins change, but always reports stale pins', async () => {
    expect((await indexRepo(FIXTURE, config, store)).crossEdgesRebuilt).toBe(false);
    const stale = { ...config, pinnedEdges: [{ caller: 'web/gone.ts#gone', method: 'GET', url: '/x', route: 'GET /x' }] };
    expect((await indexRepo(FIXTURE, stale, store)).crossEdgesRebuilt).toBe(true);
    const again = await indexRepo(FIXTURE, stale, store);
    expect(again.crossEdgesRebuilt).toBe(false);
    expect(again.warnings).toHaveLength(1);
    expect((await indexRepo(FIXTURE, config, store)).crossEdgesRebuilt).toBe(true);
  });
});
