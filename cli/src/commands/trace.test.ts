import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, openStore, type LlmProvider } from '@codewalk/core';
import { runList } from './list.js';
import { runTrace, type TraceOptions } from './trace.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../../../core/src/llm/__fixtures__/enrollTrace.response.json', import.meta.url), 'utf8');
const TARGET = 'POST /api/patients/enroll';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) }, out, err };
}

let generated = 0;
const recorded: LlmProvider = {
  generate: async () => {
    generated++;
    return RECORDED;
  },
};
const opts = (o: Partial<TraceOptions> = {}): TraceOptions => ({ llm: true, depth: 3, out: 'terminal', refresh: false, ...o });

function fixtureCopy(tag: string) {
  const repo = mkdtempSync(join(tmpdir(), `cw-trace-${tag}-`));
  cpSync(FIXTURE, repo, { recursive: true });
  const schema = `cw_test_${tag}_${Math.random().toString(16).slice(2, 10)}`;
  const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
  writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  return {
    repo,
    async cleanup() {
      const store = await openStore({ url: DATABASE_URL, schema });
      await store.dropSchema();
      await store.close();
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

describe('walk trace', () => {
  let copy: ReturnType<typeof fixtureCopy>;
  beforeAll(() => {
    copy = fixtureCopy('trcli');
  });
  afterAll(() => copy.cleanup());

  it('--no-llm prints the click-to-database trace (Phase 5 acceptance)', async () => {
    const { io, out } = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts({ llm: false }), io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('trace POST /api/patients/enroll ← web/components/EnrollForm.tsx#EnrollForm');
    expect(text).toContain('  onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate');
    expect(text).toContain('  POST /api/patients/enroll  useEnrollMutation.mutate web/hooks/useEnrollMutation.ts:19  (exact match, confidence 1.0)');
    expect(text).toContain('  5. enrollHandler [handler]');
    expect(text).toContain('db_write INSERT consents');
    expect(text).toContain('  setStatus  web/hooks/useEnrollMutation.ts:20');
    expect(text).toContain('  User->>C: onSubmit on <form>');
  });

  it('explains, saves, and reuses the trace; walk list marks it stale after a deep backend change', async () => {
    const first = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts(), first.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(first.err.join('\n')).toContain('Saved .walkthrough/walkthroughs/trace--');

    const second = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts({ out: 'md' }), second.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(second.out.join('\n')).toContain('```mermaid');

    const path = join(copy.repo, 'api/repositories/patientRepository.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())'));
    const list = captureIO();
    expect(await runList(copy.repo, { out: 'terminal' }, list.io)).toBe(0);
    expect(list.out.join('\n')).toMatch(/stale {2}trace {2}POST \/api\/patients\/enroll <- web\/components\/EnrollForm\.tsx#EnrollForm .*insertConsent/);
  });
});

describe('walk trace: pinning a loose match', () => {
  let copy: ReturnType<typeof fixtureCopy>;
  beforeAll(() => {
    copy = fixtureCopy('trpin');
    const hook = join(copy.repo, 'web/hooks/useEnrollMutation.ts');
    writeFileSync(hook, readFileSync(hook, 'utf8').replace("'/api/patients/enroll'", "'/patients/enroll'"));
  });
  afterAll(() => copy.cleanup());

  it('a non-interactive run lists the candidates and the --pin command, without prompting', async () => {
    const { io, err } = captureIO();
    let asked = false;
    expect(await runTrace(copy.repo, TARGET, opts({ llm: false }), io, { interactive: false, ask: async () => ((asked = true), '1') })).toBe(1);
    expect(asked).toBe(false);
    expect(err.join('\n')).toContain('[1] POST /patients/enroll in useEnrollMutation.mutate (web/hooks/useEnrollMutation.ts:19): suffix match (0.6)');
    expect(err.join('\n')).toContain('Pin one with: walk trace "POST /api/patients/enroll" --pin <n>');
  });

  it('rejects a --pin outside the list', async () => {
    const { io, err } = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts({ llm: false, pin: 9 }), io, { interactive: false })).toBe(1);
    expect(err.join('\n')).toContain('--pin 9 is not one of the 1 candidates');
  });

  it('an interactive answer pins the call in config, and later runs follow the pin', async () => {
    const first = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts({ llm: false }), first.io, { interactive: true, ask: async () => '1' })).toBe(0);
    expect(first.out.join('\n')).toContain('(pinned in .walkthrough/config.json)');
    expect(JSON.parse(readFileSync(join(copy.repo, CONFIG_FILE), 'utf8')).pinnedEdges).toEqual([
      { caller: 'web/hooks/useEnrollMutation.ts#useEnrollMutation.mutate', method: 'POST', url: '/patients/enroll', route: 'POST /api/patients/enroll' },
    ]);

    const again = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts({ llm: false }), again.io, { interactive: false })).toBe(0);
  });
});
