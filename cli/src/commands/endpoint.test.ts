import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, openStore, type LlmProvider } from '@codewalk/core';
import { runEndpoint, type EndpointOptions } from './endpoint.js';
import { runList } from './list.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../../../core/src/llm/__fixtures__/enrollEndpoint.response.json', import.meta.url), 'utf8');
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
const opts = (o: Partial<EndpointOptions> = {}): EndpointOptions => ({ llm: true, depth: 3, out: 'terminal', refresh: false, ...o });

describe('walk endpoint', () => {
  let repo: string;
  let schema: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-endpoint-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_epcli_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  });

  afterAll(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('--no-llm prints the route, chain, side effects, error paths and diagram (Phase 3 acceptance)', async () => {
    const { io, out } = captureIO();
    expect(await runEndpoint(repo, TARGET, opts({ llm: false }), io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('endpoint POST /api/patients/enroll');
    expect(text).toContain('/api  api/app.ts:10');
    expect(text).toContain('/patients  api/routes/index.ts:6');
    expect(text).toContain('1. express.json() [app]  api/app.ts:9');
    expect(text).toContain('2. requireAuth [router]  api/middleware/auth.ts:10');
    expect(text).toContain('4. validate.validateBody [route]  api/middleware/validate.ts:6');
    expect(text).toContain('5. enrollHandler [handler]  api/controllers/patientsController.ts:7');
    expect(text).toContain('db_write INSERT consents  (insertConsent api/repositories/patientRepository.ts:46)');
    expect(text).toContain('ConflictError → 409');
    expect(text).toContain('sequenceDiagram');
  });

  it('reports unknown routes with the closest matches', async () => {
    const { io, err } = captureIO();
    expect(await runEndpoint(repo, 'POST /api/patient/enroll', opts({ llm: false }), io)).toBe(1);
    expect(err.join('\n')).toMatch(/No route matches POST \/api\/patient\/enroll\. Closest: POST \/api\/patients\/enroll/);
  });

  it('explains, saves, and reuses the saved walkthrough while the code is unchanged', async () => {
    const first = captureIO();
    expect(await runEndpoint(repo, TARGET, opts(), first.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(first.out.join('\n')).toContain('How POST /api/patients/enroll works');
    expect(first.err.join('\n')).toContain('Saved .walkthrough/walkthroughs/endpoint--');

    const second = captureIO();
    expect(await runEndpoint(repo, TARGET, opts({ out: 'md' }), second.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(second.err.join('\n')).toContain('Code unchanged');
    expect(second.out.join('\n')).toContain('```mermaid');
  });

  it('walk list marks the endpoint stale after a callee changes, and the next run regenerates', async () => {
    const path = join(repo, 'api/repositories/patientRepository.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())'));

    const list = captureIO();
    expect(await runList(repo, { out: 'terminal' }, list.io)).toBe(0);
    expect(list.out.join('\n')).toMatch(/stale {2}endpoint {2}POST \/api\/patients\/enroll .*changed: insertConsent/);

    expect(await runEndpoint(repo, TARGET, opts(), captureIO().io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(2);
  });
});
