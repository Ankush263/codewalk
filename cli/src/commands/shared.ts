import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidArgumentError } from 'commander';
import {
  ConfigError,
  DatabaseUnreachableError,
  findRepoRoot,
  LlmOutputError,
  LlmRequestError,
  loadConfig,
  NoVerifiedStepsError,
  openStore,
  TargetError,
  type IndexResult,
  type Store,
  type WalkConfig,
} from '@codewalk/core';

export interface IO {
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Finds and loads the config for the repo containing `cwd`; prints the problem and returns null on failure. */
export function loadRepo(cwd: string, io: IO): { repoRoot: string; config: WalkConfig } | null {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) {
    io.error('✖ No .walkthrough/config.json found here or in any parent directory.');
    io.error('  Run `walk init` at the root of your repo first.');
    return null;
  }
  try {
    return { repoRoot, config: loadConfig(repoRoot) };
  } catch (err) {
    if (err instanceof ConfigError) {
      io.error(`✖ ${err.message}`);
      return null;
    }
    throw err;
  }
}

/** Opens the repo's store; prints the exact fix and returns null when Postgres is unreachable. */
export async function connectStore(config: WalkConfig, io: IO): Promise<Store | null> {
  try {
    return await openStore({ url: config.database.url, schema: config.database.schema });
  } catch (err) {
    if (err instanceof DatabaseUnreachableError) {
      io.error(`✖ ${err.message}`);
      io.error(`  Reason: ${describeCause(err.cause)}`);
      io.error('');
      io.error('  Start the codewalk database with:');
      io.error(`    ${dockerUpCommand()}`);
      io.error('  then run the command again.');
      return null;
    }
    throw err;
  }
}

/** The exact command to start Postgres, pointing at codewalk's own docker-compose.yml. */
export function dockerUpCommand(): string {
  const root = codewalkRoot();
  return root ? `docker compose -f ${join(root, 'docker-compose.yml')} up -d` : 'docker compose up -d   # run from the codewalk checkout';
}

/**
 * Loads codewalk's own .env (e.g. ANTHROPIC_API_KEY) if there is one. Never the analysed repo's
 * .env, whose variables belong to that app. Variables already set in the environment win.
 */
export function loadCodewalkEnv(): void {
  const root = codewalkRoot();
  const envFile = root && join(root, '.env');
  if (envFile && existsSync(envFile)) process.loadEnvFile(envFile);
}

/** The built web app in this codewalk checkout (web/dist), or null when it hasn't been built. */
export function findWebRoot(): string | null {
  const root = codewalkRoot();
  const dir = root && join(root, 'web', 'dist');
  return dir && existsSync(join(dir, 'index.html')) ? dir : null;
}

/** The codewalk checkout: the nearest ancestor of this module with docker-compose.yml. */
function codewalkRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, 'docker-compose.yml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

export function printIndexResult(result: IndexResult, io: IO): void {
  const { changed, removed, refreshed, stats } = result;
  if (changed.length + removed.length === 0) {
    io.log(`✔ Index is up to date (${result.scanned} files, ${result.durationMs} ms)`);
  } else {
    io.log(
      `✔ Indexed ${result.scanned} files in ${result.durationMs} ms: ` +
        `${changed.length} changed, ${removed.length} removed, ${refreshed.length} refreshed`,
    );
  }
  io.log(`  ${stats.symbols} symbols · ${stats.calls} calls (${stats.unresolved} unresolved)`);
  for (const warning of result.warnings) io.log(`! ${warning}`);
}

function describeCause(cause: unknown): string {
  if (cause instanceof AggregateError && cause.errors.length > 0) return describeCause(cause.errors[0]);
  if (cause instanceof Error) return cause.message || cause.name;
  return String(cause);
}

/** Prints known, user-fixable errors and returns 1; anything else is a bug and is rethrown. */
export function reportError(err: unknown, io: IO): number {
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

/** commander parser for --port: 0 (any free port) to 65535. */
export function parsePort(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(n) || n > 65535) throw new InvalidArgumentError('must be a port number from 0 to 65535');
  return n;
}
