import { currentStructureHash } from '../context/component.js';
import { currentChainHash } from '../context/endpoint.js';
import { currentTraceHash } from '../context/trace.js';
import type { Store } from '../store/index.js';
import { listSavedWalkthroughs } from './persist.js';
import type { SavedWalkthrough } from './saved.js';
import { checkWalkthrough, filesOf, loadCurrentSource, type WalkthroughStatus } from './staleness.js';

// Fresh or stale against the current code (CLAUDE.md §9), for `walk list` and `walk serve`. The index
// must be current. Endpoint, component and trace walkthroughs also compare their structure hash.

export async function walkthroughStatus(store: Store, repoRoot: string, saved: SavedWalkthrough): Promise<WalkthroughStatus> {
  const source = await loadCurrentSource(store, repoRoot, filesOf(saved));
  const hash = await currentHashFor(store, repoRoot, saved);
  return checkWalkthrough(saved, source, () => hash);
}

export async function walkthroughStatuses(store: Store, repoRoot: string): Promise<{ saved: SavedWalkthrough; savedAt: Date; status: WalkthroughStatus }[]> {
  const entries = await listSavedWalkthroughs(store);
  const source = await loadCurrentSource(store, repoRoot, entries.flatMap((e) => filesOf(e.saved)));
  const out: { saved: SavedWalkthrough; savedAt: Date; status: WalkthroughStatus }[] = [];
  for (const entry of entries) {
    const hash = await currentHashFor(store, repoRoot, entry.saved);
    out.push({ ...entry, status: checkWalkthrough(entry.saved, source, () => hash) });
  }
  return out;
}

/** The current chain / structure / trace hash of a structural walkthrough; undefined for fn and file. */
async function currentHashFor(store: Store, repoRoot: string, saved: SavedWalkthrough): Promise<string | null | undefined> {
  const depth = saved.sections[0]?.depth;
  switch (saved.scopeKind) {
    case 'endpoint':
      return currentChainHash(store, saved.scopeRef);
    case 'component':
      return currentStructureHash(store, repoRoot, saved.scopeRef, depth ?? 2);
    case 'trace':
      return currentTraceHash(store, repoRoot, saved.scopeRef, depth ?? 3);
    default:
      return undefined;
  }
}
