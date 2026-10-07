import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, openStore } from '@codewalk/core';
import { runIndex } from './index.js';
import { runInit } from './init.js';
import { dockerUpCommand } from './shared.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) }, out, err };
}

describe('walk init', () => {
  let repo: string;
  let schema: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-init-'));
    mkdirSync(join(repo, 'api'));
    writeFileSync(join(repo, 'api', 'hello.ts'), 'export function hello(name: string) {\n  return name.toUpperCase();\n}\n');
    schema = `cw_test_init_${Math.random().toString(16).slice(2, 10)}`;
  });

  afterEach(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  const writeConfig = (url: string) => {
    mkdirSync(join(repo, '.walkthrough'));
    writeFileSync(
      join(repo, CONFIG_FILE),
      JSON.stringify({
        roots: { backend: 'api' },
        database: { url, schema },
        llm: { provider: 'anthropic', model: 'm', maxContextTokens: 1000 },
      }),
    );
  };

  it('creates a default config when none exists', async () => {
    const { io, out } = captureIO();
    const code = await runInit(repo, io);
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    expect(config.roots).toEqual({ backend: 'api' });
    expect(config.database.schema).toMatch(/^cw_cw_init_/);
    expect(out[0]).toBe(`✔ Created ${CONFIG_FILE}`);
    expect(code).toBe(0);
    // Clean up the schema derived from the temp dir name.
    schema = config.database.schema;
  });

  it('migrates using an existing config and is safe to re-run', async () => {
    writeConfig(DATABASE_URL);
    const first = captureIO();
    expect(await runInit(repo, first.io)).toBe(0);
    expect(first.out.slice(0, 2)).toEqual([`✔ Using existing ${CONFIG_FILE}`, `✔ Database schema "${schema}" is ready`]);
    expect(first.out[2]).toMatch(/^✔ Indexed 1 files in \d+ ms: 1 changed, 0 removed, 0 refreshed$/);

    const second = captureIO();
    expect(await runInit(repo, second.io)).toBe(0);

    const store = await openStore({ url: DATABASE_URL, schema });
    expect([...(await store.getFileHashes()).keys()]).toEqual(['api/hello.ts']);
    await store.close();
  });

  it('prints the exact docker command when Postgres is unreachable', async () => {
    writeConfig('postgres://codewalk:codewalk@localhost:1/codewalk');
    const { io, err } = captureIO();
    expect(await runInit(repo, io)).toBe(1);
    expect(err[0]).toBe('✖ Cannot connect to Postgres at postgres://codewalk:***@localhost:1/codewalk');
    expect(err[1]).toMatch(/Reason: .*ECONNREFUSED/);
    expect(err).toContain(`    ${dockerUpCommand()}`);
    expect(dockerUpCommand()).toMatch(/^docker compose -f \/.*\/docker-compose\.yml up -d$/);
  });

  it('reports an invalid config without touching the database', async () => {
    mkdirSync(join(repo, '.walkthrough'));
    writeFileSync(join(repo, CONFIG_FILE), '{}');
    const { io, err } = captureIO();
    expect(await runInit(repo, io)).toBe(1);
    expect(err[0]).toMatch(/^✖ Invalid .*config\.json/);
    expect(existsSync(join(repo, CONFIG_FILE))).toBe(true);
  });

  it('walk index finds the repo from a subdirectory and is incremental', async () => {
    writeConfig(DATABASE_URL);
    expect(await runInit(repo, captureIO().io)).toBe(0);

    const unchanged = captureIO();
    expect(await runIndex(join(repo, 'api'), unchanged.io)).toBe(0);
    expect(unchanged.out[0]).toMatch(/^✔ Index is up to date \(1 files, \d+ ms\)$/);
    expect(unchanged.out[1]).toBe('  1 symbols · 1 calls (0 unresolved)');

    writeFileSync(join(repo, 'api', 'hello.ts'), 'export function hello() {}\n');
    const changed = captureIO();
    expect(await runIndex(repo, changed.io)).toBe(0);
    expect(changed.out[0]).toMatch(/1 changed, 0 removed, 0 refreshed$/);
  });

  it('walk index explains how to start when there is no config', async () => {
    const { io, err } = captureIO();
    expect(await runIndex(repo, io)).toBe(1);
    expect(err[0]).toMatch(/No \.walkthrough\/config\.json found/);
  });
});
