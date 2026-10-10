import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, openStore, type LlmProvider } from '@codewalk/core';
import { runComponent, type ComponentOptions } from './component.js';
import { runList } from './list.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../../../core/src/llm/__fixtures__/enrollForm.response.json', import.meta.url), 'utf8');
const TARGET = 'web/components/EnrollForm.tsx#EnrollForm';

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
const opts = (o: Partial<ComponentOptions> = {}): ComponentOptions => ({ llm: true, depth: 2, out: 'terminal', refresh: false, ...o });

describe('walk component', () => {
  let repo: string;
  let schema: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-component-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_cmpcli_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  });

  afterAll(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('--no-llm prints props, state, hooks, render tree, handlers and the API call with its trigger (Phase 4 acceptance)', async () => {
    const { io, out } = captureIO();
    expect(await runComponent(repo, TARGET, opts({ llm: false }), io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('component EnrollForm — web/components/EnrollForm.tsx:18-54');
    expect(text).toContain('onEnrolled  : EnrollFormProps');
    expect(text).toContain('values / setValues  useState(EMPTY_FORM)  line 19');
    expect(text).toContain('useEnrollMutation  web/hooks/useEnrollMutation.ts:11  (used by EnrollForm at web/components/EnrollForm.tsx:20)');
    expect(text).toContain('  <FormField>  line 40');
    expect(text).toContain('onSubmit on <form> → handleSubmit  line 39');
    expect(text).toContain('POST /api/patients/enroll  useEnrollMutation.mutate web/hooks/useEnrollMutation.ts:19');
    expect(text).toContain('← onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate');
    expect(text).toContain('Not expanded');
  });

  it('a file with one component needs no name; a hook is rejected with the right command', async () => {
    const one = captureIO();
    expect(await runComponent(repo, 'web/components/PatientSummary.tsx', opts({ llm: false }), one.io)).toBe(0);
    expect(one.out.join('\n')).toContain('GET /api/patients/:id  usePatient web/hooks/usePatient.ts:13');

    const hook = captureIO();
    expect(await runComponent(repo, 'web/hooks/usePatient.ts#usePatient', opts({ llm: false }), hook.io)).toBe(1);
    expect(hook.err.join('\n')).toContain('use `walk fn web/hooks/usePatient.ts#usePatient` instead');
  });

  it('explains, saves, and reuses the saved walkthrough while the code is unchanged', async () => {
    const first = captureIO();
    expect(await runComponent(repo, TARGET, opts(), first.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(first.out.join('\n')).toContain('How EnrollForm works');
    expect(first.err.join('\n')).toContain('Saved .walkthrough/walkthroughs/component--');

    const second = captureIO();
    expect(await runComponent(repo, TARGET, opts({ out: 'md' }), second.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(second.err.join('\n')).toContain('Code unchanged');
    expect(second.out.join('\n')).toContain('## Component');
  });

  it('walk list marks the component stale after its hook changes, and the next run regenerates', async () => {
    const path = join(repo, 'web/hooks/useEnrollMutation.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace("setStatus('submitting');", 'setStatus("submitting");'));

    const list = captureIO();
    expect(await runList(repo, { out: 'terminal' }, list.io)).toBe(0);
    expect(list.out.join('\n')).toMatch(/stale {2}component {2}web\/components\/EnrollForm\.tsx#EnrollForm .*changed: useEnrollMutation/);

    expect(await runComponent(repo, TARGET, opts(), captureIO().io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(2);
  });
});
