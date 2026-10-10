import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type WalkConfig } from '../config.js';
import { buildEndpointContext } from '../context/endpoint.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmProvider } from '../llm/generate.js';
import { renderMarkdown } from '../render/markdown.js';
import { openStore, type Store } from '../store/index.js';
import { endpointBlocks, endpointOverviewOf, generateEndpointSection, reuseEndpointSection } from './endpoint.js';
import { SAVED_VERSION, sourceFiles, type SavedWalkthrough, type Section } from './saved.js';
import { checkWalkthrough, filesOf, loadCurrentSource } from './staleness.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollEndpoint.response.json', import.meta.url), 'utf8');
const TARGET = { method: 'POST', path: '/api/patients/enroll' };
const OPTIONS = { depth: 3, maxContextTokens: 60000 };
const recorded: LlmProvider = { generate: async () => RECORDED };

describe('endpoint sections', () => {
  let repo: string;
  let config: WalkConfig;
  let store: Store;
  let section: Section;
  let saved: SavedWalkthrough;

  const context = async () => {
    await indexRepo(repo, config, store);
    return buildEndpointContext(store, repo, TARGET, OPTIONS);
  };
  const edit = (file: string, from: string, to: string) => {
    const path = join(repo, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-epsec-'));
    cpSync(FIXTURE, repo, { recursive: true });
    config = loadConfig(repo);
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_epsec_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    const ctx = await context();
    section = await generateEndpointSection(recorded, ctx, repo, { model: 'test-model', depth: 3 });
    saved = { version: SAVED_VERSION, scopeKind: 'endpoint', scopeRef: ctx.scopeRef, overview: null, endpoint: endpointOverviewOf(ctx), sections: [section] };
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('records every explained block, handler first, and the chain hash', async () => {
    const ctx = await context();
    expect(section.block.symbol).toBe('enrollHandler');
    expect(section.blocks![0]).toEqual(section.block);
    expect(section.blocks!.map((b) => b.symbol)).toEqual(expect.arrayContaining(['requireAuth', 'validate.validateBody', 'enrollPatient', 'insertConsent', null]));
    expect(section.chainHash).toBe(ctx.chainHash);
  });

  it('renders Markdown with the route notes and the sequence diagram', () => {
    const md = renderMarkdown(saved, (f) => readFileSync(join(repo, f), 'utf8').split('\n'));
    expect(md).toContain('# How POST /api/patients/enroll works');
    expect(md).toContain('- Middleware chain: express.json() [app] → requireAuth [router] → rateLimit [route] → validate.validateBody [route] → enrollHandler [handler]');
    expect(md).toContain('```mermaid\nsequenceDiagram');
    expect(md).toContain('### Step 1 · `api/app.ts:9-10`');
  });

  it('is fresh and reused unchanged while the code is unchanged', async () => {
    const ctx = await context();
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    expect(checkWalkthrough(saved, source, () => ctx.chainHash).fresh).toBe(true);
    const reused = reuseEndpointSection(section, { blocks: endpointBlocks(ctx), chainHash: ctx.chainHash }, sourceFiles(repo), 3);
    expect(reused?.walkthrough.stages).toEqual(section.walkthrough.stages);
  });

  it('reuses with shifted lines when only line positions change (no LLM call)', async () => {
    edit('api/services/enrollService.ts', 'import { pool }', '// one\n// two\nimport { pool }');
    const ctx = await context();
    const reused = reuseEndpointSection(section, { blocks: endpointBlocks(ctx), chainHash: ctx.chainHash }, sourceFiles(repo), 3);
    expect(reused).not.toBeNull();
    const s6 = reused!.walkthrough.stages.flatMap((s) => s.steps).find((s) => s.id === 's6')!;
    expect(s6.code_ref).toEqual({ file: 'api/services/enrollService.ts', start: 38, end: 47 });
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    expect(checkWalkthrough(saved, source, () => ctx.chainHash)).toMatchObject({ fresh: true, staleSteps: 0 });
  });

  it('follows registration lines that move when a router or app file gains lines above them', async () => {
    edit('api/app.ts', "import express from 'express';", "// app entry\nimport express from 'express';");
    const ctx = await context();
    const reused = reuseEndpointSection(section, { blocks: endpointBlocks(ctx), chainHash: ctx.chainHash }, sourceFiles(repo), 3);
    expect(reused).not.toBeNull();
    const s1 = reused!.walkthrough.stages.flatMap((s) => s.steps).find((s) => s.id === 's1')!;
    expect(s1.code_ref).toEqual({ file: 'api/app.ts', start: 10, end: 11 });
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    expect(checkWalkthrough(saved, source, () => ctx.chainHash)).toMatchObject({ fresh: true, staleSteps: 0 });
  });

  it('goes stale, naming the changed block, when a callee body changes', async () => {
    edit('api/repositories/patientRepository.ts', 'VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())');
    const ctx = await context();
    expect(reuseEndpointSection(section, { blocks: endpointBlocks(ctx), chainHash: ctx.chainHash }, sourceFiles(repo), 3)).toBeNull();
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    const status = checkWalkthrough(saved, source, () => ctx.chainHash);
    expect(status.fresh).toBe(false);
    expect(status.sections[0].changedBlocks).toEqual(['insertConsent']);
    expect(status.staleSteps).toBe(0);
  });

  it('reports a changed chain and a removed route', async () => {
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    expect(checkWalkthrough(saved, source, () => 'other')).toMatchObject({ fresh: false, chainChanged: true, routeRemoved: false });
    expect(checkWalkthrough(saved, source, () => null)).toMatchObject({ fresh: false, routeRemoved: true });
  });
});
