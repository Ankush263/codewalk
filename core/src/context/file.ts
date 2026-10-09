import type { Store } from '../store/index.js';
import type { ImporterRecord, SymbolRecord } from '../store/types.js';
import { hashFile, readLines } from '../walkthrough/saved.js';
import { dependencyOrder, walkableSymbols } from './order.js';
import { TargetError } from './target.js';

// Static facts for `walk file` (CLAUDE.md §6.2): who imports the file, what it exports, its internal
// helpers, and the order its functions are walked in. Also the `walk file --no-llm` output.

export interface FileContext {
  file: string;
  lineCount: number;
  importers: ImporterRecord[];
  /** Exported symbols of any kind, in source order. */
  exports: SymbolRecord[];
  /** Walked functions that aren't exported. */
  helpers: SymbolRecord[];
  /** Walked functions, helpers first, entry points last. */
  order: SymbolRecord[];
  cycleBreaks: string[];
  warnings: string[];
}

export async function buildFileContext(store: Store, repoRoot: string, file: string): Promise<FileContext> {
  const record = await store.getFile(file);
  const lines = readLines(repoRoot, file);
  if (!record || !lines) {
    throw new TargetError(`${file} is not in the index. Check the path (relative to the repo root) or run \`walk index\`.`);
  }
  const warnings = hashFile(repoRoot, file) === record.hash ? [] : [`${file} changed since it was indexed; run \`walk index\` for accurate facts.`];

  const [symbols, importers, edges] = await Promise.all([
    store.getSymbolsInFile(file),
    store.getImportersOf(file),
    store.getCallEdgesInFile(file),
  ]);
  const walkable = walkableSymbols(symbols);
  const { order, cycleBreaks } = dependencyOrder(walkable, symbols, edges);

  return {
    file,
    lineCount: lines.length,
    importers,
    exports: symbols.filter((s) => s.exported),
    helpers: walkable.filter((s) => !s.exported),
    order,
    cycleBreaks,
    warnings,
  };
}
