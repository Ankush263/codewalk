import {
  AnthropicProvider,
  buildComponentContext,
  componentBlocks,
  componentOverviewOf,
  generateComponentSection,
  indexRepo,
  loadSavedWalkthrough,
  parseComponentTarget,
  persistWalkthrough,
  reuseMultiBlockSection,
  SAVED_VERSION,
  sourceFiles,
  type LlmProvider,
  type SavedWalkthrough,
} from '@codewalk/core';
import { formatComponentFacts } from '../ui/format.js';
import { printWalkthrough, type OutFormat } from '../ui/output.js';
import { connectStore, loadRepo, reportError, type IO } from './shared.js';

export interface ComponentOptions {
  /** False with --no-llm: print only the static facts. */
  llm: boolean;
  depth: number;
  out: OutFormat;
  /** Ignore the saved walkthrough and regenerate (--refresh). */
  refresh: boolean;
}

export interface ComponentDeps {
  /** Overrides the configured Anthropic provider (tests use recorded responses). */
  provider?: LlmProvider;
  /** Use the Ink stepper; defaults to true when stdin and stdout are terminals. */
  interactive?: boolean;
}

/** `walk component <file>[#<Component>]`. Returns an exit code. */
export async function runComponent(cwd: string, targetArg: string, options: ComponentOptions, io: IO, deps: ComponentDeps = {}): Promise<number> {
  let target;
  try {
    target = parseComponentTarget(targetArg);
  } catch (err) {
    return reportError(err, io);
  }

  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;

  let saved: SavedWalkthrough;
  try {
    // Facts first: bring the index (React facts and API calls included) up to date.
    await store.migrate();
    await indexRepo(repo.repoRoot, repo.config, store);

    const ctx = await buildComponentContext(store, repo.repoRoot, target, {
      depth: options.depth,
      maxContextTokens: repo.config.llm.maxContextTokens,
    });
    for (const warning of ctx.warnings) io.error(`! ${warning}`);

    if (!options.llm) {
      io.log(options.out === 'json' ? JSON.stringify(ctx, null, 2) : formatComponentFacts(ctx));
      return 0;
    }

    // Cached by the content of every explained block and the component's structure (CLAUDE.md §9).
    const previous = options.refresh ? null : await loadSavedWalkthrough(store, 'component', ctx.scopeRef);
    const current = { blocks: componentBlocks(ctx), chainHash: ctx.structureHash };
    let section = previous && reuseMultiBlockSection(previous.sections[0], current, sourceFiles(repo.repoRoot), options.depth);
    if (section) {
      io.error(`Code unchanged since ${section.generatedAt}: showing the saved walkthrough (--refresh to regenerate).`);
    } else {
      io.error(`Explaining ${ctx.scopeRef} with ${repo.config.llm.model}…`);
      const provider = deps.provider ?? new AnthropicProvider(repo.config.llm.model);
      section = await generateComponentSection(provider, ctx, repo.repoRoot, { model: repo.config.llm.model, depth: options.depth });
    }
    saved = { version: SAVED_VERSION, scopeKind: 'component', scopeRef: ctx.scopeRef, overview: null, component: componentOverviewOf(ctx), sections: [section] };
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
