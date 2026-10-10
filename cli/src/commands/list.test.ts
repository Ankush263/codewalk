import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, createLineStubProvider, openStore, type LlmProvider } from '@codewalk/core';
import type { ListRow } from '../ui/format.js';
import { runFile } from './file.js';
import { runFn } from './fn.js';
import { runList } from './list.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const SERVICE = 'api/services/enrollService.ts';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) }, out, err };
}

// Phase 2 acceptance (CLAUDE.md §12): editing one function marks only the affected steps stale.
describe('walk list', () => {
  let repo: string;
  let schema: string;
  const fileOpts = { llm: true, depth: 2, out: 'json' as const, refresh: false };
  const editService = (change: (text: string) => string) => writeFileSync(join(repo, SERVICE), change(readFileSync(join(repo, SERVICE), 'utf8')));
  const list = async () => {
    const { io, out } = captureIO();
    expect(await runList(repo, { out: 'terminal' }, io)).toBe(0);
    return out.join('\n');
  };
  const rows = async () => {
    const { io, out } = captureIO();
    expect(await runList(repo, { out: 'json' }, io)).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as ListRow[];
    return { file: parsed.find((r) => r.scopeKind === 'file')!, fn: parsed.find((r) => r.scopeKind === 'fn')! };
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-list-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_list_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  });

  afterAll(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('says how to start when nothing is saved', async () => {
    expect(await list()).toBe('No saved walkthroughs yet. Run `walk fn`, `walk file`, `walk endpoint` or `walk component` to create one.');
  });

  it('shows fresh walkthroughs after generating them', async () => {
    const stub = createLineStubProvider();
    expect(await runFile(repo, SERVICE, fileOpts, captureIO().io, { provider: stub })).toBe(0);
    expect(await runFn(repo, `${SERVICE}#enrollPatient`, fileOpts, captureIO().io, { provider: stub })).toBe(0);

    const text = await list();
    expect(text).toMatch(/^fresh {2}file {2}api\/services\/enrollService\.ts\s+61 steps · saved \d{4}-\d\d-\d\d \d\d:\d\d$/m);
    expect(text).toMatch(/^fresh {2}fn {4}api\/services\/enrollService\.ts#enrollPatient\s+35 steps · saved /m);
  });

  it('editing one line of normalizePhone marks only that step stale', async () => {
    editService((t) => t.replace("phone.replace(/\\D/g, '')", "phone.replace(/[^0-9]/g, '')"));

    const { file, fn } = await rows();
    expect(file.status).toMatchObject({ fresh: false, staleSteps: 1, totalSteps: 61, uncovered: [] });
    expect(file.status.sections.map((s) => [s.symbol, s.state])).toEqual([
      ['normalizePhone', 'changed'],
      ['calculateAge', 'fresh'],
      ['enrollPatient', 'fresh'],
      ['getPatient', 'fresh'],
    ]);
    expect(file.status.sections[0].steps.filter((s) => !s.fresh).map((s) => s.start)).toEqual([18]);
    expect(fn.status).toMatchObject({ fresh: true, staleSteps: 0, totalSteps: 35 });

    expect(await list()).toMatch(/^stale {2}file {2}api\/services\/enrollService\.ts\s+1\/61 steps stale · changed: normalizePhone · saved /m);
  });

  it('a line added above every function moves them without making them stale', async () => {
    editService((t) => `// enrollment service\n${t}`);
    const { file, fn } = await rows();
    expect(file.status).toMatchObject({ staleSteps: 1, totalSteps: 61 });
    expect(file.status.sections.filter((s) => s.state !== 'fresh').map((s) => s.symbol)).toEqual(['normalizePhone']);
    expect(fn.status.fresh).toBe(true);
    expect(fn.status.sections[0].current).toEqual({ start: 36, end: 70 });
  });

  it('walk file regenerates only the stale function, and everything is fresh again', async () => {
    const stub = createLineStubProvider();
    expect(await runFile(repo, SERVICE, fileOpts, captureIO().io, { provider: stub })).toBe(0);
    expect(stub.targets).toEqual([`${SERVICE}:18-21`]);

    const unused: LlmProvider = { generate: async () => { throw new Error('should not be called'); } };
    const { io, out } = captureIO();
    expect(await runFn(repo, `${SERVICE}#enrollPatient`, fileOpts, io, { provider: unused })).toBe(0);
    expect(JSON.parse(out.join('\n')).stages[0].steps[0].code_ref.start).toBe(36);

    const { file, fn } = await rows();
    expect(file.status.fresh).toBe(true);
    expect(fn.status.fresh).toBe(true);
  });
});
