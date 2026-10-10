import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { indexRepo } from '../indexer/index.js';
import { openStore, type Store } from '../store/index.js';
import { buildEndpointContext, currentChainHash, type EndpointContext } from './endpoint.js';
import { TargetError } from './target.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const OPTIONS = { depth: 3, maxContextTokens: 60000 };
const schema = (tag: string) => `cw_test_${tag}_${Math.random().toString(16).slice(2, 10)}`;

describe('buildEndpointContext on the fixture', () => {
  let store: Store;
  let ctx: EndpointContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: schema('ep') });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildEndpointContext(store, FIXTURE, { method: 'POST', path: '/api/patients/enroll' }, OPTIONS);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('resolves the nested-router endpoint to its full path, mounts and middleware order (Phase 3 acceptance)', () => {
    expect(ctx.scopeRef).toBe('POST /api/patients/enroll');
    expect(ctx.route.mounts.map((m) => `${m.prefix} ${m.file}:${m.line}`)).toEqual(['/api api/app.ts:10', '/patients api/routes/index.ts:6']);
    expect(ctx.chain.map((n) => `${n.phase}:${n.label}`)).toEqual([
      'app:express.json()',
      'router:requireAuth',
      'route:rateLimit',
      'route:validate.validateBody',
      'handler:enrollHandler',
    ]);
    expect(ctx.chain[0]).toMatchObject({ symbol: null, code: null, registeredAt: { file: 'api/app.ts', line: 9 } });
    expect(ctx.chain[1].code).toMatchObject({ file: 'api/middleware/auth.ts', start: 10, end: 24 });
    expect(ctx.errorHandlers.map((n) => n.label)).toEqual(['errorHandler']);
    expect(ctx.registrations.map((b) => `${b.file}:${b.start}-${b.end}`)).toEqual([
      'api/app.ts:9-11',
      'api/routes/index.ts:6-6',
      'api/routes/patients.ts:11-11',
      'api/routes/patients.ts:13-13',
    ]);
  });

  it('tags side effects on the node that causes them (Phase 3 acceptance)', () => {
    expect(ctx.sideEffects.map((e) => `${e.symbol.name}: ${e.kind} ${e.detail}`)).toEqual(expect.arrayContaining([
      'requireAuth: redis GET session:${token}',
      'rateLimit: redis INCR ratelimit:${req.ip}',
      'rateLimit: redis EXPIRE ratelimit:${req.ip}',
      'findPatientByPhone: db_read SELECT patients',
      'insertPatient: db_write INSERT patients',
      'insertConsent: db_write INSERT consents',
      'enrollPatient: redis SET patient:${patient.id}',
      'enrollPatient: queue emit patient.enrolled (in-process)',
    ]));
    expect(ctx.errorPaths.map((p) => `${p.symbol.name}: ${p.error} ${p.status}`)).toEqual(expect.arrayContaining([
      'requireAuth: UnauthorizedError 401',
      'rateLimit: TooManyRequestsError 429',
      'validate.validateBody: ValidationError 400',
      'enrollPatient: ConflictError 409',
      'enrollPatient: rethrows err null',
      'enrollHandler: forwards err null',
    ]));
    expect(ctx.unresolved.some((u) => u.note.includes('bus.emit'))).toBe(true);
  });

  it('includes the service and repository code and cites every file it uses', () => {
    const bodies = ctx.callees.filter((c) => c.code).map((c) => c.callee!.name);
    expect(bodies).toEqual(expect.arrayContaining(['enrollPatient', 'findPatientByPhone', 'insertPatient', 'insertConsent']));
    expect(ctx.files['api/repositories/patientRepository.ts']).toBe(50);
    expect(ctx.packages.map((p) => p.name)).toContain('express');
  });

  it('matches a concrete path to its parameterised route', async () => {
    const byId = await buildEndpointContext(store, FIXTURE, { method: 'GET', path: '/api/patients/42' }, OPTIONS);
    expect(byId.scopeRef).toBe('GET /api/patients/:id');
    expect(byId.chain.map((n) => n.label)).toEqual(['express.json()', 'requireAuth', 'getPatientHandler']);
  });

  it('suggests close routes when nothing matches', async () => {
    await expect(buildEndpointContext(store, FIXTURE, { method: 'POST', path: '/api/patient/enroll' }, OPTIONS)).rejects.toThrow(
      /No route matches POST \/api\/patient\/enroll\. Closest: POST \/api\/patients\/enroll/,
    );
  });

  it('exposes a chain hash that currentChainHash reproduces from the index', async () => {
    expect(await currentChainHash(store, ctx.scopeRef)).toBe(ctx.chainHash);
    expect(await currentChainHash(store, 'GET /nope')).toBeNull();
  });
});

