import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, createLineStubProvider, openStore } from '@codewalk/core';
import { runFile, type FileOptions } from './file.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const SERVICE = 'api/services/enrollService.ts';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) }, out, err };
}

const opts = (o: Partial<FileOptions> = {}): FileOptions => ({ llm: true, depth: 2, out: 'terminal', refresh: false, ...o });

describe('walk file', () => {
  let repo: string;
  let schema: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-file-cli-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_filecli_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  });

  afterAll(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('--no-llm prints the role, export map and helpers-first order', async () => {
    const { io, out } = captureIO();
    expect(await runFile(repo, SERVICE, opts({ llm: false }), io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`file ${SERVICE} — 81 lines`);
    expect(text).toContain('Imported by\n  api/controllers/patientsController.ts  (enrollPatient, getPatient)');
    expect(text).toContain(`Walk order (helpers first)\n  1. normalizePhone  ${SERVICE}:17-20\n  2. calculateAge`);
  });

  it('explains each function, saves, and reuses everything on the next run', async () => {
    const stub = createLineStubProvider();
    const first = captureIO();
    expect(await runFile(repo, SERVICE, opts(), first.io, { provider: stub, interactive: false })).toBe(0);
    expect(stub.targets).toHaveLength(4);
    const text = first.out.join('\n');
    expect(text).toContain(`How ${SERVICE} works`);
    expect(text).toContain('Walk order (helpers first): normalizePhone → calculateAge → enrollPatient → getPatient');
    expect(text).toContain('== normalizePhone · Body ==');
    expect(first.err.join('\n')).toMatch(/Saved \.walkthrough\/walkthroughs\/file--.*\.md \(4 generated, 0 reused\)/);

    const again = createLineStubProvider();
    const second = captureIO();
    expect(await runFile(repo, SERVICE, opts({ out: 'json' }), second.io, { provider: again })).toBe(0);
    expect(again.targets).toEqual([]);
    expect(second.err.join('\n')).toContain('(0 generated, 4 reused)');
    // Same JSON shape as `walk fn --out json`: the stepper walkthrough plus the file overview.
    const json = JSON.parse(second.out.join('\n'));
    expect(json.title).toBe(`How ${SERVICE} works`);
    expect(json.stages.map((s: { name: string }) => s.name)).toEqual(['normalizePhone · Body', 'calculateAge · Body', 'enrollPatient · Body', 'getPatient · Body']);
    expect(json.overview.order).toHaveLength(4);
  });

  it('--out md prints one section per function', async () => {
    const { io, out } = captureIO();
    expect(await runFile(repo, SERVICE, opts({ out: 'md' }), io, { provider: createLineStubProvider() })).toBe(0);
    expect(out.join('\n')).toContain(`## 1. normalizePhone (\`${SERVICE}:17-20\`)`);
  });

  it('handles a file without functions without calling the LLM', async () => {
    const stub = createLineStubProvider();
    const { io, out, err } = captureIO();
    expect(await runFile(repo, 'web/types.ts', opts(), io, { provider: stub, interactive: false })).toBe(0);
    expect(stub.targets).toEqual([]);
    expect(out.join('\n')).toContain('Walk order (helpers first): no functions');
    expect(err.join('\n')).toContain('No functions to explain in web/types.ts; showing its overview.');
    expect(err.join('\n')).not.toContain('Explaining');
  });

  it('reports a file that is not indexed, or a fn-style target', async () => {
    const missing = captureIO();
    expect(await runFile(repo, 'api/nope.ts', opts(), missing.io)).toBe(1);
    expect(missing.err[0]).toMatch(/^✖ api\/nope\.ts is not in the index/);

    const fnStyle = captureIO();
    expect(await runFile(repo, `${SERVICE}#enrollPatient`, opts(), fnStyle.io)).toBe(1);
    expect(fnStyle.err[0]).toMatch(/use `walk fn/);
  });
});
