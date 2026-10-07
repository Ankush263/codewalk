import { indexRepo } from '@codewalk/core';
import { connectStore, loadRepo, printIndexResult, type IO } from './shared.js';

/** `walk index`: incrementally (re)build the symbol graph for the repo containing `cwd`. Returns an exit code. */
export async function runIndex(cwd: string, io: IO): Promise<number> {
  const repo = loadRepo(cwd, io);
  if (!repo) return 1;

  const store = await connectStore(repo.config, io);
  if (!store) return 1;

  try {
    await store.migrate();
    printIndexResult(await indexRepo(repo.repoRoot, repo.config, store), io);
  } finally {
    await store.close();
  }
  return 0;
}
