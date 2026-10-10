import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { indexRepo } from '../indexer/index.js';
import { openStore, type Store } from '../store/index.js';
import { buildComponentContext, currentStructureHash, describeTrigger, type ComponentContext } from './component.js';
import { parseComponentTarget, TargetError } from './target.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const OPTIONS = { depth: 2, maxContextTokens: 60000 };
const schema = (tag: string) => `cw_test_${tag}_${Math.random().toString(16).slice(2, 10)}`;

describe('parseComponentTarget', () => {
  it('accepts a file with or without a component name', () => {
    expect(parseComponentTarget('./web/components/EnrollForm.tsx#EnrollForm')).toEqual({ file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' });
    expect(parseComponentTarget('web/components/EnrollForm.tsx')).toEqual({ file: 'web/components/EnrollForm.tsx', name: null });
  });

  it('rejects line ranges and empty names', () => {
    expect(() => parseComponentTarget('web/a.tsx:1-5')).toThrow(/use `walk fn web\/a\.tsx:1-5`/);
    expect(() => parseComponentTarget('web/a.tsx#')).toThrow(TargetError);
  });
});

describe('buildComponentContext on the fixture', () => {
  let store: Store;
  let ctx: ComponentContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: schema('cmp') });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildComponentContext(store, FIXTURE, { file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' }, OPTIONS);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('collects the component, its handlers and its custom hook (Phase 4 acceptance)', () => {
    expect(ctx.scopeRef).toBe('web/components/EnrollForm.tsx#EnrollForm');
    expect(ctx.component.code).toMatchObject({ file: 'web/components/EnrollForm.tsx', start: 18, end: 54 });
    expect(ctx.component.inner.map((s) => s.name)).toEqual(['EnrollForm.handleChange', 'EnrollForm.handleSubmit']);
    expect(ctx.hooks.map((h) => `${h.depth} ${h.usedBy} → ${h.symbol.name} at ${h.calledAt}`)).toEqual(['1 EnrollForm → useEnrollMutation at web/components/EnrollForm.tsx:20']);
    expect(ctx.hooks[0].inner.map((s) => s.name)).toEqual(['useEnrollMutation.mutate']);
    expect(ctx.hooks[0].code).toMatchObject({ file: 'web/hooks/useEnrollMutation.ts', start: 11, end: 29 });
  });

  it('detects the API call and the user action that triggers it (Phase 4 acceptance)', () => {
    expect(ctx.apiCalls).toEqual([
      {
        symbol: { id: expect.any(Number), file: 'web/hooks/useEnrollMutation.ts', name: 'useEnrollMutation.mutate' },
        method: 'POST',
        urlPattern: '/api/patients/enroll',
        urlText: "'/api/patients/enroll'",
        line: 19,
        triggers: [{ kind: 'event', label: 'onSubmit on <form>', at: 'web/components/EnrollForm.tsx:39', path: ['EnrollForm.handleSubmit', 'useEnrollMutation.mutate'] }],
      },
    ]);
    expect(describeTrigger(ctx.apiCalls[0].triggers[0])).toBe(
      'onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate',
    );
  });

  it('shows children one level deep and says so', () => {
    expect(ctx.children.map((c) => `${c.element}:${c.line}:${c.symbol?.name}`)).toEqual(['FormField:40:FormField', 'FormField:41:FormField', 'FormField:42:FormField', 'FormField:43:FormField']);
    expect(ctx.limits).toContain(
      'FormField (web/components/FormField.tsx:11): internals not expanded; child components are shown one level deep. Run `walk component web/components/FormField.tsx#FormField`.',
    );
  });

  it('lists calls, leaving out calls between owners, with bodies of direct repo callees', () => {
    expect(ctx.callees.some((c) => c.callee?.name === 'useEnrollMutation' || c.callee?.name === 'useEnrollMutation.mutate')).toBe(false);
    const post = ctx.callees.find((c) => c.callee?.name === 'api.post')!;
    expect(post).toMatchObject({ depth: 1, caller: { name: 'useEnrollMutation.mutate' }, code: { file: 'web/apiClient.ts', start: 28, end: 28 } });
  });

  it('explains unresolved callbacks and props with likely sources', () => {
    expect(ctx.unresolved.map((u) => u.note)).toEqual(
      expect.arrayContaining([
        'unresolved: likely the `onSuccess` callback EnrollForm passes to useEnrollMutation (web/components/EnrollForm.tsx:21)',
        'unresolved: likely the `onEnrolled` prop, supplied by whoever renders EnrollForm (call at web/components/EnrollForm.tsx:23)',
      ]),
    );
  });

  it('includes the types and values used, and every cited file', () => {
    expect(ctx.types.map((t) => t.symbol.name)).toEqual(expect.arrayContaining(['EnrollFormProps', 'EnrollFormValues', 'PatientDto', 'Options']));
    expect(ctx.values.map((v) => v.name)).toContain('EMPTY_FORM');
    expect(Object.keys(ctx.files)).toEqual(
      expect.arrayContaining(['web/apiClient.ts', 'web/components/EnrollForm.tsx', 'web/components/FormField.tsx', 'web/hooks/useEnrollMutation.ts', 'web/types.ts']),
    );
  });

  it('finds an effect-triggered API call; the file alone selects its only component', async () => {
    const summary = await buildComponentContext(store, FIXTURE, { file: 'web/components/PatientSummary.tsx', name: null }, OPTIONS);
    expect(summary.component.symbol.name).toBe('PatientSummary');
    expect(summary.apiCalls.map((a) => ({ call: `${a.method} ${a.urlPattern}`, triggers: a.triggers }))).toEqual([
      { call: 'GET /api/patients/:id', triggers: [{ kind: 'effect', label: 'useEffect [id] in usePatient', at: 'web/hooks/usePatient.ts:9', path: ['usePatient'] }] },
    ]);
  });

  it('rejects hooks, files without components and unknown names', async () => {
    const build = (file: string, name: string | null) => buildComponentContext(store, FIXTURE, { file, name }, OPTIONS);
    await expect(build('web/hooks/usePatient.ts', 'usePatient')).rejects.toThrow(/usePatient in web\/hooks\/usePatient\.ts is a hook, not a React component; use `walk fn web\/hooks\/usePatient\.ts#usePatient`/);
    await expect(build('web/apiClient.ts', null)).rejects.toThrow(/No React components in web\/apiClient\.ts/);
    await expect(build('web/components/EnrollForm.tsx', 'Nope')).rejects.toThrow(/No component "Nope" in web\/components\/EnrollForm\.tsx\. Components here: EnrollForm/);
  });

  it('has a stable structure hash that currentStructureHash reproduces; null once the component is gone', async () => {
    expect(ctx.structureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await currentStructureHash(store, FIXTURE, ctx.scopeRef, 2)).toBe(ctx.structureHash);
    expect(await currentStructureHash(store, FIXTURE, 'web/components/EnrollForm.tsx#Gone', 2)).toBeNull();
  });
});

