import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseUnreachableError, InvalidSchemaNameError, openStore, type Store } from './store.js';
import type { FileFacts } from './types.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';

// Small two-file graph:
//   service.ts: enroll -> normalize, enroll -> pool.query (package), enroll -> handlers[name] (dynamic)
//               ping <-> pong (mutual recursion)
//   controller.ts: handle -> enroll (cross-file)
const service: FileFacts = {
  path: 'api/service.ts',
  hash: 'hash-service-1',
  language: 'typescript',
  symbols: [
    { name: 'normalize', kind: 'function', startLine: 1, endLine: 3, exported: true, signature: '(s: string) => string' },
    { name: 'enroll', kind: 'function', startLine: 5, endLine: 12, exported: true, signature: '(input: Input) => Promise<void>' },
    { name: 'ping', kind: 'function', startLine: 14, endLine: 16, exported: false, signature: null },
    { name: 'pong', kind: 'function', startLine: 18, endLine: 20, exported: false, signature: null },
  ],
  calls: [
    { caller: { name: 'enroll', startLine: 5 }, callee: { file: 'api/service.ts', name: 'normalize', startLine: 1 }, calleeText: 'normalize', line: 6, resolved: true },
    { caller: { name: 'enroll', startLine: 5 }, callee: null, calleeText: 'pool.query', line: 8, resolved: true },
    { caller: { name: 'enroll', startLine: 5 }, callee: null, calleeText: 'handlers[name]', line: 10, resolved: false },
    { caller: { name: 'ping', startLine: 14 }, callee: { file: 'api/service.ts', name: 'pong', startLine: 18 }, calleeText: 'pong', line: 15, resolved: true },
    { caller: { name: 'pong', startLine: 18 }, callee: { file: 'api/service.ts', name: 'ping', startLine: 14 }, calleeText: 'ping', line: 19, resolved: true },
  ],
  imports: [
    { importedPath: 'pg', resolvedPath: null, importedNames: ['Pool'], packageName: 'pg', packageVersion: '8.12.0' },
  ],
};

const controller: FileFacts = {
  path: 'api/controller.ts',
  hash: 'hash-controller-1',
  language: 'typescript',
  symbols: [{ name: 'handle', kind: 'function', startLine: 3, endLine: 7, exported: true, signature: null }],
  calls: [
    { caller: { name: 'handle', startLine: 3 }, callee: { file: 'api/service.ts', name: 'enroll', startLine: 5 }, calleeText: 'enroll', line: 4, resolved: true },
  ],
  imports: [
    { importedPath: './service', resolvedPath: 'api/service.ts', importedNames: ['enroll'], packageName: null, packageVersion: null },
  ],
};

