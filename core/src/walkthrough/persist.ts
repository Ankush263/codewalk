import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WALKTHROUGH_DIR } from '../config.js';
import { renderMarkdown } from '../render/markdown.js';
import type { Store } from '../store/index.js';
import { contentHashOf, readLines, SAVED_VERSION, type SavedWalkthrough, type ScopeKind } from './saved.js';

// Postgres (`walkthroughs`) is the source of truth for caching and `walk list`. Every save is also
// mirrored to .walkthrough/walkthroughs/<slug>.json and .md for reading and sharing (CLAUDE.md §9).

export const WALKTHROUGHS_DIR = join(WALKTHROUGH_DIR, 'walkthroughs');

/** A readable file name; the hash suffix keeps refs that sanitize alike from colliding. */
export function walkthroughSlug(kind: ScopeKind, ref: string): string {
  const readable = ref.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const id = createHash('sha256').update(`${kind}:${ref}`).digest('hex').slice(0, 8);
  return `${kind}--${readable}--${id}`;
}

/** Reads repo files once each; a missing file reads as no lines. */
export function codeReader(repoRoot: string): (file: string) => string[] {
  const cache = new Map<string, string[]>();
  return (file) => {
    if (!cache.has(file)) cache.set(file, readLines(repoRoot, file) ?? []);
    return cache.get(file)!;
  };
}

/** Saves to Postgres and writes the JSON + Markdown mirror. Returns the mirror paths, repo-relative. */
export async function persistWalkthrough(store: Store, repoRoot: string, saved: SavedWalkthrough): Promise<{ json: string; markdown: string }> {
  await store.saveWalkthrough({ scopeKind: saved.scopeKind, scopeRef: saved.scopeRef, contentHash: contentHashOf(saved.sections), content: saved });
  mkdirSync(join(repoRoot, WALKTHROUGHS_DIR), { recursive: true });
  const base = join(WALKTHROUGHS_DIR, walkthroughSlug(saved.scopeKind, saved.scopeRef));
  const paths = { json: `${base}.json`, markdown: `${base}.md` };
  writeFileSync(join(repoRoot, paths.json), `${JSON.stringify(saved, null, 2)}\n`);
  writeFileSync(join(repoRoot, paths.markdown), renderMarkdown(saved, codeReader(repoRoot)));
  return paths;
}

export async function loadSavedWalkthrough(store: Store, kind: ScopeKind, ref: string): Promise<SavedWalkthrough | null> {
  const record = await store.getWalkthrough(kind, ref);
  return record ? asSaved(record.content) : null;
}

export async function listSavedWalkthroughs(store: Store): Promise<{ saved: SavedWalkthrough; savedAt: Date }[]> {
  return (await store.listWalkthroughs()).flatMap((r) => {
    const saved = asSaved(r.content);
    return saved ? [{ saved, savedAt: r.createdAt }] : [];
  });
}

/** Content saved by an older, incompatible format is treated as never generated. */
function asSaved(content: unknown): SavedWalkthrough | null {
  const version = typeof content === 'object' && content !== null ? (content as { version?: unknown }).version : undefined;
  return version === SAVED_VERSION ? (content as SavedWalkthrough) : null;
}
