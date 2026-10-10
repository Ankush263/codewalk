import { indexRepo, walkthroughStatuses } from '@codewalk/core';
import { formatList, type ListRow } from '../ui/format.js';
import { connectStore, loadRepo, type IO } from './shared.js';

export interface ListOptions {
  out: 'terminal' | 'json';
}

/** `walk list`: every saved walkthrough, fresh or stale against the current code. Returns an exit code. */
export async function runList(cwd: string, options: ListOptions, io: IO): Promise<number> {
  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;

  let rows: ListRow[];
  try {
    await store.migrate();
    // Blocks are found again by symbol name, so the index must match the code on disk.
    await indexRepo(repo.repoRoot, repo.config, store);
    rows = (await walkthroughStatuses(store, repo.repoRoot)).map(({ saved, savedAt, status }) => ({ scopeKind: saved.scopeKind, scopeRef: saved.scopeRef, savedAt, status }));
  } finally {
    await store.close();
  }

  io.log(options.out === 'json' ? JSON.stringify(rows, null, 2) : formatList(rows));
  return 0;
}