describe('store', () => {
  let store: Store;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_${randomBytes(4).toString('hex')}` });
    await store.migrate();
    await store.applyIndexChanges({ files: [service, controller] });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('migrate is idempotent', async () => {
    await expect(store.migrate()).resolves.toBeUndefined();
  });

  it('returns file hashes for incremental indexing', async () => {
    expect(await store.getFileHashes()).toEqual(
      new Map([
        ['api/service.ts', 'hash-service-1'],
        ['api/controller.ts', 'hash-controller-1'],
      ]),
    );
  });

  it('finds symbols by name and by line range', async () => {
    const [enroll] = await store.findSymbol('api/service.ts', 'enroll');
    expect(enroll).toMatchObject({ file: 'api/service.ts', name: 'enroll', kind: 'function', startLine: 5, endLine: 12 });
    expect(typeof enroll.id).toBe('number');

    expect(await store.findSymbol('api/service.ts', 'missing')).toEqual([]);

    const inRange = await store.findSymbolsInRange('api/service.ts', 2, 6);
    expect(inRange.map((s) => s.name)).toEqual(['normalize', 'enroll']);
  });

  it('looks up a file, its symbols and its imports', async () => {
    expect(await store.getFile('api/service.ts')).toEqual({ path: 'api/service.ts', hash: 'hash-service-1' });
    expect(await store.getFile('api/missing.ts')).toBeNull();

    expect((await store.getSymbolsInFile('api/service.ts')).map((s) => s.name)).toEqual(['normalize', 'enroll', 'ping', 'pong']);

    expect(await store.getImportsForFile('api/service.ts')).toEqual([
      { importedPath: 'pg', resolvedPath: null, importedNames: ['Pool'], packageName: 'pg', packageVersion: '8.12.0' },
    ]);
  });

  it('returns direct callers across files', async () => {
    const [enroll] = await store.findSymbol('api/service.ts', 'enroll');
    const callers = await store.getCallers(enroll.id);
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatchObject({ caller: { file: 'api/controller.ts', name: 'handle' }, callLine: 4 });
  });

  it('returns callees including package and unresolved calls', async () => {
    const [enroll] = await store.findSymbol('api/service.ts', 'enroll');
    const callees = await store.getCallees(enroll.id, 1);
    expect(callees.map((c) => [c.calleeText, c.callee?.name ?? null, c.resolved])).toEqual([
      ['normalize', 'normalize', true],
      ['pool.query', null, true],
      ['handlers[name]', null, false],
    ]);
  });

  it('walks callees transitively up to the depth limit', async () => {
    const [handle] = await store.findSymbol('api/controller.ts', 'handle');
    const depth1 = await store.getCallees(handle.id, 1);
    expect(depth1.map((c) => c.calleeText)).toEqual(['enroll']);

    const depth2 = await store.getCallees(handle.id, 2);
    expect(depth2.map((c) => [c.depth, c.calleeText])).toEqual([
      [1, 'enroll'],
      [2, 'normalize'],
      [2, 'pool.query'],
      [2, 'handlers[name]'],
    ]);
  });

  it('terminates on cycles', async () => {
    const [ping] = await store.findSymbol('api/service.ts', 'ping');
    const callees = await store.getCallees(ping.id, 10);
    expect(callees.map((c) => [c.depth, c.calleeText])).toEqual([
      [1, 'pong'],
      [2, 'ping'],
    ]);
  });

  it('reports importers of a file', async () => {
    expect(await store.getImporters(['api/service.ts'])).toEqual(['api/controller.ts']);
    expect(await store.getImporters(['api/controller.ts'])).toEqual([]);
  });

  it('keeps a callee key that matches nothing as an unresolved edge', async () => {
    const orphan: FileFacts = {
      path: 'api/orphan.ts',
      hash: 'h',
      language: 'typescript',
      symbols: [{ name: 'run', kind: 'function', startLine: 1, endLine: 2, exported: false, signature: null }],
      calls: [{ caller: { name: 'run', startLine: 1 }, callee: { file: 'api/nope.ts', name: 'x', startLine: 1 }, calleeText: 'x', line: 1, resolved: true }],
      imports: [],
    };
    await store.applyIndexChanges({ files: [orphan] });
    const [run] = await store.findSymbol('api/orphan.ts', 'run');
    expect(await store.getCallees(run.id, 1)).toMatchObject([{ calleeText: 'x', callee: null, resolved: false }]);
    await store.applyIndexChanges({ removedPaths: ['api/orphan.ts'] });
    expect(await store.findSymbol('api/orphan.ts', 'run')).toEqual([]);
  });

  it('rolls back the whole batch when a fact is invalid', async () => {
    const bad: FileFacts = {
      ...controller,
      hash: 'hash-controller-bad',
      calls: [{ ...controller.calls[0], caller: { name: 'doesNotExist', startLine: 99 } }],
    };
    await expect(store.applyIndexChanges({ files: [bad] })).rejects.toThrow(/Expected to insert 1 calls rows but inserted 0/);
    expect((await store.getFileHashes()).get('api/controller.ts')).toBe('hash-controller-1');
  });

  it('reports files that call into a file', async () => {
    expect(await store.getCallerFiles(['api/service.ts'])).toEqual(['api/controller.ts']);
    expect(await store.getCallerFiles(['api/service.ts', 'api/controller.ts'])).toEqual([]);
  });

  it('counts rows for summaries', async () => {
    expect(await store.getIndexStats()).toEqual({ files: 2, symbols: 5, calls: 6, unresolved: 1 });
  });

  it('replacing a file cascades edges into it; a call refresh rebuilds them and keeps symbol ids', async () => {
    const [handleBefore] = await store.findSymbol('api/controller.ts', 'handle');

    // enroll moved down two lines.
    const changed: FileFacts = {
      ...service,
      hash: 'hash-service-2',
      symbols: service.symbols.map((s) => (s.name === 'enroll' ? { ...s, startLine: 7, endLine: 14 } : s)),
      calls: service.calls.map((c) => (c.caller.name === 'enroll' ? { ...c, caller: { name: 'enroll', startLine: 7 } } : c)),
    };
    await store.applyIndexChanges({ files: [changed] });
    expect((await store.getFileHashes()).get('api/service.ts')).toBe('hash-service-2');
    // handle -> enroll pointed at the old enroll row, so it is gone until controller.ts is refreshed.
    expect(await store.getCallees(handleBefore.id, 1)).toEqual([]);

    const refreshedCalls = controller.calls.map((c) => ({ ...c, callee: { ...c.callee!, startLine: 7 } }));
    await store.applyIndexChanges({ callRefreshes: [{ path: 'api/controller.ts', calls: refreshedCalls }] });
    const [handleAfter] = await store.findSymbol('api/controller.ts', 'handle');
    expect(handleAfter.id).toBe(handleBefore.id);
    expect((await store.getCallees(handleAfter.id, 1)).map((c) => [c.callee?.name, c.callee?.startLine])).toEqual([['enroll', 7]]);
    // Refreshing twice doesn't duplicate edges.
    await store.applyIndexChanges({ callRefreshes: [{ path: 'api/controller.ts', calls: refreshedCalls }] });
    expect(await store.getCallees(handleAfter.id, 1)).toHaveLength(1);
  });

  it('lists the files importing a file, with the names they import', async () => {
    expect(await store.getImportersOf('api/service.ts')).toEqual([{ file: 'api/controller.ts', importedNames: ['enroll'] }]);
    expect(await store.getImportersOf('api/controller.ts')).toEqual([]);
  });

  it('lists a file that imports another twice (e.g. type and value imports) once, with all names', async () => {
    const twice: FileFacts = {
      path: 'api/twice.ts',
      hash: 'hash-twice',
      language: 'typescript',
      symbols: [],
      calls: [],
      imports: [
        { importedPath: './service', resolvedPath: 'api/service.ts', importedNames: ['normalize'], packageName: null, packageVersion: null },
        { importedPath: './service', resolvedPath: 'api/service.ts', importedNames: ['enroll', 'normalize'], packageName: null, packageVersion: null },
      ],
    };
    await store.applyIndexChanges({ files: [twice] });
    try {
      expect(await store.getImportersOf('api/service.ts')).toEqual([
        { file: 'api/controller.ts', importedNames: ['enroll'] },
        { file: 'api/twice.ts', importedNames: ['enroll', 'normalize'] },
      ]);
    } finally {
      await store.applyIndexChanges({ removedPaths: ['api/twice.ts'] });
    }
  });

  it('returns resolved call edges within one file only', async () => {
    const names = new Map((await store.getSymbolsInFile('api/service.ts')).map((s) => [s.id, s.name]));
    const edges = (await store.getCallEdgesInFile('api/service.ts')).map((e) => `${names.get(e.callerId)}->${names.get(e.calleeId)}`);
    expect(edges.sort()).toEqual(['enroll->normalize', 'ping->pong', 'pong->ping']);
    // handle -> enroll crosses files, so the controller has no in-file edges.
    expect(await store.getCallEdgesInFile('api/controller.ts')).toEqual([]);
  });

  it('saves one walkthrough per scope and replaces it on re-save', async () => {
    expect(await store.getWalkthrough('fn', 'api/service.ts#enroll')).toBeNull();

    await store.saveWalkthrough({ scopeKind: 'fn', scopeRef: 'api/service.ts#enroll', contentHash: 'h1', content: { v: 1 } });
    await store.saveWalkthrough({ scopeKind: 'fn', scopeRef: 'api/service.ts#enroll', contentHash: 'h2', content: { v: 2 } });
    await store.saveWalkthrough({ scopeKind: 'file', scopeRef: 'api/service.ts', contentHash: 'h3', content: { v: 3 } });

    const saved = await store.getWalkthrough('fn', 'api/service.ts#enroll');
    expect(saved).toMatchObject({ scopeKind: 'fn', scopeRef: 'api/service.ts#enroll', contentHash: 'h2', content: { v: 2 } });
    expect(saved!.createdAt).toBeInstanceOf(Date);
    expect((await store.listWalkthroughs()).map((w) => `${w.scopeKind} ${w.scopeRef}`)).toEqual(['file api/service.ts', 'fn api/service.ts#enroll']);
  });

  it('keeps the saved time when the same content is saved again', async () => {
    const save = (v: number) => store.saveWalkthrough({ scopeKind: 'fn', scopeRef: 'api/service.ts#ping', contentHash: `h${v}`, content: { v } });
    await save(1);
    const first = (await store.getWalkthrough('fn', 'api/service.ts#ping'))!.createdAt;
    await new Promise((r) => setTimeout(r, 20));
    await save(1);
    expect((await store.getWalkthrough('fn', 'api/service.ts#ping'))!.createdAt).toEqual(first);
    await save(2);
    expect((await store.getWalkthrough('fn', 'api/service.ts#ping'))!.createdAt.getTime()).toBeGreaterThan(first.getTime());
  });
});

describe('openStore', () => {
  it('rejects unsafe schema names', async () => {
    await expect(openStore({ url: DATABASE_URL, schema: 'cw"; DROP TABLE x; --' })).rejects.toBeInstanceOf(InvalidSchemaNameError);
  });

  it('throws DatabaseUnreachableError with a redacted URL when Postgres is down', async () => {
    const error = await openStore({ url: 'postgres://codewalk:secret@localhost:1/codewalk', schema: 'cw_x' }).catch((e) => e);
    expect(error).toBeInstanceOf(DatabaseUnreachableError);
    expect(error.message).toContain('***');
    expect(error.message).not.toContain('secret');
  });
});

describe('store: routes and side effects', () => {
  let store: Store;

  const appFile: FileFacts = {
    path: 'api/app.ts',
    hash: 'h-app',
    language: 'typescript',
    symbols: [{ name: 'createApp', kind: 'function', startLine: 3, endLine: 9, exported: true, signature: null }],
    calls: [],
    imports: [],
    routerCalls: [
      { receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null, path: null, pathText: null, line: 4, endLine: 4, orderIdx: 0,
        handlers: [{ kind: 'package', package: 'express', text: 'express.json()' }] },
      { receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null, path: null, pathText: null, line: 5, endLine: 5, orderIdx: 1,
        handlers: [{ kind: 'unresolved', text: 'middlewares[0]' }] },
      { receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null, path: '/api', pathText: null, line: 6, endLine: 6, orderIdx: 2,
        handlers: [{ kind: 'router', receiverKey: 'api/routes.ts#r', text: 'r' }] },
    ],
  };
  const routesFile: FileFacts = {
    path: 'api/routes.ts',
    hash: 'h-routes',
    language: 'typescript',
    symbols: [
      { name: 'auth', kind: 'function', startLine: 3, endLine: 5, exported: false, signature: null },
      { name: 'create', kind: 'function', startLine: 7, endLine: 12, exported: false, signature: null },
    ],
    calls: [],
    imports: [],
    routerCalls: [
      { receiver: { key: 'api/routes.ts#r', kind: 'router' }, receiverText: 'r', callKind: 'route', method: 'POST', path: '/items', pathText: null, line: 14, endLine: 15, orderIdx: 0,
        handlers: [
          { kind: 'symbol', key: { file: 'api/routes.ts', name: 'auth', startLine: 3 }, arity: 3, text: 'auth' },
          { kind: 'symbol', key: { file: 'api/routes.ts', name: 'create', startLine: 7 }, arity: 2, text: 'create' },
        ] },
    ],
    sideEffects: [{ symbol: { name: 'create', startLine: 7 }, kind: 'db_write', detail: 'INSERT items', line: 9 }],
  };

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_routes_${randomBytes(4).toString('hex')}` });
    await store.migrate();
    await store.applyIndexChanges({ files: [appFile, routesFile] });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('stitches stored registrations into full routes with resolved handlers', async () => {
    const routes = await store.listRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'POST',
      fullPath: '/api/items',
      handlerLabel: 'create',
      handler: { file: 'api/routes.ts', name: 'create', startLine: 7 },
      file: 'api/routes.ts',
      line: 14,
      endLine: 15,
      mountChain: [{ file: 'api/app.ts', line: 6, endLine: 6, prefix: '/api' }],
      warnings: [],
    });
  });

  it('returns the middleware chain in order with symbols, labels and unresolved notes', async () => {
    const [route] = await store.listRoutes();
    const chain = await store.getMiddlewareChain(route.id);
    expect(chain.map((m) => [m.orderIdx, m.phase, m.label, m.symbol?.name ?? null, m.unresolvedNote])).toEqual([
      [0, 'app', 'express.json()', null, null],
      [1, 'app', 'middlewares[0]', null, 'unresolved: likely middlewares[0] (middleware registered at api/app.ts:5)'],
      [2, 'route', 'auth', 'auth', null],
    ]);
  });

  it('stores side effects per symbol', async () => {
    const [create] = await store.findSymbol('api/routes.ts', 'create');
    expect(await store.getSideEffects([create.id])).toEqual([{ symbolId: create.id, kind: 'db_write', detail: 'INSERT items', line: 9 }]);
  });

  it('rebuilds routes after a refresh and records routers it cannot reach', async () => {
    await store.applyIndexChanges({ callRefreshes: [{ path: 'api/app.ts', calls: [], routerCalls: [], sideEffects: [] }] });
    expect(await store.listRoutes()).toEqual([]);
    expect(await store.getRouteWarnings()).toEqual(['api/routes.ts: router `r` has routes but is never mounted on an app']);
  });
});

