import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStore, type Store } from './store.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

// Upgrading a schema created before the unique (scope_kind, scope_ref) index: duplicates must not
// block the migration; the newest row of each scope is kept.
describe('walkthroughs unique-scope migration', () => {
  const schema = `cw_test_mig_${randomBytes(4).toString('hex')}`;
  let store: Store;
  let pool: pg.Pool;

  beforeAll(async () => {
    await runner({ databaseUrl: DATABASE_URL, dir: MIGRATIONS_DIR, migrationsTable: 'pgmigrations', schema, createSchema: true, direction: 'up', count: 1, log: () => {} });
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema},public` });
    store = await openStore({ url: DATABASE_URL, schema });
  });

  afterAll(async () => {
    await pool?.end();
    await store?.dropSchema();
    await store?.close();
  });

  it('removes duplicate scopes, keeping the newest, then enforces one row per scope', async () => {
    await pool.query(
      `INSERT INTO walkthroughs (scope_kind, scope_ref, content_hash, content) VALUES
         ('fn', 'a.ts#f', 'old', '{"v":1}'), ('fn', 'a.ts#f', 'new', '{"v":2}'), ('file', 'a.ts', 'only', '{"v":3}')`,
    );
    await store.migrate();

    const all = await store.listWalkthroughs();
    expect(all.map((w) => `${w.scopeKind} ${w.scopeRef} ${w.contentHash}`)).toEqual(['file a.ts only', 'fn a.ts#f new']);
    await expect(
      pool.query(`INSERT INTO walkthroughs (scope_kind, scope_ref, content_hash, content) VALUES ('fn', 'a.ts#f', 'x', '{}')`),
    ).rejects.toThrow(/unique/);
  });
});
