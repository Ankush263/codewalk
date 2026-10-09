import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { indexRepo } from '../indexer/index.js';
import { openStore, type Store } from '../store/index.js';
import { buildFnContext, type FnContext } from './fn.js';
import { parseFnTarget, TargetError } from './target.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const OPTIONS = { depth: 2, maxContextTokens: 60000 };

describe('parseFnTarget', () => {
  it('parses symbol and line-range targets', () => {
    expect(parseFnTarget('./api/x.ts#run')).toEqual({ kind: 'symbol', file: 'api/x.ts', name: 'run' });
    expect(parseFnTarget('web/A.tsx#A.handleSubmit')).toEqual({ kind: 'symbol', file: 'web/A.tsx', name: 'A.handleSubmit' });
    expect(parseFnTarget('api/x.ts:3-9')).toEqual({ kind: 'range', file: 'api/x.ts', start: 3, end: 9 });
  });

  it('rejects malformed targets', () => {
    expect(() => parseFnTarget('api/x.ts')).toThrow(TargetError);
    expect(() => parseFnTarget('api/x.ts#')).toThrow(TargetError);
    expect(() => parseFnTarget('api/x.ts:9-3')).toThrow(TargetError);
  });
});

describe('buildFnContext on the fixture', () => {
  let store: Store;

  beforeAll(async () => {
    const config = loadConfig(FIXTURE);
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_ctx_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, config, store);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  const build = (arg: string, options = OPTIONS) => buildFnContext(store, FIXTURE, parseFnTarget(arg), options);
  const callees = (ctx: FnContext) =>
    ctx.callees.map((c) => `${c.depth} ${c.calleeText} -> ${c.callee ? c.callee.name : c.resolved ? 'external' : 'unresolved'}`);

  it('collects code, callers, callees, types and packages for a function', async () => {
    const ctx = await build('api/services/enrollService.ts#enrollPatient');

    expect(ctx.target).toMatchObject({ file: 'api/services/enrollService.ts', symbol: { name: 'enrollPatient' } });
    expect(ctx.target.code.lines[0]).toContain('export async function enrollPatient');
    expect(ctx.target.code.lines).toHaveLength(ctx.target.end - ctx.target.start + 1);

    expect(ctx.callers.map((c) => `${c.symbol.file}#${c.symbol.name}:${c.callLine}`)).toEqual([
      'api/controllers/patientsController.ts#enrollHandler:10',
    ]);
    expect(ctx.callers[0].code?.lines.join('\n')).toContain('enrollPatient(req.body, user.id)');

    const direct = callees(ctx).filter((c) => c.startsWith('1 '));
    expect(direct).toEqual(
      expect.arrayContaining([
        '1 normalizePhone -> normalizePhone',
        '1 calculateAge -> calculateAge',
        '1 findPatientByPhone -> findPatientByPhone',
        '1 insertPatient -> insertPatient',
        '1 pool.connect -> external',
        '1 redis.set -> external',
      ]),
    );
    const normalize = ctx.callees.find((c) => c.callee?.name === 'normalizePhone')!;
    expect(normalize.code?.lines.join('\n')).toContain("replace(/\\D/g, '')");

    // Depth 2 reaches into the repository layer; deeper callees carry no body.
    const deeper = ctx.callees.filter((c) => c.depth === 2);
    expect(deeper.length).toBeGreaterThan(0);
    expect(deeper.every((c) => c.code === null)).toBe(true);
    expect(deeper.some((c) => c.caller.name === 'findPatientByPhone')).toBe(true);

    expect(ctx.types.map((t) => t.symbol.name)).toEqual(expect.arrayContaining(['EnrollInput', 'Patient']));
    // Module-level values: a constant in the same file and clients imported from other files.
    expect(ctx.values.map((v) => `${v.file}#${v.name}`)).toEqual([
      'api/db/pool.ts#pool',
      'api/db/redis.ts#redis',
      'api/events/bus.ts#bus',
      'api/services/enrollService.ts#PATIENT_CACHE_TTL_SECONDS',
    ]);
    expect(ctx.values.find((v) => v.name === 'pool')?.code?.lines.join('\n')).toContain('new Pool(');
    // enrollService imports only repo files; its packages come from the files declaring those values.
    expect(ctx.packages.map((p) => p.name)).toEqual(['pg', 'ioredis', 'node']);

    expect(Object.keys(ctx.files)).toEqual(
      expect.arrayContaining(['api/services/enrollService.ts', 'api/controllers/patientsController.ts', 'api/repositories/patientRepository.ts']),
    );
    expect(ctx.files['api/services/enrollService.ts']).toBeGreaterThanOrEqual(ctx.target.end);
    expect(ctx.warnings).toEqual([]);
  });

  it('respects --depth', async () => {
    const ctx = await build('api/services/enrollService.ts#enrollPatient', { ...OPTIONS, depth: 1 });
    expect(ctx.callees.every((c) => c.depth === 1)).toBe(true);
  });

  it('lists packages imported by the target file', async () => {
    const ctx = await build('api/controllers/patientsController.ts#enrollHandler');
    expect(ctx.packages).toEqual([{ name: 'express', version: '^4.19.2', importedPath: 'express', importedNames: ['NextFunction', 'Request', 'Response'] }]);
  });

  it('surfaces dynamic calls as unresolved', async () => {
    const ctx = await build('api/events/handlers.ts#dispatch');
    expect(ctx.unresolved.map((u) => u.note)).toEqual([
      expect.stringMatching(/^unresolved: likely handlers\[name\] \(dynamic call in dispatch at api\/events\/handlers\.ts:\d+\)$/),
    ]);
  });

  it('limits a line range to the calls inside it', async () => {
    // Lines 36-37 of enrollService: the normalizePhone and calculateAge calls, not the age check after them.
    const ctx = await build('api/services/enrollService.ts:36-37');
    expect(ctx.target.symbol?.name).toBe('enrollPatient');
    expect(callees(ctx).filter((c) => c.startsWith('1 '))).toEqual(['1 normalizePhone -> normalizePhone', '1 calculateAge -> calculateAge']);
  });

  it('includes calls made by functions nested in the target', async () => {
    const ctx = await build('web/components/EnrollForm.tsx#EnrollForm');
    expect(ctx.innerSymbols.map((s) => s.name)).toContain('EnrollForm.handleSubmit');
    expect(ctx.callees.some((c) => c.caller.name === 'EnrollForm.handleSubmit')).toBe(true);
  });

  it('explains what is wrong with a bad target', async () => {
    await expect(build('api/nope.ts#x')).rejects.toThrow(/not in the index/);
    await expect(build('api/services/enrollService.ts#nope')).rejects.toThrow(/Available: .*enrollPatient/);
    await expect(build('api/services/enrollService.ts:1-9999')).rejects.toThrow(/out of bounds/);
  });

  it('fails clearly when the target does not fit the token budget', async () => {
    await expect(build('api/services/enrollService.ts#enrollPatient', { depth: 1, maxContextTokens: 3100 })).rejects.toThrow(/too large/);
  });

  it('drops callee bodies first when the budget is tight', async () => {
    const ctx = await build('api/services/enrollService.ts#enrollPatient', { depth: 1, maxContextTokens: 3500 });
    expect(ctx.omitted.length).toBeGreaterThan(0);
  });
});
