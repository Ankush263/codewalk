import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Project, ts } from 'ts-morph';
import type { WalkConfig } from '../config.js';
import type { Store } from '../store/index.js';
import type { FileFacts, IndexStats } from '../store/types.js';
import { discoverFiles } from './discover.js';
import { Extractor } from './extract.js';

export interface IndexResult {
  /** Files found under the configured roots. */
  scanned: number;
  /** New or modified files: all facts replaced. */
  changed: string[];
  /** Files no longer on disk: deleted from the index. */
  removed: string[];
  /** Unchanged files that call into or import a changed file: calls rebuilt. */
  refreshed: string[];
  stats: IndexStats;
  durationMs: number;
}

/** index_settings key for the config values that change what extraction produces. */
export const EXTRACTION_SETTINGS = 'extraction';

/** Changes when a config value that affects extraction changes (CLAUDE.md §10: apiClientWrappers). */
export function extractionSettingsHash(config: WalkConfig): string {
  return createHash('sha256').update(JSON.stringify({ apiClientWrappers: config.apiClientWrappers })).digest('hex');
}

/**
 * Brings the index for `repoRoot` up to date. Only files whose content hash changed are
 * re-extracted; files depending on them get their outgoing calls rebuilt. One transaction.
 */
export async function indexRepo(repoRoot: string, config: WalkConfig, store: Store): Promise<IndexResult> {
  const started = performance.now();
  const root = resolve(repoRoot);
  const files = discoverFiles(root, config);
  // A config change (e.g. a new API client wrapper) changes the facts of files whose content didn't change.
  const settings = extractionSettingsHash(config);
  if ((await store.getIndexSetting(EXTRACTION_SETTINGS)) !== settings) await store.resetIndexForSetting(EXTRACTION_SETTINGS, settings);
  const stored = await store.getFileHashes();

  const present = new Set(files.map((f) => f.path));
  const changed = files.filter((f) => stored.get(f.path) !== f.hash);
  const removed = [...stored.keys()].filter((p) => !present.has(p)).sort();
  const touched = [...changed.map((f) => f.path), ...removed];

  let refreshed: string[] = [];
  if (touched.length > 0) {
    const dependents = new Set([
      ...(await store.getCallerFiles(touched)),
      ...(await store.getImporters(touched)),
      ...(await store.getRouterCallFiles(touched)),
    ]);
    refreshed = [...dependents].filter((p) => present.has(p) && !touched.includes(p)).sort();

    const project = createProject(root);
    for (const path of [...changed.map((f) => f.path), ...refreshed]) {
      project.addSourceFileAtPath(join(root, path));
    }
    project.resolveSourceFileDependencies();

    const extractor = new Extractor(project, root, present, { apiClientWrappers: config.apiClientWrappers });
    const fileFacts: FileFacts[] = changed.map((f) => ({
      path: f.path,
      hash: f.hash,
      language: f.language,
      ...extractor.extract(f.path),
    }));
    const callRefreshes = refreshed.map((path) => {
      const { calls, routerCalls, sideEffects, reactFacts, apiCalls } = extractor.extract(path);
      return { path, calls, routerCalls, sideEffects, reactFacts, apiCalls };
    });

    await store.applyIndexChanges({ files: fileFacts, removedPaths: removed, callRefreshes });
  }

  return {
    scanned: files.length,
    changed: changed.map((f) => f.path),
    removed,
    refreshed,
    stats: await store.getIndexStats(),
    durationMs: Math.round(performance.now() - started),
  };
}

/** Uses the repo's root tsconfig.json for module resolution (paths, baseUrl) when present. */
export function createProject(root: string): Project {
  const tsConfigFilePath = join(root, 'tsconfig.json');
  const overrides = { allowJs: true, noEmit: true, skipLibCheck: true };
  if (existsSync(tsConfigFilePath)) {
    return new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true, compilerOptions: overrides });
  }
  return new Project({
    compilerOptions: {
      ...overrides,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
    },
  });
}