describe('store: React facts, API calls and index settings', () => {
  let store: Store;
  const form: FileFacts = {
    path: 'web/Form.tsx',
    hash: 'h-form-1',
    language: 'typescript',
    symbols: [
      { name: 'Form', kind: 'component', startLine: 3, endLine: 12, exported: true, signature: null },
      { name: 'Form.submit', kind: 'function', startLine: 5, endLine: 7, exported: false, signature: null },
    ],
    calls: [],
    imports: [],
    reactFacts: [
      {
        symbol: { name: 'Form', startLine: 3 },
        propsType: 'Props',
        props: ['onDone'],
        state: [{ name: 'v', setter: 'setV', hook: 'useState', initial: "''", line: 4 }],
        hooks: [{ name: 'useSave', line: 8, callee: { file: 'web/useSave.ts', name: 'useSave', startLine: 1 }, package: null, bindings: ['save'], callbacks: [] }],
        context: [],
        effects: [{ hook: 'useEffect', line: 9, endLine: 9, deps: null, binding: null }],
        render: [{ element: 'form', kind: 'element', line: 10, depth: 0, component: null, package: null, props: [{ name: 'onSubmit', value: 'submit' }], condition: null }],
        handlers: [{ element: 'form', event: 'onSubmit', handler: 'submit', line: 10, endLine: 10, target: { file: 'web/Form.tsx', name: 'Form.submit', startLine: 5 } }],
      },
    ],
    apiCalls: [],
  };
  const useSave: FileFacts = {
    path: 'web/useSave.ts',
    hash: 'h-save-1',
    language: 'typescript',
    symbols: [{ name: 'useSave', kind: 'hook', startLine: 1, endLine: 6, exported: true, signature: null }],
    calls: [],
    imports: [],
    reactFacts: [{ symbol: { name: 'useSave', startLine: 1 }, propsType: null, props: [], state: [], hooks: [], context: [], effects: [], render: [], handlers: [] }],
    apiCalls: [{ symbol: { name: 'useSave', startLine: 1 }, method: 'POST', urlPattern: '/api/save', urlText: "'/api/save'", line: 3 }],
  };
  const idOf = async (file: string, name: string) => (await store.findSymbol(file, name))[0].id;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_react_${randomBytes(4).toString('hex')}` });
    await store.migrate();
    await store.applyIndexChanges({ files: [form, useSave] });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('round-trips React facts', async () => {
    const formId = await idOf('web/Form.tsx', 'Form');
    const { symbol: _, ...rest } = form.reactFacts![0];
    expect(await store.getReactFacts([formId])).toEqual([{ symbolId: formId, ...rest }]);
  });

  it('round-trips API calls', async () => {
    const hookId = await idOf('web/useSave.ts', 'useSave');
    expect(await store.getApiCalls([hookId])).toEqual([
      { id: expect.any(Number), symbolId: hookId, method: 'POST', urlPattern: '/api/save', urlText: "'/api/save'", line: 3 },
    ]);
  });

  it('finds symbols by key in one query, leaving out keys that match nothing', async () => {
    const found = await store.getSymbolsByKeys([
      { file: 'web/useSave.ts', name: 'useSave', startLine: 1 },
      { file: 'web/Form.tsx', name: 'Form.submit', startLine: 5 },
      { file: 'web/Form.tsx', name: 'Nope', startLine: 1 },
    ]);
    expect(found.map((s) => `${s.file}#${s.name}`)).toEqual(['web/Form.tsx#Form.submit', 'web/useSave.ts#useSave']);
  });

  it('a call refresh replaces React facts and API calls, keeping symbol ids', async () => {
    const hookId = await idOf('web/useSave.ts', 'useSave');
    await store.applyIndexChanges({
      callRefreshes: [
        {
          path: 'web/useSave.ts',
          calls: [],
          reactFacts: useSave.reactFacts,
          apiCalls: [{ symbol: { name: 'useSave', startLine: 1 }, method: 'PUT', urlPattern: '/api/save/:id', urlText: '`/api/save/${id}`', line: 4 }],
        },
      ],
    });
    expect((await store.getApiCalls([hookId])).map((c) => `${c.method} ${c.urlPattern}`)).toEqual(['PUT /api/save/:id']);
    expect(await store.getReactFacts([hookId])).toHaveLength(1);
  });

  it('stores index settings; resetting one clears every file hash', async () => {
    expect(await store.getIndexSetting('extraction')).toBeNull();
    await store.resetIndexForSetting('extraction', 'v1');
    expect(await store.getIndexSetting('extraction')).toBe('v1');
    expect(new Set((await store.getFileHashes()).values())).toEqual(new Set(['']));
  });
});
