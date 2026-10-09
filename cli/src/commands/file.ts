import {
  AnthropicProvider,
  buildFileContext,
  explainFile,
  indexRepo,
  loadSavedWalkthrough,
  parseFileTarget,
  persistWalkthrough,
  type SavedWalkthrough,
} from '@codewalk/core';
import { formatFileFacts } from '../ui/format.js';
import { printWalkthrough, type OutFormat } from '../ui/output.js';
import type { FnDeps } from './fn.js';
import { connectStore, loadRepo, reportError, type IO } from './shared.js';

export interface FileOptions {
  /** False with --no-llm: print only the static facts. */
  llm: boolean;
  depth: number;
  out: OutFormat;
  /** Ignore saved sections and regenerate every function (--refresh). */
  refresh: boolean;
}

/** `walk file <file>`: every function, helpers first. Returns an exit code (1 if any function failed). */
export async function runFile(cwd: string, fileArg: string, options: FileOptions, io: IO, deps: FnDeps = {}): Promise<number> {
  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;

  let saved: SavedWalkthrough;
  let aborted = false;
  try {
    await store.migrate();
    await indexRepo(repo.repoRoot, repo.config, store);

    const fileCtx = await buildFileContext(store, repo.repoRoot, parseFileTarget(fileArg));
    for (const warning of fileCtx.warnings) io.error(`! ${warning}`);
    if (!options.llm) {
      io.log(options.out === 'json' ? JSON.stringify(fileCtx, null, 2) : formatFileFacts(fileCtx));
      return 0;
    }

    const { model, maxContextTokens } = repo.config.llm;
    // Loaded even with --refresh: functions whose regeneration fails keep their saved section.
    const previous = await loadSavedWalkthrough(store, 'file', fileCtx.file);
    const provider = deps.provider ?? new AnthropicProvider(model);
    io.error(
      fileCtx.order.length === 0
        ? `No functions to explain in ${fileCtx.file}; showing its overview.`
        : `Explaining ${fileCtx.order.length} function(s) in ${fileCtx.file} with ${model}…`,
    );
    const result = await explainFile(store, provider, repo.repoRoot, fileCtx, previous, {
      depth: options.depth,
      maxContextTokens,
      model,
      refresh: options.refresh,
      onProgress: (line) => io.error(`  ${line}`),
    });
    saved = result.saved;
    const paths = await persistWalkthrough(store, repo.repoRoot, saved);
    io.error(`Saved ${paths.markdown} (${result.generated.length} generated, ${result.reused.length} reused)`);
    for (const f of saved.overview!.failed) io.error(`✖ ${f.symbol}: ${f.reason}`);
    if (result.aborted) {
      aborted = true;
      io.error(`✖ Stopped early: ${result.aborted.message}`);
    }
  } catch (err) {
    return reportError(err, io);
  } finally {
    await store.close();
  }

  await printWalkthrough(saved, options.out, repo.repoRoot, io, deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  return aborted || saved.overview!.failed.length > 0 ? 1 : 0;
}
