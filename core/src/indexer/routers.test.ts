import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';

const { facts } = snippetProject({
  'api/app.ts': [
    "import express from 'express';",
    "import { api } from './routes';",
    "import { onError } from './errors';",
    'export const app = express();',
    'app.use(express.json());',
    "app.use('/api', api);",
    'app.use(onError);',
  ].join('\n'),
  'api/routes.ts': [
    "import { Router } from 'express';",
    "import { auth, validate, list } from './handlers';",
    'export const api = Router();',
    'api.use(auth);',
    "api.post('/items', [validate('item')], list);",
    "api.route('/items/:id').get(list).delete(auth, list);",
    "api.get('/inline', (req, res) => res.end());",
    "api.get('env');",
  ].join('\n'),
  'api/handlers.ts': [
    'export function auth(req: any, res: any, next: any) { next(); }',
    'export function validate(schema: string) {',
    '  return function check(req: any, res: any, next: any) { next(); };',
    '}',
    'export const list = (req: any, res: any) => res.end();',
  ].join('\n'),
  'api/errors.ts': 'export function onError(err: any, req: any, res: any, next: any) { res.end(); }',
  'api/plugin.ts': [
    "import type { Express } from 'express';",
    "import { list } from './handlers';",
    'export function register(app: Express) {',
    "  app.get('/plugin', list);",
    '}',
  ].join('\n'),
});

describe('collectRouterCalls', () => {
  it('records app registrations: package middleware, mounted routers and error handlers', () => {
    expect(facts('api/app.ts').routerCalls).toEqual([
      {
        receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null,
        path: null, pathText: null, line: 5, endLine: 5, orderIdx: 0,
        handlers: [{ kind: 'package', package: 'express', text: 'express.json()' }],
      },
      {
        receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null,
        path: '/api', pathText: null, line: 6, endLine: 6, orderIdx: 1,
        handlers: [{ kind: 'router', receiverKey: 'api/routes.ts#api', text: 'api' }],
      },
      {
        receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null,
        path: null, pathText: null, line: 7, endLine: 7, orderIdx: 2,
        handlers: [{ kind: 'symbol', key: { file: 'api/errors.ts', name: 'onError', startLine: 1 }, arity: 4, text: 'onError' }],
      },
    ]);
  });

  it('records routes with factories, arrays, .route() chains and inline handlers, and skips settings reads', () => {
    expect(facts('api/routes.ts').routerCalls).toMatchObject([
      { receiver: { key: 'api/routes.ts#api', kind: 'router' }, callKind: 'use', path: null, line: 4, orderIdx: 0,
        handlers: [{ kind: 'symbol', key: { file: 'api/handlers.ts', name: 'auth', startLine: 1 }, arity: 3 }] },
      { callKind: 'route', method: 'POST', path: '/items', line: 5, orderIdx: 1,
        handlers: [
          { kind: 'factory', factory: { file: 'api/handlers.ts', name: 'validate', startLine: 2 },
            key: { file: 'api/handlers.ts', name: 'validate.check', startLine: 3 }, arity: 3, text: "validate('item')" },
          { kind: 'symbol', key: { file: 'api/handlers.ts', name: 'list', startLine: 5 }, arity: 2 },
        ] },
      { method: 'GET', path: '/items/:id', line: 6, orderIdx: 2, handlers: [{ kind: 'symbol', text: 'list' }] },
      { method: 'DELETE', path: '/items/:id', line: 6, orderIdx: 3, handlers: [{ text: 'auth' }, { text: 'list' }] },
      { method: 'GET', path: '/inline', line: 7, orderIdx: 4,
        handlers: [{ kind: 'inline', key: { file: 'api/routes.ts', name: 'api.get /inline', startLine: 7 }, arity: 2 }] },
    ]);
  });

  it('keeps registrations on Express values it cannot place, with a null receiver', () => {
    expect(facts('api/plugin.ts').routerCalls).toMatchObject([
      { receiver: null, receiverText: 'app', callKind: 'route', method: 'GET', path: '/plugin', line: 4 },
    ]);
  });
});
