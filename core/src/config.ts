import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';

// Loads and validates <repo>/.walkthrough/config.json (CLAUDE.md §10).

export const WALKTHROUGH_DIR = '.walkthrough';
export const CONFIG_FILE = join(WALKTHROUGH_DIR, 'config.json');
export const DEFAULT_DATABASE_URL = 'postgres://codewalk:codewalk@localhost:5432/codewalk';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const configSchema = z.object({
  roots: z
    .object({ backend: z.string().min(1).optional(), frontend: z.string().min(1).optional() })
    .refine((r) => r.backend !== undefined || r.frontend !== undefined, {
      message: 'set at least one of roots.backend or roots.frontend',
    }),
  apiClientWrappers: z
    .array(
      z.object({
        name: z.string().min(1),
        method: z.enum(HTTP_METHODS),
        urlArgIndex: z.number().int().min(0),
      }),
    )
    .default([]),
  database: z.object({
    url: z.string().min(1),
    schema: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'use lowercase letters, digits and underscores, e.g. cw_my_repo'),
  }),
  ignore: z.array(z.string()).default(['**/node_modules/**', '**/dist/**', '**/*.test.ts']),
  collapseHelpers: z.array(z.string()).default([]),
  // Entry shape is defined in Phase 5 (walk trace); accepted as-is until then.
  pinnedEdges: z.array(z.unknown()).default([]),
  llm: z.object({
    provider: z.literal('anthropic'),
    model: z.string().min(1),
    maxContextTokens: z.number().int().positive(),
  }),
});

export type WalkConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Walks up from `start` to the nearest directory containing .walkthrough/config.json. */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Reads and validates the config of the repo at `repoRoot`; roots must exist on disk. */
export function loadConfig(repoRoot: string): WalkConfig {
  const path = join(repoRoot, CONFIG_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Could not read ${path}: ${(err as Error).message}`);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid ${path}:\n${z.prettifyError(parsed.error)}`);
  }

  for (const [side, root] of Object.entries(parsed.data.roots)) {
    if (root === undefined) continue;
    const abs = join(repoRoot, root);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new ConfigError(`roots.${side} is "${root}", but ${abs} is not a directory`);
    }
  }
  return parsed.data;
}

/** Postgres schema name for a repo directory, e.g. "/src/My-Repo" -> "cw_my_repo". */
export function schemaNameFor(repoRoot: string): string {
  const slug = basename(resolve(repoRoot))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `cw_${slug || 'repo'}`.slice(0, 63);
}

const BACKEND_CANDIDATES = ['apps/api', 'apps/server', 'apps/backend', 'api', 'server', 'backend'];
const FRONTEND_CANDIDATES = ['apps/web', 'apps/client', 'apps/frontend', 'web', 'client', 'frontend'];

/** A starting config for `walk init`, with roots guessed from common monorepo layouts. */
export function createDefaultConfig(repoRoot: string): WalkConfig {
  const firstDir = (candidates: string[]) => candidates.find((c) => existsSync(join(repoRoot, c)));
  const backend = firstDir(BACKEND_CANDIDATES);
  const frontend = firstDir(FRONTEND_CANDIDATES);

  return configSchema.parse({
    roots: backend || frontend ? { backend, frontend } : { backend: '.' },
    database: { url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, schema: schemaNameFor(repoRoot) },
    llm: { provider: 'anthropic', model: 'claude-sonnet-5', maxContextTokens: 60000 },
  });
}
