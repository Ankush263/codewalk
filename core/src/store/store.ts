import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import type {
  CalleeRecord,
  CallerRecord,
  IndexChanges,
  IndexStats,
  SymbolKind,
  SymbolRecord,
} from './types.js';

// The only module that talks to Postgres (CLAUDE.md §8.1a). Every connection runs with
// search_path = <repo schema>, public: the repo's tables first, then pgvector's types.

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

// Works from src/store/ (tests, tsx) and from dist/ (bundled build copies migrations there).
const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export interface StoreOptions {
  url: string;
  schema: string;
}

export class DatabaseUnreachableError extends Error {
  constructor(
    public readonly url: string,
    cause: unknown,
  ) {
    super(`Cannot connect to Postgres at ${redactUrl(url)}`, { cause });
    this.name = 'DatabaseUnreachableError';
  }
}

export class InvalidSchemaNameError extends Error {
  constructor(schema: string) {
    super(`Invalid schema name "${schema}": use lowercase letters, digits and underscores (e.g. cw_my_repo)`);
    this.name = 'InvalidSchemaNameError';
  }
}

/** Opens a pool for one repo schema and checks that Postgres is reachable. */
export async function openStore(options: StoreOptions): Promise<Store> {
  if (!SCHEMA_NAME.test(options.schema)) {
    throw new InvalidSchemaNameError(options.schema);
  }
  const pool = new pg.Pool({
    connectionString: options.url,
    options: `-c search_path=${options.schema},public`,
    connectionTimeoutMillis: 3000,
  });
  // Idle-client errors (e.g. the server restarting) must not crash the process.
  pool.on('error', () => {});
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end();
    throw new DatabaseUnreachableError(options.url, err);
  }
  return new Store(pool, options);
}

