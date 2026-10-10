import { describe, expect, it } from 'vitest';
import type { HandlerArg, RouterCallRecord } from '../store/types.js';
import { joinPath, stitchRoutes, type StitchedRoute } from './stitch.js';

const kindOf = (key: string) => (key.endsWith('#app') ? 'app' : 'router') as 'app' | 'router';
const base = (file: string, receiver: string, line: number) => ({
  file, receiver: { key: receiver, kind: kindOf(receiver) }, receiverText: receiver.split('#')[1], pathText: null, line, endLine: line, orderIdx: line,
});
const use = (file: string, receiver: string, line: number, path: string | null, ...handlers: HandlerArg[]): RouterCallRecord => ({
  ...base(file, receiver, line), callKind: 'use', method: null, path, handlers,
});
const route = (file: string, receiver: string, line: number, method: string, path: string, ...handlers: HandlerArg[]): RouterCallRecord => ({
  ...base(file, receiver, line), callKind: 'route', method, path, handlers,
});
const sym = (file: string, name: string, arity = 3): HandlerArg => ({ kind: 'symbol', key: { file, name, startLine: 1 }, arity, text: name });
const router = (receiverKey: string): HandlerArg => ({ kind: 'router', receiverKey, text: receiverKey.split('#')[1] });
const pkg = (text: string): HandlerArg => ({ kind: 'package', package: 'express', text });
const summary = (routes: StitchedRoute[]) =>
  routes.map((r) => `${r.method} ${r.fullPath} -> ${r.handler.text} | ${r.middleware.map((m) => `${m.phase}:${m.handler.text}`).join(' ')}`);

describe('joinPath', () => {
  it('joins and normalises prefixes', () => {
    expect(joinPath('/', '/')).toBe('/');
    expect(joinPath('/api', '/patients/')).toBe('/api/patients');
    expect(joinPath('/api/', 'x//y')).toBe('/api/x/y');
  });
});

describe('stitchRoutes', () => {
  it('resolves nested mounts and orders app, router, route and error middleware (fixture shape)', () => {
    const APP = 'api/app.ts#app';
    const API = 'api/routes/index.ts#apiRouter';
    const PAT = 'api/routes/patients.ts#patientsRouter';
    const { routes, warnings } = stitchRoutes([
      use('api/app.ts', APP, 9, null, pkg('express.json()')),
      use('api/app.ts', APP, 10, '/api', router(API)),
      use('api/app.ts', APP, 11, null, sym('api/middleware/errorHandler.ts', 'errorHandler', 4)),
      use('api/routes/index.ts', API, 6, '/patients', router(PAT)),
      use('api/routes/patients.ts', PAT, 11, null, sym('api/middleware/auth.ts', 'requireAuth')),
      route('api/routes/patients.ts', PAT, 13, 'POST', '/enroll', sym('api/middleware/rateLimit.ts', 'rateLimit'), sym('api/controllers/c.ts', 'enrollHandler')),
      route('api/routes/patients.ts', PAT, 14, 'GET', '/:id', sym('api/controllers/c.ts', 'getPatientHandler')),
    ]);
    expect(warnings).toEqual([]);
    expect(summary(routes)).toEqual([
      'POST /api/patients/enroll -> enrollHandler | app:express.json() router:requireAuth route:rateLimit error:errorHandler',
      'GET /api/patients/:id -> getPatientHandler | app:express.json() router:requireAuth error:errorHandler',
    ]);
    expect(routes[0].mountChain).toEqual([
      { file: 'api/app.ts', line: 10, endLine: 10, prefix: '/api' },
      { file: 'api/routes/index.ts', line: 6, endLine: 6, prefix: '/patients' },
    ]);
  });

  it('applies path-scoped middleware by segment and ignores middleware registered after the route', () => {
    const F = 'a.ts';
    const APP = 'a.ts#app';
    const { routes } = stitchRoutes([
      use(F, APP, 1, '/admin', sym(F, 'adminOnly')),
      use(F, APP, 2, null, sym(F, 'earlyErrors', 4)),
      route(F, APP, 3, 'GET', '/admin/users', sym(F, 'listUsers')),
      route(F, APP, 4, 'GET', '/health', sym(F, 'health')),
      route(F, APP, 5, 'GET', '/administrators', sym(F, 'admins')),
      use(F, APP, 6, null, sym(F, 'late')),
      use(F, APP, 7, null, sym(F, 'onError', 4)),
    ]);
    expect(summary(routes)).toEqual([
      'GET /admin/users -> listUsers | app:adminOnly error:onError',
      'GET /health -> health | error:onError',
      'GET /administrators -> admins | error:onError',
    ]);
  });

  it('reports mount loops, never-mounted routers and registrations it cannot place', () => {
    const plugin: RouterCallRecord = { ...route('p.ts', 'p.ts#x', 4, 'GET', '/plugin', sym('p.ts', 'h2')), receiver: null, receiverText: 'app' };
    const { routes, warnings } = stitchRoutes([
      use('a.ts', 'a.ts#app', 1, '/x', router('r1.ts#r1')),
      use('r1.ts', 'r1.ts#r1', 1, '/y', router('r2.ts#r2')),
      use('r2.ts', 'r2.ts#r2', 1, '/z', router('r1.ts#r1')),
      route('r2.ts', 'r2.ts#r2', 2, 'GET', '/', sym('r2.ts', 'h')),
      route('orphan.ts', 'orphan.ts#o', 1, 'GET', '/lost', sym('orphan.ts', 'lost')),
      plugin,
    ]);
    expect(summary(routes)).toEqual(['GET /x/y -> h | ']);
    expect(warnings).toEqual([
      "p.ts:4: `app.get(...)` registers on a value that isn't an app or router created in this repo with express() or Router(), so it can't be placed in the route tree",
      'r2.ts:1: `r1` is already mounted above this router; skipped to avoid a loop',
      'orphan.ts: router `o` has routes but is never mounted on an app',
    ]);
  });

  it('shows a non-literal path as * with a warning on the route', () => {
    const dynamic: RouterCallRecord = { ...route('a.ts', 'a.ts#app', 1, 'GET', 'x', sym('a.ts', 'h')), path: null, pathText: 'BASE + "/x"' };
    const { routes } = stitchRoutes([dynamic]);
    expect(routes[0].fullPath).toBe('/*');
    expect(routes[0].warnings).toEqual(['a.ts:1: path `BASE + "/x"` is not a string literal; shown as *']);
  });
});
