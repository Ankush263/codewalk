import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  DatabaseUnreachableError,
  findRepoRoot,
  loadConfig,
  openStore,
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
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const compose = join(dir, 'docker-compose.yml');
    if (existsSync(compose)) return `docker compose -f ${compose} up -d`;
    const parent = resolve(dir, '..');
    if (parent === dir) return 'docker compose up -d   # run from the codewalk checkout';
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
}

function describeCause(cause: unknown): string {
  if (cause instanceof AggregateError && cause.errors.length > 0) return describeCause(cause.errors[0]);
  if (cause instanceof Error) return cause.message || cause.name;
  return String(cause);
}
