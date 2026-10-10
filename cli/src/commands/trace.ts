import { createInterface } from 'node:readline/promises';
import {
  addPinnedEdge,
  AnthropicProvider,
  buildTraceContext,
  generateTraceSection,
  indexRepo,
  loadConfig,
  loadSavedWalkthrough,
  parseComponentTarget,
  parseEndpointTarget,
  persistWalkthrough,
  PinNeededError,
  pinFor,
  reuseMultiBlockSection,
  SAVED_VERSION,
  sourceFiles,
  traceBlocks,
  traceOverviewOf,
  type LlmProvider,
  type SavedWalkthrough,
  type TraceContext,
  type TraceTarget,
  type WalkConfig,
} from '@codewalk/core';
import { formatTraceFacts } from '../ui/format.js';
import { printWalkthrough, type OutFormat } from '../ui/output.js';
import { connectStore, loadRepo, reportError, type IO } from './shared.js';

export interface TraceOptions {
  /** False with --no-llm: print only the static facts. */
  llm: boolean;
  depth: number;
  out: OutFormat;
  /** Ignore the saved walkthrough and regenerate (--refresh). */
  refresh: boolean;
  /** --from <file>[#<Component>]: which caller to trace. */
  from?: string;
  /** --pin <n>: pin loose candidate n (1-based) to the route. */
  pin?: number;
}

export interface TraceDeps {
  provider?: LlmProvider;
  /** Use the Ink stepper and allow prompts; defaults to true when stdin and stdout are terminals. */
  interactive?: boolean;
  /** Asks the user a question (tests inject answers); defaults to a readline prompt. */
  ask?: (question: string) => Promise<string>;
}

/** `walk trace "<METHOD> <path>"`. Returns an exit code. */
export async function runTrace(cwd: string, routeArg: string, options: TraceOptions, io: IO, deps: TraceDeps = {}): Promise<number> {
  let target: TraceTarget;
  try {
    target = { endpoint: parseEndpointTarget(routeArg), from: options.from ? parseComponentTarget(options.from) : null };
  } catch (err) {
    return reportError(err, io);
  }

  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  let saved: SavedWalkthrough;
  try {
    await store.migrate();
    const index = async (config: WalkConfig) => {
      const result = await indexRepo(repo.repoRoot, config, store);
      for (const warning of result.warnings) io.error(`! ${warning}`);
    };
    const build = () => buildTraceContext(store, repo.repoRoot, target, { depth: options.depth, maxContextTokens: repo.config.llm.maxContextTokens });

    await index(repo.config);
    let ctx: TraceContext;
    try {
      ctx = await build();
    } catch (err) {
      if (!(err instanceof PinNeededError)) throw err;
      const choice = options.pin ?? (interactive ? await askForPin(err, deps.ask ?? terminalAsk, io) : null);
      const candidate = choice === null ? undefined : err.candidates[choice - 1];
      if (!candidate) {
        if (choice !== null) io.error(`✖ --pin ${choice} is not one of the ${err.candidates.length} candidates.`);
        io.error(`✖ ${err.message}`);
        io.error(`  Pin one with: walk trace "${err.route.method} ${err.route.fullPath}" --pin <n>`);
        return 1;
      }
      addPinnedEdge(repo.repoRoot, pinFor(candidate, err.route));
      io.error(`Pinned ${candidate.apiCall.method} ${candidate.apiCall.urlPattern} in ${candidate.apiCall.caller.name} to ${err.route.method} ${err.route.fullPath} (.walkthrough/config.json).`);
      await index(loadConfig(repo.repoRoot));
      ctx = await build();
    }
    for (const warning of ctx.warnings) io.error(`! ${warning}`);

    if (!options.llm) {
      io.log(options.out === 'json' ? JSON.stringify(ctx, null, 2) : formatTraceFacts(ctx));
      return 0;
    }

    const previous = options.refresh ? null : await loadSavedWalkthrough(store, 'trace', ctx.scopeRef);
    const current = { blocks: traceBlocks(ctx), chainHash: ctx.traceHash };
    let section = previous && reuseMultiBlockSection(previous.sections[0], current, sourceFiles(repo.repoRoot), options.depth);
    if (section) {
      io.error(`Code unchanged since ${section.generatedAt}: showing the saved walkthrough (--refresh to regenerate).`);
    } else {
      io.error(`Explaining ${ctx.scopeRef} with ${repo.config.llm.model}…`);
      const provider = deps.provider ?? new AnthropicProvider(repo.config.llm.model);
      section = await generateTraceSection(provider, ctx, repo.repoRoot, { model: repo.config.llm.model, depth: options.depth });
    }
    saved = { version: SAVED_VERSION, scopeKind: 'trace', scopeRef: ctx.scopeRef, overview: null, trace: traceOverviewOf(ctx), sections: [section] };
    const paths = await persistWalkthrough(store, repo.repoRoot, saved);
    io.error(`Saved ${paths.markdown}`);
  } catch (err) {
    return reportError(err, io);
  } finally {
    await store.close();
  }

  await printWalkthrough(saved, options.out, repo.repoRoot, io, interactive);
  return 0;
}

/** Lists the candidates and asks for one; null when the user cancels or answers something else. */
async function askForPin(err: PinNeededError, ask: (question: string) => Promise<string>, io: IO): Promise<number | null> {
  io.error(err.message);
  const answer = (await ask(`Pin which call to ${err.route.method} ${err.route.fullPath}? [1-${err.candidates.length}, Enter to cancel] `)).trim();
  const n = Number(answer);
  return answer !== '' && Number.isInteger(n) ? n : null;
}

async function terminalAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
