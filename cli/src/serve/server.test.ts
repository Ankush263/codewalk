import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerSchema, CONFIG_FILE, indexRepo, loadConfig, openStore, type LlmProvider, type Store } from '@codewalk/core';
import { runEndpoint } from '../commands/endpoint.js';
import { createServeServer } from './server.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const ENDPOINT = readFileSync(new URL('../../../core/src/llm/__fixtures__/enrollEndpoint.response.json', import.meta.url), 'utf8');
const ANSWER = readFileSync(new URL('../../../core/src/llm/__fixtures__/enrollAnswer.response.json', import.meta.url), 'utf8');
const REF = 'POST /api/patients/enroll';

let walkthroughs = 0;
const provider: LlmProvider = {
  generate: async ({ schema }) => {
    if (schema === answerSchema) return ANSWER;
    walkthroughs++;
    return ENDPOINT;
  },
};
const quiet = { log: () => {}, error: () => {} };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function rawGet(base: string, path: string, host: string): Promise<number> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('walk serve HTTP server', () => {
  let repo: string;
  let schema: string;
  let webRoot: string;
  let store: Store;
  let server: Server;
  let base: string;
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'X-Codewalk': '1' }) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const detail = () => fetch(`${base}/api/walkthrough?kind=endpoint&ref=${encodeURIComponent(REF)}`);

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-serve-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_srv_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
    expect(await runEndpoint(repo, REF, { llm: true, depth: 3, out: 'json', refresh: false }, quiet, { provider, interactive: false })).toBe(0);

    webRoot = mkdtempSync(join(tmpdir(), 'cw-web-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), '<h1>ok</h1>');
    writeFileSync(join(webRoot, 'assets/app.js'), 'console.log(1);');

    store = await openStore({ url: DATABASE_URL, schema });
    server = createServeServer({ repoRoot: repo, config: loadConfig(repo), store, webRoot, provider });
    base = await listen(server);
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('lists saved walkthroughs', async () => {
    const res = await fetch(`${base}/api/walkthroughs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([expect.objectContaining({ scopeKind: 'endpoint', scopeRef: REF, fresh: true, totalSteps: 9 })]);
  });

  it('returns a walkthrough with code and diagram (Phase 6 acceptance)', async () => {
    const body = await (await detail()).json();
    expect(body.walkthrough.title).toBe('How POST /api/patients/enroll works');
    expect(body.files['api/app.ts'][8]).toBe('  app.use(express.json());');
    expect(body.diagram).toMatch(/^sequenceDiagram/);
    const missing = await fetch(`${base}/api/walkthrough?kind=endpoint&ref=${encodeURIComponent('GET /nope')}`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('No saved endpoint walkthrough GET /nope.');
  });

  it('answers, verifies and saves a question (Phase 6 acceptance)', async () => {
    const res = await post('/api/questions', { kind: 'endpoint', ref: REF, stepId: 's2', question: 'What happens when the session is missing?' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stepId: 's2',
      references: [{ file: 'api/middleware/auth.ts', line: 19, role: 'callee' }],
      warnings: ['Removed reference api/nowhere.ts:3: not part of the indexed context.'],
      stale: false,
    });
    expect((await (await detail()).json()).questions).toHaveLength(1);
  });

  it('refuses cross-site POSTs, foreign hosts and bad input', async () => {
    expect((await post('/api/questions', { kind: 'endpoint', ref: REF, stepId: 's2', question: 'x' }, {})).status).toBe(403);
    expect(await rawGet(base, '/api/walkthroughs', 'evil.example')).toBe(403);
    expect((await post('/api/questions', '{not json')).status).toBe(400);
    expect((await post('/api/questions', { kind: 'nope', ref: REF, stepId: 's2', question: 'x' })).status).toBe(400);
    expect((await post('/api/questions', { kind: 'endpoint', ref: REF, stepId: 's2', question: 'x'.repeat(70_000) })).status).toBe(413);
  });

  it('regenerates a stale walkthrough', async () => {
    const path = join(repo, 'api/repositories/patientRepository.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())'));
    expect((await (await detail()).json()).fresh).toBe(false);
    const before = walkthroughs;
    const res = await post('/api/regenerate', { kind: 'endpoint', ref: REF });
    expect(res.status).toBe(200);
    expect((await res.json()).fresh).toBe(true);
    expect(walkthroughs).toBe(before + 1);
  });

  it('serves the built app, and nothing outside it', async () => {
    const index = await fetch(`${base}/`);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await index.text()).toBe('<h1>ok</h1>');
    expect((await fetch(`${base}/assets/app.js`)).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await fetch(`${base}/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  });

  it('explains how to build the app when it is missing, while the API keeps working', async () => {
    const bare = createServeServer({ repoRoot: repo, config: loadConfig(repo), store, webRoot: null, provider });
    const url = await listen(bare);
    try {
      const res = await fetch(`${url}/`);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('pnpm --filter @codewalk/web build');
      expect((await fetch(`${url}/api/walkthroughs`)).status).toBe(200);
    } finally {
      bare.closeAllConnections();
      await new Promise((resolve) => bare.close(resolve));
    }
  });
});

describe('walk serve HTTP server: review minors', () => {
  let repo: string;
  let schema: string;
  let store: Store;
  const servers: Server[] = [];
  let indexed = 0;
  let slow = false;
  const timed: LlmProvider = {
    generate: async ({ schema: s }) => {
      if (s === answerSchema) return ANSWER;
      if (slow) await new Promise((resolve) => setTimeout(resolve, 1500));
      return ENDPOINT;
    },
  };
  const start = async (options: { reindexWindowMs: number }) => {
    const server = createServeServer({
      repoRoot: repo, config: loadConfig(repo), store, webRoot: null, provider: timed, reindexWindowMs: options.reindexWindowMs,
      index: async () => {
        indexed++;
        await indexRepo(repo, loadConfig(repo), store);
      },
    });
    servers.push(server);
    return listen(server);
  };
  const postTo = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codewalk': '1' }, body: JSON.stringify(body) });
  const edit = (file: string, from: string, to: string) => {
    const path = join(repo, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-serve-minor-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_srvm_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
    const opts = { llm: true, depth: 3, out: 'json' as const, refresh: false };
    expect(await runEndpoint(repo, REF, opts, quiet, { provider: timed, interactive: false })).toBe(0);
    expect(await runEndpoint(repo, 'GET /api/patients/:id', opts, quiet, { provider: timed, interactive: false })).toBe(0);
    store = await openStore({ url: DATABASE_URL, schema });
  });

  afterAll(async () => {
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise((resolve) => s.close(resolve));
    }
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('indexes at most once per window for page views, but always before answering a question', async () => {
    const base = await start({ reindexWindowMs: 60_000 });
    indexed = 0;
    await fetch(`${base}/api/walkthroughs`);
    await fetch(`${base}/api/walkthrough?kind=endpoint&ref=${encodeURIComponent(REF)}`);
    expect(indexed).toBe(1);
    expect((await postTo(base, '/api/questions', { kind: 'endpoint', ref: REF, stepId: 's2', question: 'Why?' })).status).toBe(200);
    expect(indexed).toBe(2);
  });

  it('keeps answering page views while a regeneration runs', async () => {
    const base = await start({ reindexWindowMs: 0 });
    edit('api/repositories/patientRepository.ts', 'VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())');
    slow = true;
    try {
      const regen = postTo(base, '/api/regenerate', { kind: 'endpoint', ref: REF });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const sent = Date.now();
      expect((await fetch(`${base}/api/walkthroughs`)).status).toBe(200);
      // The regeneration's LLM call takes 1.5 s; the list must not wait for it.
      expect(Date.now() - sent).toBeLessThan(1000);
      expect((await regen).status).toBe(200);
    } finally {
      slow = false;
    }
  });

  it('says so when a regenerated walkthrough is now saved under another name', async () => {
    const base = await start({ reindexWindowMs: 0 });
    edit('api/routes/patients.ts', "patientsRouter.get('/:id'", "patientsRouter.get('/:patientId'");
    const res = await postTo(base, '/api/regenerate', { kind: 'endpoint', ref: 'GET /api/patients/:id' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Regenerated, but it is now saved as "GET /api/patients/:patientId"; reopen it from the list.');
  });
});