describe('buildComponentContext depth limits', () => {
  let repo: string;
  let store: Store;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-cmp-depth-'));
    cpSync(FIXTURE, repo, { recursive: true });
    writeFileSync(join(repo, 'web/hooks/useSession.ts'), "import { useState } from 'react';\n\nexport function useSession() {\n  const [token] = useState('');\n  return token;\n}\n");
    const hook = join(repo, 'web/hooks/useEnrollMutation.ts');
    const text = readFileSync(hook, 'utf8').replace("useState<Status>('idle');", "useState<Status>('idle'); useSession();");
    writeFileSync(hook, `${text}import { useSession } from './useSession';\n`);
    store = await openStore({ url: DATABASE_URL, schema: schema('cmpd') });
    await store.migrate();
    await indexRepo(repo, loadConfig(repo), store);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('expands nested hooks up to --depth and states what it left out', async () => {
    const target = { file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' };
    const shallow = await buildComponentContext(store, repo, target, { ...OPTIONS, depth: 1 });
    expect(shallow.hooks.map((h) => h.symbol.name)).toEqual(['useEnrollMutation']);
    expect(shallow.limits).toContain('useSession (used by useEnrollMutation at web/hooks/useEnrollMutation.ts:12) is not expanded: --depth 1');
    const deep = await buildComponentContext(store, repo, target, { ...OPTIONS, depth: 2 });
    expect(deep.hooks.map((h) => `${h.depth} ${h.symbol.name}`)).toEqual(['1 useEnrollMutation', '2 useSession']);
    expect(deep.structureHash).not.toBe(shallow.structureHash);
  });
});

// Shapes the fixture doesn't have: a handler naming an imported function, a hook function used directly
// as a handler, a wrapper that builds its fetch URL from a template, and two API calls in different files.
describe('buildComponentContext review fixes', () => {
  let repo: string;
  let store: Store;
  const files: Record<string, string> = {
    'web/apiClient.ts': [
      "const BASE_URL = 'https://api.example.com';",
      'export async function request(method: string, path: string, body?: unknown) {',
      '  const res = await fetch(`${BASE_URL}${path}`, { method, body: JSON.stringify(body) });',
      '  return res.json();',
      '}',
      'export const api = {',
      "  get: (url: string) => request('GET', url),",
      "  post: (url: string, body: unknown) => request('POST', url, body),",
      '};',
    ].join('\n'),
    'web/auth.ts': "import { api } from './apiClient';\nexport async function logout() {\n  await api.post('/api/logout', {});\n}\n",
    'web/useSave.ts': [
      "import { api } from './apiClient';",
      'export function useSave() {',
      '  return {',
      '    save: async (v: string) => {',
      "      await api.post('/api/items', { v });",
      '    },',
      '  };',
      '}',
    ].join('\n'),
    'web/Header.tsx': [
      "import { logout } from './auth';",
      "import { useSave } from './useSave';",
      'export function Header() {',
      '  const { save } = useSave();',
      '  return (',
      '    <div>',
      '      <button onClick={logout}>Log out</button>',
      '      <button onClick={save}>Save</button>',
      '    </div>',
      '  );',
      '}',
    ].join('\n'),
  };
  const target = { file: 'web/Header.tsx', name: 'Header' };
  const config = {
    roots: { frontend: 'web' },
    apiClientWrappers: [{ name: 'api.post', method: 'POST', urlArgIndex: 0 }],
    database: { url: DATABASE_URL, schema: schema('cmpr') },
    llm: { provider: 'anthropic', model: 'recorded', maxContextTokens: 60000 },
  };
  const build = async () => {
    await indexRepo(repo, loadConfig(repo), store);
    return buildComponentContext(store, repo, target, OPTIONS);
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-cmp-review-'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), `${text}\n`);
    }
    mkdirSync(join(repo, '.walkthrough'), { recursive: true });
    writeFileSync(join(repo, '.walkthrough/config.json'), JSON.stringify(config));
    store = await openStore({ url: DATABASE_URL, schema: config.database.schema });
    await store.migrate();
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('finds API calls behind handlers that name an imported function or a hook function directly', async () => {
    const ctx = await build();
    const calls = ctx.apiCalls.map((a) => `${a.method} ${a.urlPattern} ← ${a.triggers.map((t) => `${t.label}: ${t.path.join(' → ')}`).join('; ')}`);
    expect(calls).toEqual(expect.arrayContaining(['POST /api/logout ← onClick on <button>: logout', 'POST /api/items ← onClick on <button>: useSave.save']));
  });

  it("does not report the wrapper's template-URL fetch as an API call", async () => {
    const ctx = await build();
    expect(ctx.apiCalls.filter((a) => a.symbol.name === 'request')).toEqual([]);
  });

  it('keeps the structure hash when re-indexing reassigns symbol ids', async () => {
    const before = (await build()).structureHash;
    for (const file of ['web/useSave.ts', 'web/auth.ts', 'web/useSave.ts']) {
      writeFileSync(join(repo, file), `${readFileSync(join(repo, file), 'utf8')}// note\n`);
      expect((await build()).structureHash).toBe(before);
    }
  });

  it('computes the current structure hash from the index alone, without reading source files', async () => {
    const ctx = await build();
    expect(await currentStructureHash(store, '/nonexistent-repo-root', ctx.scopeRef, 2)).toBe(ctx.structureHash);
  });
});