describe('buildEndpointContext without routes', () => {
  it('explains that no Express routes are indexed', async () => {
    const store = await openStore({ url: DATABASE_URL, schema: schema('ep_empty') });
    try {
      await store.migrate();
      await expect(buildEndpointContext(store, FIXTURE, { method: 'GET', path: '/x' }, OPTIONS)).rejects.toThrow(TargetError);
      await expect(buildEndpointContext(store, FIXTURE, { method: 'GET', path: '/x' }, OPTIONS)).rejects.toThrow(/No Express routes in the index/);
    } finally {
      await store.dropSchema();
      await store.close();
    }
  });
});

describe('buildEndpointContext when routes cannot be placed', () => {
  it('includes the stitching warnings in the "no routes" error', async () => {
    const store = await openStore({ url: DATABASE_URL, schema: schema('ep_warn') });
    try {
      await store.migrate();
      await store.applyIndexChanges({
        files: [{
          path: 'api/register.ts', hash: 'h', language: 'typescript', symbols: [], calls: [], imports: [],
          routerCalls: [{ receiver: null, receiverText: 'app', callKind: 'use', method: null, path: '/api', pathText: null, line: 4, endLine: 4, orderIdx: 0,
            handlers: [{ kind: 'unresolved', text: 'apiRouter' }] }],
        }],
      });
      await expect(buildEndpointContext(store, FIXTURE, { method: 'GET', path: '/x' }, OPTIONS)).rejects.toThrow(
        /No Express routes in the index[\s\S]*api\/register\.ts:4: `app\.use\(\.\.\.\)` registers on a value that isn't an app or router/,
      );
    } finally {
      await store.dropSchema();
      await store.close();
    }
  });
});

describe('buildEndpointContext with the same route registered twice', () => {
  it('explains the first registration, as Express serves it, and warns about the others', async () => {
    const store = await openStore({ url: DATABASE_URL, schema: schema('ep_dup') });
    const use = (file: string, key: string, line: number) => ({
      receiver: { key, kind: 'app' as const }, receiverText: 'app', callKind: 'use' as const, method: null, path: '/api', pathText: null,
      line, endLine: line, orderIdx: 0, handlers: [{ kind: 'router' as const, receiverKey: 'api/r.ts#r', text: 'r' }],
    });
    try {
      await store.migrate();
      await store.applyIndexChanges({
        files: [
          { path: 'api/a.ts', hash: 'a', language: 'typescript', symbols: [], calls: [], imports: [], routerCalls: [use('api/a.ts', 'api/a.ts#app', 1)] },
          { path: 'api/b.ts', hash: 'b', language: 'typescript', symbols: [], calls: [], imports: [], routerCalls: [use('api/b.ts', 'api/b.ts#app', 1)] },
          {
            path: 'api/r.ts', hash: 'r', language: 'typescript', symbols: [], calls: [], imports: [],
            routerCalls: [{ receiver: { key: 'api/r.ts#r', kind: 'router' }, receiverText: 'r', callKind: 'route', method: 'GET', path: '/x', pathText: null,
              line: 2, endLine: 2, orderIdx: 0, handlers: [{ kind: 'package', package: 'express', text: 'express.static()' }] }],
          },
        ],
      });
      const repo = mkdtempSync(join(tmpdir(), 'cw-dup-'));
      mkdirSync(join(repo, 'api'));
      for (const f of ['a', 'b']) writeFileSync(join(repo, `api/${f}.ts`), "app.use('/api', r);\n");
      writeFileSync(join(repo, 'api/r.ts'), "export const r = Router();\nr.get('/x', express.static('public'));\n");
      const ctx = await buildEndpointContext(store, repo, { method: 'GET', path: '/api/x' }, OPTIONS);
      rmSync(repo, { recursive: true, force: true });
      expect(ctx.scopeRef).toBe('GET /api/x');
      expect(ctx.route.mounts.map((m) => m.file)).toEqual(['api/a.ts']);
      expect(ctx.warnings).toContain('GET /api/x is registered 2 times; explaining the first (mounted via api/a.ts:1). Also: mounted via api/b.ts:1');
    } finally {
      await store.dropSchema();
      await store.close();
    }
  });
});
