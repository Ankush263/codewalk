import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildTraceContext } from '../context/trace.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmProvider } from '../llm/generate.js';
import { renderMarkdown } from '../render/markdown.js';
import { openStore, type Store } from '../store/index.js';
import { reuseMultiBlockSection } from './endpoint.js';
import { codeReader } from './persist.js';
import { SAVED_VERSION, sourceFiles, traceNotes, type SavedWalkthrough, type Section } from './saved.js';
import { checkWalkthrough, filesOf, loadCurrentSource } from './staleness.js';
import { generateTraceSection, traceBlocks, traceOverviewOf } from './trace.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollTrace.response.json', import.meta.url), 'utf8');
const recorded: LlmProvider = { generate: async () => RECORDED };
const TARGET = { endpoint: { method: 'POST', path: '/api/patients/enroll' }, from: null };
const OPTIONS = { depth: 3, maxContextTokens: 60000 };

describe('trace sections and staleness', () => {
  let repo: string;
  let store: Store;
  let section: Section;

  const context = async () => {
    await indexRepo(repo, loadConfig(repo), store);
    return buildTraceContext(store, repo, TARGET, OPTIONS);
  };
  const edit = (file: string, from: string, to: string) => {
    const path = join(repo, file);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(from);
    writeFileSync(path, text.replace(from, to));
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-trace-sec-'));
    cpSync(FIXTURE, repo, { recursive: true });
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_trs_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    section = await generateTraceSection(recorded, await context(), repo, { model: 'recorded', depth: 3 });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('records the blocks of both stacks, the component first, and the trace hash', async () => {
    const ctx = await context();
    const names = section.blocks!.map((b) => b.symbol);
    expect(names[0]).toBe('EnrollForm');
    expect(names).toEqual(expect.arrayContaining(['useEnrollMutation', 'enrollHandler', 'enrollPatient', 'insertConsent']));
    expect(section.chainHash).toBe(ctx.traceHash);
  });

  it('builds the overview from the index', async () => {
    expect(traceNotes(traceOverviewOf(await context()))).toEqual(
      expect.arrayContaining([
        'Trace: web/components/EnrollForm.tsx#EnrollForm → POST /api/patients/enroll',
        'Trigger: onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate',
        'API call: POST /api/patients/enroll in useEnrollMutation.mutate (web/hooks/useEnrollMutation.ts:19) — exact match, confidence 1.0',
        'Server: express.json() → requireAuth → rateLimit → validate.validateBody → enrollHandler',
        'After the response: setStatus, onSuccess, setError',
      ]),
    );
  });

  it('reuses the section when lines move, without regenerating', async () => {
    edit('api/services/enrollService.ts', "import { pool } from '../db/pool';", "// Enrollment.\nimport { pool } from '../db/pool';");
    const ctx = await context();
    const reused = reuseMultiBlockSection(section, { blocks: traceBlocks(ctx), chainHash: ctx.traceHash }, sourceFiles(repo), 3);
    expect(reused).not.toBeNull();
    const persistence = reused!.walkthrough.stages.find((s) => s.name === 'Persistence')!.steps[0];
    expect(persistence.code_ref).toEqual({ file: 'api/services/enrollService.ts', start: 48, end: 59 });
    section = reused!;
  });

  it('marks the trace stale when a backend function deep in it changes; Markdown has the diagram', async () => {
    edit('api/repositories/patientRepository.ts', 'VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())');
    const ctx = await context();
    const saved: SavedWalkthrough = { version: SAVED_VERSION, scopeKind: 'trace', scopeRef: ctx.scopeRef, overview: null, trace: traceOverviewOf(ctx), sections: [section] };
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    const status = checkWalkthrough(saved, source, () => ctx.traceHash);
    expect(status.fresh).toBe(false);
    expect(status.sections[0].changedBlocks).toContain('insertConsent');
    expect(checkWalkthrough(saved, source, () => null).routeRemoved).toBe(true);

    const md = renderMarkdown(saved, codeReader(repo));
    expect(md).toContain('# How enrolling a patient works, from the Enroll button to the database');
    expect(md).toContain('## Trace');
    expect(md).toContain('```mermaid\nsequenceDiagram\n  actor User');
  });
});
