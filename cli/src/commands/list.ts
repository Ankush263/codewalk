import { checkWalkthrough, currentChainHash, currentStructureHash, currentTraceHash, filesOf, indexRepo, listSavedWalkthroughs, loadCurrentSource } from '@codewalk/core';
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
    const entries = await listSavedWalkthroughs(store);
    const source = await loadCurrentSource(store, repo.repoRoot, entries.flatMap((e) => filesOf(e.saved)));
    const chains = new Map<string, string | null>();
    for (const { saved } of entries) {
      if (saved.scopeKind === 'endpoint') chains.set(saved.scopeRef, await currentChainHash(store, saved.scopeRef));
      if (saved.scopeKind === 'component') {
        chains.set(saved.scopeRef, await currentStructureHash(store, repo.repoRoot, saved.scopeRef, saved.sections[0]?.depth ?? 2));
      }
      if (saved.scopeKind === 'trace') {
        chains.set(saved.scopeRef, await currentTraceHash(store, repo.repoRoot, saved.scopeRef, saved.sections[0]?.depth ?? 3));
      }
    }
    rows = entries.map(({ saved, savedAt }) => ({
      scopeKind: saved.scopeKind,
      scopeRef: saved.scopeRef,
      savedAt,
      status: checkWalkthrough(saved, source, (ref) => chains.get(ref)),
    }));
  } finally {
    await store.close();
  }

  io.log(options.out === 'json' ? JSON.stringify(rows, null, 2) : formatList(rows));
  return 0;
}
