import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, openStore, type LlmProvider } from '@codewalk/core';
import { runFn, type FnOptions } from './fn.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../../../core/src/llm/__fixtures__/enrollPatient.response.json', import.meta.url), 'utf8');
const TARGET = 'api/services/enrollService.ts#enrollPatient';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) }, out, err };
}

const recorded: LlmProvider = { generate: async () => RECORDED };
const opts = (o: Partial<FnOptions> = {}): FnOptions => ({ llm: true, depth: 2, out: 'terminal', refresh: false, ...o });

describe('walk fn', () => {
  let repo: string;
  let schema: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-fn-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_fn_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  });

  afterAll(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('--no-llm prints the static facts, indexing first if needed', async () => {
    const { io, out } = captureIO();
    expect(await runFn(join(repo, 'api'), TARGET, opts({ llm: false }), io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('function enrollPatient — api/services/enrollService.ts:35-69');
    expect(text).toMatch(/Callers\n\s+enrollHandler\s+api\/controllers\/patientsController\.ts:10/);
    expect(text).toContain('line 36  normalizePhone  api/services/enrollService.ts:17');
    expect(text).toContain('unresolved: likely bus.emit');
  });

  it('--no-llm --out json prints the context object', async () => {
    const { io, out } = captureIO();
    expect(await runFn(repo, TARGET, opts({ llm: false, out: 'json' }), io)).toBe(0);
    const ctx = JSON.parse(out.join('\n'));
    expect(ctx.target.symbol.name).toBe('enrollPatient');
    expect(ctx.values.map((v: { name: string }) => v.name)).toContain('pool');
  });

  it('prints a verified walkthrough when not attached to a terminal', async () => {
    const { io, out, err } = captureIO();
    expect(await runFn(repo, TARGET, opts(), io, { provider: recorded, interactive: false })).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/-- Step 1\/13: api\/services\/enrollService\.ts:36-37/);
    expect(text).toContain('Example  ');
    expect(text).toContain('https://redis.io/docs/latest/commands/set/');
    expect(text).toContain('Verified: 13 step(s) kept, 0 dropped.');
    expect(err.join('\n')).toContain('with claude-sonnet-5');
  });

  it('--out json prints the verified walkthrough', async () => {
    const { io, out } = captureIO();
    expect(await runFn(repo, TARGET, opts({ out: 'json' }), io, { provider: recorded })).toBe(0);
    const w = JSON.parse(out.join('\n'));
    expect(w.verification.keptSteps).toBe(13);
    expect(w.overview).toBeNull();
    expect(w.stages[0].steps[0].docLinks).toEqual([]);
  });

  it('reports a bad target without a stack trace', async () => {
    const { io, err } = captureIO();
    expect(await runFn(repo, 'api/services/enrollService.ts', opts(), io)).toBe(1);
    expect(err[0]).toMatch(/^✖ Expected <file>#<symbolName>/);

    const missing = captureIO();
    expect(await runFn(repo, 'api/services/enrollService.ts#nope', opts({ llm: false }), missing.io)).toBe(1);
    expect(missing.err[0]).toMatch(/^✖ No symbol "nope"/);
  });

  it('reports LLM failures', async () => {
    const { io, err } = captureIO();
    const broken: LlmProvider = { generate: async () => 'not json' };
    expect(await runFn(repo, TARGET, opts({ refresh: true }), io, { provider: broken, interactive: false })).toBe(1);
    expect(err.at(-1)).toMatch(/invalid output 3 times/);
  });

  it('reuses the saved walkthrough when the code is unchanged', async () => {
    const { io, err } = captureIO();
    const unused: LlmProvider = { generate: async () => { throw new Error('should not be called'); } };
    expect(await runFn(repo, TARGET, opts(), io, { provider: unused, interactive: false })).toBe(0);
    expect(err.join('\n')).toContain('showing the saved walkthrough');
  });

  it('regenerates when --depth differs from the saved walkthrough', async () => {
    let calls = 0;
    const counting: LlmProvider = { generate: async () => { calls++; return RECORDED; } };
    const { io, err } = captureIO();
    expect(await runFn(repo, TARGET, opts({ depth: 3, out: 'json' }), io, { provider: counting })).toBe(0);
    expect(calls).toBe(1);
    expect(err.join('\n')).toContain('Explaining');
    // And the depth-3 walkthrough is now the saved one: depth 3 again reuses it.
    expect(await runFn(repo, TARGET, opts({ depth: 3, out: 'json' }), captureIO().io, { provider: counting })).toBe(0);
    expect(calls).toBe(1);
  });

  it('--refresh regenerates even when the code is unchanged', async () => {
    let calls = 0;
    const counting: LlmProvider = { generate: async () => { calls++; return RECORDED; } };
    expect(await runFn(repo, TARGET, opts({ refresh: true, out: 'json' }), captureIO().io, { provider: counting })).toBe(0);
    expect(calls).toBe(1);
  });

  it('--out md prints Markdown, and the walkthrough is mirrored to .walkthrough/walkthroughs', async () => {
    const { io, out, err } = captureIO();
    expect(await runFn(repo, TARGET, opts({ out: 'md' }), io, { provider: recorded })).toBe(0);
    const md = out.join('\n');
    expect(md).toMatch(/^# /);
    expect(md).toContain('```ts\n36 | ');
    expect(err.join('\n')).toMatch(/Saved \.walkthrough\/walkthroughs\/fn--api_services_enrollService\.ts_enrollPatient--[0-9a-f]{8}\.md/);
    const files = readdirSync(join(repo, '.walkthrough', 'walkthroughs'));
    expect(files.filter((f) => f.startsWith('fn--')).map((f) => f.split('.').pop()).sort()).toEqual(['json', 'md']);
  });
});
