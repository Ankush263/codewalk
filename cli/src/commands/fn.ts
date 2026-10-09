import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { render } from 'ink';
import {
  AnthropicProvider,
  buildFnContext,
  explainFn,
  indexRepo,
  LlmOutputError,
  LlmRequestError,
  NoVerifiedStepsError,
  parseFnTarget,
  TargetError,
  type FnWalkthrough,
  type LlmProvider,
} from '@codewalk/core';
import { Stepper } from '../ui/Stepper.js';
import { formatFacts, formatWalkthrough } from '../ui/format.js';
import { connectStore, loadRepo, type IO } from './shared.js';

export interface FnOptions {
  /** False with --no-llm: print only the static facts. */
  llm: boolean;
  depth: number;
  out: 'terminal' | 'json';
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
    return fail(err, io);
  }

  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;

  let walkthrough: FnWalkthrough;
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

    io.error(`Explaining ${ctx.target.file}:${ctx.target.start}-${ctx.target.end} with ${repo.config.llm.model}…`);
    const provider = deps.provider ?? new AnthropicProvider(repo.config.llm.model);
    walkthrough = await explainFn(provider, ctx, repo.repoRoot);
  } catch (err) {
    return fail(err, io);
  } finally {
    await store.close();
  }

  const codeLines = fileReader(repo.repoRoot);
  if (options.out === 'json') {
    io.log(JSON.stringify(walkthrough, null, 2));
  } else if (deps.interactive ?? (process.stdin.isTTY && process.stdout.isTTY)) {
    const app = render(createElement(Stepper, { walkthrough, codeLines }));
    await app.waitUntilExit();
  } else {
    io.log(formatWalkthrough(walkthrough, codeLines));
  }
  return 0;
}

function fileReader(repoRoot: string): (file: string) => string[] {
  const cache = new Map<string, string[]>();
  return (file) => {
    if (!cache.has(file)) cache.set(file, readFileSync(join(repoRoot, file), 'utf8').split(/\r?\n/));
    return cache.get(file)!;
  };
}

/** Prints known, user-fixable errors and returns 1; anything else is a bug and is rethrown. */
function fail(err: unknown, io: IO): number {
  if (err instanceof TargetError || err instanceof LlmRequestError || err instanceof LlmOutputError) {
    io.error(`✖ ${err.message}`);
    return 1;
  }
  if (err instanceof NoVerifiedStepsError) {
    io.error(`✖ ${err.message}`);
    for (const d of err.dropped) io.error(`  ${d.stepId}: ${d.reasons.join('; ')}`);
    return 1;
  }
  throw err;
}
