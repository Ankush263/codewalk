import {
  AnthropicProvider,
  buildFnContext,
  fnScopeRef,
  generateSection,
  indexRepo,
  loadSavedWalkthrough,
  parseFnTarget,
  persistWalkthrough,
  reuseSection,
  SAVED_VERSION,
  sourceFiles,
  type LlmProvider,
  type SavedWalkthrough,
} from '@codewalk/core';
import { formatFacts } from '../ui/format.js';
import { printWalkthrough, type OutFormat } from '../ui/output.js';
import { connectStore, loadRepo, reportError, type IO } from './shared.js';

export interface FnOptions {
  /** False with --no-llm: print only the static facts. */
  llm: boolean;
  depth: number;
  out: OutFormat;
  /** Ignore the saved walkthrough and regenerate (--refresh). */
  refresh: boolean;
}

export interface FnDeps {
  /** Overrides the configured Anthropic provider (tests use recorded responses). */
  provider?: LlmProvider;
  /** Use the Ink stepper; defaults to true when stdin and stdout are terminals. */
  interactive?: boolean;
}

/** `walk fn <file>#<symbol> | <file>:<start>-<end>`. Returns an exit code. */
export async function runFn(cwd: string, targetArg: string, options: FnOptions, io: IO, deps: FnDeps = {}): Promise<number> {
  let target;
  try {
    target = parseFnTarget(targetArg);
  } catch (err) {
    return reportError(err, io);
  }

  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;

  let saved: SavedWalkthrough;
  try {
    // Facts first: bring the index up to date (a no-op when nothing changed).
    await store.migrate();
    await indexRepo(repo.repoRoot, repo.config, store);

    const ctx = await buildFnContext(store, repo.repoRoot, target, {
      depth: options.depth,
      maxContextTokens: repo.config.llm.maxContextTokens,
    });
    for (const warning of ctx.warnings) io.error(`! ${warning}`);

    if (!options.llm) {
      io.log(options.out === 'json' ? JSON.stringify(ctx, null, 2) : formatFacts(ctx));
      return 0;
    }

    // Cached by the content of the explained code (CLAUDE.md §9): unchanged code is not re-sent.
    const scopeRef = fnScopeRef(target);
    const previous = options.refresh ? null : await loadSavedWalkthrough(store, 'fn', scopeRef);
    const current = { start: ctx.target.start, end: ctx.target.end, lines: ctx.target.code.lines };
    let section = previous && reuseSection(previous.sections[0], current, sourceFiles(repo.repoRoot), options.depth);
    if (section) {
      io.error(`Code unchanged since ${section.generatedAt}: showing the saved walkthrough (--refresh to regenerate).`);
    } else {
      io.error(`Explaining ${ctx.target.file}:${ctx.target.start}-${ctx.target.end} with ${repo.config.llm.model}…`);
      const provider = deps.provider ?? new AnthropicProvider(repo.config.llm.model);
      section = await generateSection(provider, ctx, repo.repoRoot, {
        symbol: target.kind === 'symbol' ? target.name : null,
        model: repo.config.llm.model,
        depth: options.depth,
      });
    }
    saved = { version: SAVED_VERSION, scopeKind: 'fn', scopeRef, overview: null, sections: [section] };
    const paths = await persistWalkthrough(store, repo.repoRoot, saved);
    io.error(`Saved ${paths.markdown}`);
  } catch (err) {
    return reportError(err, io);
  } finally {
    await store.close();
  }

  await printWalkthrough(saved, options.out, repo.repoRoot, io, deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  return 0;
}
