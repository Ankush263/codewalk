import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../store/index.js';
import { sectionFor } from './__fixtures__/sections.js';
import { listSavedWalkthroughs, loadSavedWalkthrough, persistWalkthrough, walkthroughSlug } from './persist.js';
import { SAVED_VERSION, type SavedWalkthrough } from './saved.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const SOURCE = ['function main() {', '  return 1;', '}'];

describe('persistence', () => {
  let repo: string;
  let store: Store;
  const saved = (summary = 'Summary.'): SavedWalkthrough => {
    const section = sectionFor(SOURCE, 'api/a.ts', 'main', 1, 3);
    section.walkthrough.summary = summary;
    return { version: SAVED_VERSION, scopeKind: 'fn', scopeRef: 'api/a.ts#main', overview: null, sections: [section] };
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-persist-'));
    mkdirSync(join(repo, 'api'));
    writeFileSync(join(repo, 'api', 'a.ts'), `${SOURCE.join('\n')}\n`);
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_persist_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('makes readable, collision-free file names', () => {
    expect(walkthroughSlug('fn', 'api/a.ts#main')).toMatch(/^fn--api_a\.ts_main--[0-9a-f]{8}$/);
    // Both sanitize to "api_a.ts_main"; the hash suffix keeps them apart.
    expect(walkthroughSlug('fn', 'api/a.ts#main')).not.toBe(walkthroughSlug('fn', 'api_a.ts_main'));
  });

  it('saves to Postgres and mirrors JSON + Markdown under .walkthrough/walkthroughs', async () => {
    const paths = await persistWalkthrough(store, repo, saved());
    expect(paths.json).toMatch(/^\.walkthrough\/walkthroughs\/fn--api_a\.ts_main--[0-9a-f]{8}\.json$/);
    expect(JSON.parse(readFileSync(join(repo, paths.json), 'utf8'))).toEqual(saved());
    expect(readFileSync(join(repo, paths.markdown), 'utf8')).toContain('1 | function main() {');
    expect(await loadSavedWalkthrough(store, 'fn', 'api/a.ts#main')).toEqual(saved());
  });

  it('replaces the previous save of the same scope', async () => {
    await persistWalkthrough(store, repo, saved('Second.'));
    const all = await listSavedWalkthroughs(store);
    expect(all).toHaveLength(1);
    expect(all[0].saved.sections[0].walkthrough.summary).toBe('Second.');
    expect(all[0].savedAt).toBeInstanceOf(Date);
  });

  it('ignores content saved in an older format', async () => {
    await store.saveWalkthrough({ scopeKind: 'fn', scopeRef: 'api/old.ts#f', contentHash: 'x', content: { version: 0 } });
    expect(await loadSavedWalkthrough(store, 'fn', 'api/old.ts#f')).toBeNull();
    expect((await listSavedWalkthroughs(store)).map((e) => e.saved.scopeRef)).toEqual(['api/a.ts#main']);
    expect(existsSync(join(repo, '.walkthrough', 'walkthroughs'))).toBe(true);
  });
});
