import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildComponentContext } from '../context/component.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmProvider } from '../llm/generate.js';
import { renderMarkdown } from '../render/markdown.js';
import { openStore, type Store } from '../store/index.js';
import { componentBlocks, componentOverviewOf, generateComponentSection } from './component.js';
import { reuseMultiBlockSection } from './endpoint.js';
import { codeReader } from './persist.js';
import { componentNotes, SAVED_VERSION, sourceFiles, type SavedWalkthrough, type Section } from './saved.js';
import { checkWalkthrough, filesOf, loadCurrentSource } from './staleness.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollForm.response.json', import.meta.url), 'utf8');
const recorded: LlmProvider = { generate: async () => RECORDED };
const TARGET = { file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' };
const OPTIONS = { depth: 2, maxContextTokens: 60000 };

describe('component sections and staleness', () => {
  let repo: string;
  let store: Store;
  let section: Section;

  const context = async () => {
    await indexRepo(repo, loadConfig(repo), store);
    return buildComponentContext(store, repo, TARGET, OPTIONS);
  };
  const edit = (file: string, from: string, to: string) => {
    const path = join(repo, file);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(from);
    writeFileSync(path, text.replace(from, to));
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-cmp-sec-'));
    cpSync(FIXTURE, repo, { recursive: true });
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_cmps_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    const ctx = await context();
    section = await generateComponentSection(recorded, ctx, repo, { model: 'recorded', depth: 2 });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('records every explained block, the component first, and the structure hash', async () => {
    const ctx = await context();
    expect(section.blocks!.map((b) => `${b.file}#${b.symbol}`).slice(0, 3)).toEqual([
      'web/components/EnrollForm.tsx#EnrollForm',
      'web/hooks/useEnrollMutation.ts#useEnrollMutation',
      'web/apiClient.ts#api.post',
    ]);
    expect(section.blocks!.some((b) => b.symbol === null && b.file === 'web/components/EnrollForm.tsx' && b.start === 10)).toBe(true);
    expect(section.chainHash).toBe(ctx.structureHash);
  });

  it('builds the overview and its notes from the index', async () => {
    const notes = componentNotes(componentOverviewOf(await context()));
    expect(notes).toEqual(
      expect.arrayContaining([
        'Component: EnrollForm (web/components/EnrollForm.tsx)',
        'Props: onEnrolled — EnrollFormProps',
        'State: values / setValues (useState, initially EMPTY_FORM) at web/components/EnrollForm.tsx:19',
        'Hooks: useState (react), useEnrollMutation (expanded)',
        'Handler: onSubmit on <form> → handleSubmit at web/components/EnrollForm.tsx:39',
        'API call: POST /api/patients/enroll at web/hooks/useEnrollMutation.ts:19 ← onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate',
      ]),
    );
  });

  it('reuses the section while the code is unchanged', async () => {
    const ctx = await context();
    const reused = reuseMultiBlockSection(section, { blocks: componentBlocks(ctx), chainHash: ctx.structureHash }, sourceFiles(repo), 2);
    expect(reused?.walkthrough.stages).toEqual(section.walkthrough.stages);
  });

  it('shifts steps when a line is added above the component, without regenerating', async () => {
    edit('web/components/EnrollForm.tsx', 'export function EnrollForm(', '// Enrollment form.\nexport function EnrollForm(');
    const ctx = await context();
    const reused = reuseMultiBlockSection(section, { blocks: componentBlocks(ctx), chainHash: ctx.structureHash }, sourceFiles(repo), 2);
    expect(reused).not.toBeNull();
    const s1 = reused!.walkthrough.stages[0].steps[0];
    expect(s1.code_ref).toEqual({ file: 'web/components/EnrollForm.tsx', start: 19, end: 20 });
    const s4 = reused!.walkthrough.stages[2].steps[1];
    expect(s4.code_ref).toEqual({ file: 'web/hooks/useEnrollMutation.ts', start: 15, end: 26 });
    section = reused!;
  });

  it('marks only the steps whose code changed stale when the hook changes, and the Markdown has the overview', async () => {
    edit('web/hooks/useEnrollMutation.ts', "setStatus('submitting');", 'setStatus("submitting");');
    const ctx = await context();
    const saved: SavedWalkthrough = {
      version: SAVED_VERSION,
      scopeKind: 'component',
      scopeRef: ctx.scopeRef,
      overview: null,
      component: componentOverviewOf(ctx),
      sections: [section],
    };
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    const status = checkWalkthrough(saved, source, () => ctx.structureHash);
    expect(status.fresh).toBe(false);
    expect(status.chainChanged).toBe(false);
    expect(status.sections[0].changedBlocks).toEqual(['useEnrollMutation']);
    expect(status.staleSteps).toBe(1);
    expect(checkWalkthrough(saved, source, () => 'different').chainChanged).toBe(true);
    expect(checkWalkthrough(saved, source, () => null).routeRemoved).toBe(true);

    const md = renderMarkdown(saved, codeReader(repo));
    expect(md).toContain('# How EnrollForm works');
    expect(md).toContain('## Component');
    expect(md).toContain('- Hooks: useState (react), useEnrollMutation (expanded)');
  });
});