export class Store {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: StoreOptions,
  ) {}

  get schema(): string {
    return this.options.schema;
  }

  /** Creates the repo schema if needed and applies pending migrations. */
  async migrate(): Promise<void> {
    await runner({
      databaseUrl: this.options.url,
      dir: MIGRATIONS_DIR,
      migrationsTable: 'pgmigrations',
      schema: this.options.schema,
      createSchema: true,
      direction: 'up',
      // node-pg-migrate's default advisory lock is database-wide; lock per schema instead so
      // different repos can migrate concurrently, and wait if the same repo is mid-migration.
      lockValue: schemaLockId(this.options.schema),
      advisoryLockMode: 'wait',
      log: () => {},
    });
  }

  /** Drops the repo schema and everything in it. Used by tests and future `--reset` flows. */
  async dropSchema(): Promise<void> {
    await this.pool.query(`DROP SCHEMA IF EXISTS "${this.options.schema}" CASCADE`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Path -> content hash for every indexed file, for incremental indexing. */
  async getFileHashes(): Promise<Map<string, string>> {
    const { rows } = await this.pool.query<{ path: string; hash: string }>('SELECT path, hash FROM files');
    return new Map(rows.map((r) => [r.path, r.hash]));
  }

  /** Files that import any of `paths`. Their call edges into `paths` must be rebuilt after a change. */
  async getImporters(paths: string[]): Promise<string[]> {
    const { rows } = await this.pool.query<{ path: string }>(
      `SELECT DISTINCT f.path FROM imports i JOIN files f ON f.id = i.file_id
       WHERE i.resolved_path = ANY($1::text[]) ORDER BY f.path`,
      [paths],
    );
    return rows.map((r) => r.path);
  }

  /**
   * Files (other than `paths` themselves) with at least one call edge into a symbol in `paths`.
   * Replacing `paths` cascades those edges away, so these files need their calls rebuilt.
   */
  async getCallerFiles(paths: string[]): Promise<string[]> {
    const { rows } = await this.pool.query<{ path: string }>(
      `SELECT DISTINCT cf.path
       FROM calls c
       JOIN symbols callee ON callee.id = c.callee_symbol_id
       JOIN files tf ON tf.id = callee.file_id
       JOIN symbols caller ON caller.id = c.caller_symbol_id
       JOIN files cf ON cf.id = caller.file_id
       WHERE tf.path = ANY($1::text[]) AND NOT cf.path = ANY($1::text[])
       ORDER BY cf.path`,
      [paths],
    );
    return rows.map((r) => r.path);
  }

  /** Row counts for `walk index` summaries. */
  async getIndexStats(): Promise<IndexStats> {
    const { rows } = await this.pool.query<{ files: string; symbols: string; calls: string; unresolved: string }>(
      `SELECT (SELECT count(*) FROM files) AS files,
              (SELECT count(*) FROM symbols) AS symbols,
              (SELECT count(*) FROM calls) AS calls,
              (SELECT count(*) FROM calls WHERE NOT resolved) AS unresolved`,
    );
    const r = rows[0];
    return { files: Number(r.files), symbols: Number(r.symbols), calls: Number(r.calls), unresolved: Number(r.unresolved) };
  }

  /**
   * Applies one indexing pass in a single transaction:
   * - `files`: all facts replaced (changed or new files),
   * - `removedPaths`: deleted,
   * - `callRefreshes`: unchanged files whose outgoing calls are rebuilt; their symbols (and ids)
   *   are kept, so a change never cascades beyond the files that call into it.
   * Each table is written with a single batched INSERT ... SELECT FROM jsonb_to_recordset.
   * Callees are matched by SymbolKey, so they may live in this batch or in unchanged files.
   */
  async applyIndexChanges({ files = [], removedPaths = [], callRefreshes = [] }: IndexChanges): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM calls WHERE caller_symbol_id IN (
           SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ANY($1::text[]))`,
        [callRefreshes.map((r) => r.path)],
      );
      await client.query('DELETE FROM files WHERE path = ANY($1::text[])', [
        [...files.map((f) => f.path), ...removedPaths],
      ]);

      await client.query(
        `INSERT INTO files (path, hash, language)
         SELECT path, hash, language FROM jsonb_to_recordset($1::jsonb) AS x(path text, hash text, language text)`,
        [JSON.stringify(files.map(({ path, hash, language }) => ({ path, hash, language })))],
      );

      const symbols = files.flatMap((f) => f.symbols.map((s) => ({ ...s, file: f.path })));
      const insertedSymbols = await client.query(
        `INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported, signature)
         SELECT f.id, x.name, x.kind, x."startLine", x."endLine", x.exported, x.signature
         FROM jsonb_to_recordset($1::jsonb) AS x(file text, name text, kind text, "startLine" int,
                                                 "endLine" int, exported boolean, signature text)
         JOIN files f ON f.path = x.file`,
        [JSON.stringify(symbols)],
      );
      assertCount('symbols', insertedSymbols.rowCount, symbols.length);

      // A callee key that matches nothing is kept as an unresolved edge, never dropped silently.
      const calls = [...files, ...callRefreshes].flatMap((f) => f.calls.map((c) => ({ ...c, file: f.path })));
      const insertedCalls = await client.query(
        `INSERT INTO calls (caller_symbol_id, callee_symbol_id, callee_text, call_line, resolved)
         SELECT caller.id, callee.id, x."calleeText", x.line, x.resolved AND (x.callee IS NULL OR callee.id IS NOT NULL)
         FROM jsonb_to_recordset($1::jsonb) AS x(file text, caller jsonb, callee jsonb,
                                                 "calleeText" text, line int, resolved boolean)
         JOIN files cf ON cf.path = x.file
         JOIN symbols caller ON caller.file_id = cf.id
                            AND caller.name = x.caller->>'name'
                            AND caller.start_line = (x.caller->>'startLine')::int
         LEFT JOIN files tf ON tf.path = x.callee->>'file'
         LEFT JOIN symbols callee ON callee.file_id = tf.id
                                 AND callee.name = x.callee->>'name'
                                 AND callee.start_line = (x.callee->>'startLine')::int`,
        [JSON.stringify(calls)],
      );
      assertCount('calls', insertedCalls.rowCount, calls.length);

      const imports = files.flatMap((f) => f.imports.map((i) => ({ ...i, file: f.path })));
      await client.query(
        `INSERT INTO imports (file_id, imported_path, resolved_path, imported_names, package_name, package_version)
         SELECT f.id, x."importedPath", x."resolvedPath", x."importedNames", x."packageName", x."packageVersion"
         FROM jsonb_to_recordset($1::jsonb) AS x(file text, "importedPath" text, "resolvedPath" text,
                                                 "importedNames" text[], "packageName" text, "packageVersion" text)
         JOIN files f ON f.path = x.file`,
        [JSON.stringify(imports)],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** All symbols named `name` in `file` (overloads or same-named methods can repeat). */
  async findSymbol(file: string, name: string): Promise<SymbolRecord[]> {
    const { rows } = await this.pool.query<SymbolRow>(
      `${SELECT_SYMBOL} WHERE f.path = $1 AND s.name = $2 ORDER BY s.start_line`,
      [file, name],
    );
    return rows.map(toSymbolRecord);
  }

  /** Symbols in `file` that overlap lines start..end, outermost first. */
  async findSymbolsInRange(file: string, start: number, end: number): Promise<SymbolRecord[]> {
    const { rows } = await this.pool.query<SymbolRow>(
      `${SELECT_SYMBOL} WHERE f.path = $1 AND s.start_line <= $3 AND s.end_line >= $2
       ORDER BY s.start_line, s.end_line DESC`,
      [file, start, end],
    );
    return rows.map(toSymbolRecord);
  }

  /** Direct callers of a symbol, with the line of each call. */
  async getCallers(symbolId: number): Promise<CallerRecord[]> {
    const { rows } = await this.pool.query<SymbolRow & { call_line: number }>(
      `SELECT s.id, f.path AS file, s.name, s.kind, s.start_line, s.end_line, s.exported, s.signature,
              c.call_line
       FROM calls c JOIN symbols s ON s.id = c.caller_symbol_id JOIN files f ON f.id = s.file_id
       WHERE c.callee_symbol_id = $1
       ORDER BY f.path, c.call_line`,
      [symbolId],
    );
    return rows.map((r) => ({ caller: toSymbolRecord(r), callLine: r.call_line }));
  }

  /**
   * Transitive callees up to `depth` levels, in one recursive query. A symbol already on the
   * current path is not expanded again, so recursion and mutual recursion terminate.
   */
  async getCallees(symbolId: number, depth: number): Promise<CalleeRecord[]> {
    const { rows } = await this.pool.query<CalleeRow>(
      `WITH RECURSIVE walk AS (
         SELECT c.caller_symbol_id, c.callee_symbol_id, c.callee_text, c.call_line, c.resolved,
                1 AS depth, ARRAY[c.caller_symbol_id] AS visited
         FROM calls c WHERE c.caller_symbol_id = $1
         UNION ALL
         SELECT c.caller_symbol_id, c.callee_symbol_id, c.callee_text, c.call_line, c.resolved,
                w.depth + 1, w.visited || c.caller_symbol_id
         FROM calls c JOIN walk w ON c.caller_symbol_id = w.callee_symbol_id
         WHERE w.depth < $2 AND NOT (c.caller_symbol_id = ANY(w.visited))
       )
       SELECT w.depth, w.caller_symbol_id, w.callee_text, w.call_line, w.resolved,
              s.id, f.path AS file, s.name, s.kind, s.start_line, s.end_line, s.exported, s.signature
       FROM walk w
       LEFT JOIN symbols s ON s.id = w.callee_symbol_id
       LEFT JOIN files f ON f.id = s.file_id
       ORDER BY w.depth, w.caller_symbol_id, w.call_line`,
      [symbolId, depth],
    );
    return rows.map((r) => ({
      depth: r.depth,
      callerId: Number(r.caller_symbol_id),
      callee: r.id === null ? null : toSymbolRecord(r as SymbolRow),
      calleeText: r.callee_text,
      callLine: r.call_line,
      resolved: r.resolved,
    }));
  }
}

const SELECT_SYMBOL = `SELECT s.id, f.path AS file, s.name, s.kind, s.start_line, s.end_line, s.exported, s.signature
  FROM symbols s JOIN files f ON f.id = s.file_id`;

interface SymbolRow {
  id: string; // BIGINT arrives as a string from node-postgres
  file: string;
  name: string;
  kind: SymbolKind;
  start_line: number;
  end_line: number;
  exported: boolean;
  signature: string | null;
}

type CalleeRow = { [K in keyof SymbolRow]: SymbolRow[K] | null } & {
  depth: number;
  caller_symbol_id: string;
  callee_text: string;
  call_line: number;
  resolved: boolean;
};

function toSymbolRecord(r: SymbolRow): SymbolRecord {
  return {
    id: Number(r.id),
    file: r.file,
    name: r.name,
    kind: r.kind,
    startLine: r.start_line,
    endLine: r.end_line,
    exported: r.exported,
    signature: r.signature,
  };
}

function assertCount(table: string, actual: number | null, expected: number) {
  if (actual !== expected) {
    throw new Error(`Expected to insert ${expected} ${table} rows but inserted ${actual}: some facts reference unknown files or symbols`);
  }
}

/** Stable signed 32-bit id for a schema name (FNV-1a), used as its migration advisory lock. */
function schemaLockId(schema: string): number {
  let hash = 0x811c9dc5;
  for (const char of schema) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  }
  return hash | 0;
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}
