import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildFileContext } from '../context/file.js';
import { buildFnContext } from '../context/fn.js';
import { parseFileTarget, TargetError } from '../context/target.js';
import { indexRepo } from '../indexer/index.js';
import { LlmRequestError } from '../llm/anthropic.js';
import type { LlmProvider } from '../llm/generate.js';
import { createLineStubProvider } from '../llm/stub.js';
import { openStore, type Store } from '../store/index.js';
import { explainFile, type ExplainFileOptions } from './file.js';
import { hashLines, readLines } from './saved.js';
import { generateSection } from './section.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const SERVICE = 'api/services/enrollService.ts';

describe('walk file on a copy of the fixture', () => {
  let repo: string;
  let store: Store;
  const options = (o: Partial<ExplainFileOptions> = {}): ExplainFileOptions => ({ depth: 2, maxContextTokens: 60000, model: 'stub', refresh: false, ...o });
  const reindex = () => indexRepo(repo, loadConfig(repo), store);
  const editService = (change: (text: string) => string) => writeFileSync(join(repo, SERVICE), change(readFileSync(join(repo, SERVICE), 'utf8')));

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-file-'));
    cpSync(FIXTURE, repo, { recursive: true });
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_file_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await reindex();
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('parses a file argument and rejects fn-style targets', () => {
    expect(parseFileTarget('./api/services/enrollService.ts')).toBe(SERVICE);
    expect(() => parseFileTarget('api/x.ts#f')).toThrow(TargetError);
    expect(() => parseFileTarget('api/x.ts:1-4')).toThrow(/use `walk fn/);
  });

  it('builds the file overview: importers, exports, helpers, helpers-first order', async () => {
    const ctx = await buildFileContext(store, repo, SERVICE);
    expect(ctx.importers).toEqual([{ file: 'api/controllers/patientsController.ts', importedNames: ['enrollPatient', 'getPatient'] }]);
    expect(ctx.exports.map((s) => s.name)).toEqual(['normalizePhone', 'calculateAge', 'enrollPatient', 'getPatient']);
    expect(ctx.helpers).toEqual([]);
    expect(ctx.order.map((s) => s.name)).toEqual(['normalizePhone', 'calculateAge', 'enrollPatient', 'getPatient']);

    const handlers = await buildFileContext(store, repo, 'api/events/handlers.ts');
    expect(handlers.helpers.map((s) => s.name)).toEqual(['sendWelcomeSms', 'notifyCareTeam']);
    expect(handlers.exports.map((s) => s.name)).toEqual(['dispatch']);
  });

  it('reports a file that is not indexed', async () => {
    await expect(buildFileContext(store, repo, 'api/nope.ts')).rejects.toThrow(/api\/nope\.ts is not in the index/);
  });

  it('records block and step hashes when generating a section', async () => {
    const ctx = await buildFnContext(store, repo, { kind: 'symbol', file: SERVICE, name: 'normalizePhone' }, { depth: 2, maxContextTokens: 60000 });
    const section = await generateSection(createLineStubProvider(), ctx, repo, { symbol: 'normalizePhone', model: 'stub', depth: 2 });
    const lines = readLines(repo, SERVICE)!;
    expect(section.block).toEqual({ file: SERVICE, symbol: 'normalizePhone', start: 17, end: 20, hash: hashLines(lines.slice(16, 20)) });
    expect(Object.keys(section.stepHashes)).toEqual(['s1', 's2', 's3', 's4']);
    expect(Object.keys(section.fileHashes)).toContain(SERVICE);
  });

  it('explains every function once with a condensed prompt, then reuses all of them', async () => {
    const first = createLineStubProvider();
    const ctx = await buildFileContext(store, repo, SERVICE);
    const a = await explainFile(store, first, repo, ctx, null, options());
    expect(first.targets).toEqual([`${SERVICE}:17-20`, `${SERVICE}:23-33`, `${SERVICE}:35-69`, `${SERVICE}:71-81`]);
    expect(first.prompts.every((p) => p.includes('Keep it condensed'))).toBe(true);
    expect(a.generated).toHaveLength(4);
    expect(a.saved.overview!.order).toEqual(['normalizePhone', 'calculateAge', 'enrollPatient', 'getPatient']);

    const second = createLineStubProvider();
    const b = await explainFile(store, second, repo, ctx, a.saved, options());
    expect(second.targets).toEqual([]);
    expect(b.reused).toHaveLength(4);

    const forced = createLineStubProvider();
    await explainFile(store, forced, repo, ctx, a.saved, options({ refresh: true }));
    expect(forced.targets).toHaveLength(4);
  });

  it('records the model per section and regenerates when --depth changes', async () => {
    const ctx = await buildFileContext(store, repo, SERVICE);
    const a = await explainFile(store, createLineStubProvider(), repo, ctx, null, options({ model: 'model-a' }));
    expect(a.saved.sections.map((s) => [s.model, s.depth])).toEqual(Array(4).fill(['model-a', 2]));

    const b = await explainFile(store, createLineStubProvider(), repo, ctx, a.saved, options({ model: 'model-b' }));
    expect(b.reused).toHaveLength(4);
    expect(b.saved.sections.map((s) => s.model)).toEqual(Array(4).fill('model-a'));

    const deeper = createLineStubProvider();
    const c = await explainFile(store, deeper, repo, ctx, b.saved, options({ model: 'model-b', depth: 3 }));
    expect(deeper.targets).toHaveLength(4);
    expect(c.saved.sections.map((s) => [s.model, s.depth])).toEqual(Array(4).fill(['model-b', 3]));
  });

  it('makes no LLM call for a file without functions', async () => {
    const stub = createLineStubProvider();
    const ctx = await buildFileContext(store, repo, 'web/types.ts');
    const result = await explainFile(store, stub, repo, ctx, null, options());
    expect(stub.targets).toEqual([]);
    expect(result.saved.sections).toEqual([]);
    expect(result.saved.overview!.order).toEqual([]);
  });

  it('keeps finished sections when a request fails, and the next run fills the gap', async () => {
    const stub = createLineStubProvider();
    let calls = 0;
    const flaky: LlmProvider = {
      generate: async (req) => {
        if (++calls === 2) throw new LlmRequestError('rate limited');
        return stub.generate(req);
      },
    };
    const ctx = await buildFileContext(store, repo, SERVICE);
    const partial = await explainFile(store, flaky, repo, ctx, null, options());
    expect(partial.aborted).toBeInstanceOf(LlmRequestError);
    expect(partial.saved.sections.map((s) => s.block.symbol)).toEqual(['normalizePhone']);
    expect(partial.saved.overview!.failed).toEqual([
      { symbol: 'calculateAge', reason: 'rate limited' },
      { symbol: 'enrollPatient', reason: 'skipped after an earlier error' },
      { symbol: 'getPatient', reason: 'skipped after an earlier error' },
    ]);

    const rest = createLineStubProvider();
    const filled = await explainFile(store, rest, repo, ctx, partial.saved, options());
    expect(filled.reused).toEqual(['normalizePhone']);
    expect(filled.generated).toEqual(['calculateAge', 'enrollPatient', 'getPatient']);
    expect(filled.saved.overview!.failed).toEqual([]);
  });

  it('a --refresh that fails partway keeps the previous sections instead of discarding them', async () => {
    const ctx = await buildFileContext(store, repo, SERVICE);
    const complete = await explainFile(store, createLineStubProvider(), repo, ctx, null, options());

    const stub = createLineStubProvider();
    let calls = 0;
    const flaky: LlmProvider = {
      generate: async (req) => {
        if (++calls === 2) throw new LlmRequestError('rate limited');
        return stub.generate(req);
      },
    };
    const refreshed = await explainFile(store, flaky, repo, ctx, complete.saved, options({ refresh: true }));
    expect(refreshed.aborted).toBeInstanceOf(LlmRequestError);
    expect(refreshed.saved.sections.map((s) => s.block.symbol)).toEqual(['normalizePhone', 'calculateAge', 'enrollPatient', 'getPatient']);
    expect(refreshed.generated).toEqual(['normalizePhone']);
    expect(refreshed.reused).toEqual(['calculateAge', 'enrollPatient', 'getPatient']);
    expect(refreshed.saved.overview!.failed).toEqual([]);
  });

  it('after an edit, regenerates only the changed function and shifts the others', async () => {
    const original = await explainFile(store, createLineStubProvider(), repo, await buildFileContext(store, repo, SERVICE), null, options());

    editService((t) => `// enrollment service\n${t.replace("phone.replace(/\\D/g, '')", "phone.replace(/[^0-9]/g, '')")}`);
    await reindex();

    const stub = createLineStubProvider();
    const ctx = await buildFileContext(store, repo, SERVICE);
    const result = await explainFile(store, stub, repo, ctx, original.saved, options());
    expect(stub.targets).toEqual([`${SERVICE}:18-21`]);
    expect(result.generated).toEqual(['normalizePhone']);
    expect(result.reused).toEqual(['calculateAge', 'enrollPatient', 'getPatient']);
    const enroll = result.saved.sections.find((s) => s.block.symbol === 'enrollPatient')!;
    expect(enroll.block).toMatchObject({ start: 36, end: 70 });
    expect(enroll.walkthrough.stages[0].steps[0].code_ref.start).toBe(36);
  });
});
