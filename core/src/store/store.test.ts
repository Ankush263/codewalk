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
