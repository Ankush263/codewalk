import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { handlerKey, handlerLabel, handlerNote, stitchRoutes } from '../routes/stitch.js';
import type {
  CallEdge,
  CalleeRecord,
  CallerRecord,
  FileRecord,
  ImporterRecord,
  ImportRecord,
  IndexChanges,
  IndexStats,
  MiddlewareRecord,
  RouteRecord,
  RouterCallRecord,
  SideEffectRecord,
  SymbolKind,
  SymbolRecord,
  WalkthroughRecord,
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

  /**
   * Files (other than `paths`) whose Express registrations pass a function declared in `paths`, e.g.
   * `router.use(requireAuth)`. Those keys hold line numbers, so the registrations must be re-extracted;
   * a barrel re-export means the router file isn't a direct importer.
   */
  async getRouterCallFiles(paths: string[]): Promise<string[]> {
    const { rows } = await this.pool.query<{ path: string }>(
      `SELECT DISTINCT f.path
       FROM router_calls r JOIN files f ON f.id = r.file_id
       CROSS JOIN LATERAL jsonb_array_elements(r.handlers) AS h
       WHERE (h->'key'->>'file' = ANY($1::text[]) OR h->'factory'->>'file' = ANY($1::text[]))
         AND NOT f.path = ANY($1::text[])
       ORDER BY f.path`,
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
      const refreshPaths = callRefreshes.map((r) => r.path);
      await client.query(
        'DELETE FROM router_calls WHERE file_id IN (SELECT id FROM files WHERE path = ANY($1::text[]))',
        [refreshPaths],
      );
      await client.query(
        `DELETE FROM side_effects WHERE symbol_id IN (
           SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ANY($1::text[]))`,
        [refreshPaths],
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

      const factSources = [...files, ...callRefreshes];
      const routerCalls = factSources.flatMap((f) =>
        (f.routerCalls ?? []).map((r) => ({
          file: f.path, receiverKey: r.receiver?.key ?? null, receiverKind: r.receiver?.kind ?? null, receiverText: r.receiverText,
          callKind: r.callKind, method: r.method, path: r.path, pathText: r.pathText, line: r.line, endLine: r.endLine,
          orderIdx: r.orderIdx, handlers: r.handlers,
        })),
      );
      await client.query(
        `INSERT INTO router_calls (file_id, receiver_key, receiver_kind, receiver_text, call_kind, method, path, path_text,
                                   line, end_line, order_idx, handlers)
         SELECT f.id, x."receiverKey", x."receiverKind", x."receiverText", x."callKind", x.method, x.path, x."pathText",
                x.line, x."endLine", x."orderIdx", x.handlers
         FROM jsonb_to_recordset($1::jsonb) AS x(file text, "receiverKey" text, "receiverKind" text, "receiverText" text,
                                                 "callKind" text, method text, path text, "pathText" text, line int,
                                                 "endLine" int, "orderIdx" int, handlers jsonb)
         JOIN files f ON f.path = x.file`,
        [JSON.stringify(routerCalls)],
      );

      const sideEffects = factSources.flatMap((f) => (f.sideEffects ?? []).map((e) => ({ ...e, file: f.path })));
      const insertedEffects = await client.query(
        `INSERT INTO side_effects (symbol_id, kind, detail, line)
         SELECT s.id, x.kind, x.detail, x.line
         FROM jsonb_to_recordset($1::jsonb) AS x(file text, symbol jsonb, kind text, detail text, line int)
         JOIN files f ON f.path = x.file
         JOIN symbols s ON s.file_id = f.id AND s.name = x.symbol->>'name' AND s.start_line = (x.symbol->>'startLine')::int`,
        [JSON.stringify(sideEffects)],
      );
      assertCount('side_effects', insertedEffects.rowCount, sideEffects.length);

      await this.rebuildRoutes(client);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** The indexed file at `path`, or null if it is not in the index. */
  async getFile(path: string): Promise<FileRecord | null> {
    const { rows } = await this.pool.query<FileRecord>('SELECT path, hash FROM files WHERE path = $1', [path]);
    return rows[0] ?? null;
  }

  /** Every symbol in `file`, outermost first. */
  async getSymbolsInFile(file: string): Promise<SymbolRecord[]> {
    const { rows } = await this.pool.query<SymbolRow>(
      `${SELECT_SYMBOL} WHERE f.path = $1 ORDER BY s.start_line, s.end_line DESC`,
      [file],
    );
    return rows.map(toSymbolRecord);
  }

  /** Import declarations of `file`, in source order. */
  async getImportsForFile(file: string): Promise<ImportRecord[]> {
    const { rows } = await this.pool.query<ImportRecord>(
      `SELECT i.imported_path AS "importedPath", i.resolved_path AS "resolvedPath",
              i.imported_names AS "importedNames", i.package_name AS "packageName",
              i.package_version AS "packageVersion"
       FROM imports i JOIN files f ON f.id = i.file_id
       WHERE f.path = $1 ORDER BY i.id`,
      [file],
    );
    return rows;
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

  /**
   * Files importing `file`, one row each, with every name they import from it (several import
   * statements, e.g. `import type` plus a value import, are merged). Feeds a file walkthrough's "who uses it".
   */
  async getImportersOf(file: string): Promise<ImporterRecord[]> {
    const { rows } = await this.pool.query<ImporterRecord>(
      `SELECT f.path AS file,
              COALESCE(array_agg(DISTINCT n.name ORDER BY n.name) FILTER (WHERE n.name IS NOT NULL), '{}') AS "importedNames"
       FROM imports i
       JOIN files f ON f.id = i.file_id
       LEFT JOIN LATERAL unnest(i.imported_names) AS n(name) ON true
       WHERE i.resolved_path = $1
       GROUP BY f.path
       ORDER BY f.path`,
      [file],
    );
    return rows;
  }

  /** Resolved calls whose caller and callee both live in `file`, in one query for the whole file. */
  async getCallEdgesInFile(file: string): Promise<CallEdge[]> {
    const { rows } = await this.pool.query<{ caller_symbol_id: string; callee_symbol_id: string }>(
      `SELECT DISTINCT c.caller_symbol_id, c.callee_symbol_id
       FROM calls c
       JOIN symbols caller ON caller.id = c.caller_symbol_id
       JOIN symbols callee ON callee.id = c.callee_symbol_id
       JOIN files f ON f.id = caller.file_id
       WHERE f.path = $1 AND callee.file_id = caller.file_id
       ORDER BY 1, 2`,
      [file],
    );
    return rows.map((r) => ({ callerId: Number(r.caller_symbol_id), calleeId: Number(r.callee_symbol_id) }));
  }

  /** Re-stitches routes and middleware from every stored registration (routes/stitch.ts). */
  private async rebuildRoutes(client: pg.PoolClient): Promise<void> {
    const { rows } = await client.query<RouterCallRow>(
      `SELECT f.path AS file, r.receiver_key, r.receiver_kind, r.receiver_text, r.call_kind, r.method, r.path, r.path_text,
              r.line, r.end_line, r.order_idx, r.handlers
       FROM router_calls r JOIN files f ON f.id = r.file_id
       ORDER BY f.path, r.order_idx`,
    );
    const { routes, warnings } = stitchRoutes(rows.map(toRouterCallRecord));

    await client.query('DELETE FROM routes'); // cascades to middleware
    await client.query('DELETE FROM route_warnings');
    await client.query('INSERT INTO route_warnings (message) SELECT unnest($1::text[])', [warnings]);
    if (routes.length === 0) return;

    const ids = (
      await client.query<{ id: string }>(`SELECT nextval(pg_get_serial_sequence('routes', 'id')) AS id FROM generate_series(1, $1)`, [routes.length])
    ).rows.map((r) => r.id);

    await client.query(
      `INSERT INTO routes (id, method, full_path, handler_symbol_id, handler_label, mount_chain, file, line, end_line, warnings)
       SELECT x.id, x.method, x."fullPath", s.id, x."handlerLabel", x."mountChain", x.file, x.line, x."endLine", x.warnings
       FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, method text, "fullPath" text, "handlerLabel" text, "mountChain" jsonb,
                                               file text, line int, "endLine" int, warnings jsonb, key jsonb)
       LEFT JOIN files kf ON kf.path = x.key->>'file'
       LEFT JOIN symbols s ON s.file_id = kf.id AND s.name = x.key->>'name' AND s.start_line = (x.key->>'startLine')::int`,
      [
        JSON.stringify(
          routes.map((r, i) => ({
            id: ids[i], method: r.method, fullPath: r.fullPath, handlerLabel: handlerLabel(r.handler), mountChain: r.mountChain,
            file: r.file, line: r.line, endLine: r.endLine, warnings: r.warnings, key: handlerKey(r.handler),
          })),
        ),
      ],
    );

    const middleware = routes.flatMap((r, i) =>
      r.middleware.map((m, orderIdx) => ({
        routeId: ids[i], orderIdx, phase: m.phase, label: handlerLabel(m.handler), file: m.file, line: m.line, endLine: m.endLine,
        note: handlerNote(m.handler, m.file, m.line), key: handlerKey(m.handler),
      })),
    );
    await client.query(
      `INSERT INTO middleware (route_id, order_idx, symbol_id, phase, label, file, line, end_line, unresolved_note)
       SELECT x."routeId", x."orderIdx", s.id, x.phase, x.label, x.file, x.line, x."endLine", x.note
       FROM jsonb_to_recordset($1::jsonb) AS x("routeId" bigint, "orderIdx" int, phase text, label text, file text, line int,
                                               "endLine" int, note text, key jsonb)
       LEFT JOIN files kf ON kf.path = x.key->>'file'
       LEFT JOIN symbols s ON s.file_id = kf.id AND s.name = x.key->>'name' AND s.start_line = (x.key->>'startLine')::int`,
      [JSON.stringify(middleware)],
    );
  }

  /** Every stitched route, with its handler symbol when it is a repo function. */
  async listRoutes(): Promise<RouteRecord[]> {
    const { rows } = await this.pool.query<RouteRow>(
      `SELECT r.id, r.method, r.full_path, r.handler_label, r.mount_chain, r.file, r.line, r.end_line, r.warnings, ${PREFIXED_SYMBOL}
       FROM routes r LEFT JOIN symbols s ON s.id = r.handler_symbol_id LEFT JOIN files sf ON sf.id = s.file_id
       ORDER BY r.full_path, r.method, r.id`,
    );
    return rows.map((r) => ({
      id: Number(r.id), method: r.method, fullPath: r.full_path, handler: optionalSymbol(r), handlerLabel: r.handler_label,
      file: r.file, line: r.line, endLine: r.end_line, mountChain: r.mount_chain, warnings: r.warnings,
    }));
  }

  /** A route's middleware in execution order; error handlers (phase "error") come last. */
  async getMiddlewareChain(routeId: number): Promise<MiddlewareRecord[]> {
    const { rows } = await this.pool.query<MiddlewareRow>(
      `SELECT m.order_idx, m.phase, m.label, m.file, m.line, m.end_line, m.unresolved_note, ${PREFIXED_SYMBOL}
       FROM middleware m LEFT JOIN symbols s ON s.id = m.symbol_id LEFT JOIN files sf ON sf.id = s.file_id
       WHERE m.route_id = $1 ORDER BY m.order_idx`,
      [routeId],
    );
    return rows.map((r) => ({
      orderIdx: r.order_idx, phase: r.phase, label: r.label, symbol: optionalSymbol(r), file: r.file, line: r.line,
      endLine: r.end_line, unresolvedNote: r.unresolved_note,
    }));
  }

  /** Side effects of the given symbols, by symbol then line. One query. */
  async getSideEffects(symbolIds: number[]): Promise<SideEffectRecord[]> {
    const { rows } = await this.pool.query<{ symbol_id: string; kind: SideEffectRecord['kind']; detail: string; line: number }>(
      'SELECT symbol_id, kind, detail, line FROM side_effects WHERE symbol_id = ANY($1::bigint[]) ORDER BY symbol_id, line, id',
      [symbolIds],
    );
    return rows.map((r) => ({ symbolId: Number(r.symbol_id), kind: r.kind, detail: r.detail, line: r.line }));
  }

  /** Registrations the last index pass couldn't place in the route tree. */
  async getRouteWarnings(): Promise<string[]> {
    const { rows } = await this.pool.query<{ message: string }>('SELECT message FROM route_warnings ORDER BY message');
    return rows.map((r) => r.message);
  }

  /**
   * Inserts or replaces the saved walkthrough of one scope. Saving identical content (e.g. a cache hit)
   * is a no-op, so created_at stays the time the content last changed.
   */
  async saveWalkthrough(w: { scopeKind: string; scopeRef: string; contentHash: string; content: unknown }): Promise<void> {
    await this.pool.query(
      `INSERT INTO walkthroughs (scope_kind, scope_ref, content_hash, content)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (scope_kind, scope_ref)
       DO UPDATE SET content_hash = EXCLUDED.content_hash, content = EXCLUDED.content, created_at = now()
       WHERE walkthroughs.content IS DISTINCT FROM EXCLUDED.content`,
      [w.scopeKind, w.scopeRef, w.contentHash, JSON.stringify(w.content)],
    );
  }

  async getWalkthrough(scopeKind: string, scopeRef: string): Promise<WalkthroughRecord | null> {
    const { rows } = await this.pool.query<WalkthroughRecord>(
      `${SELECT_WALKTHROUGH} WHERE scope_kind = $1 AND scope_ref = $2`,
      [scopeKind, scopeRef],
    );
    return rows[0] ?? null;
  }

  async listWalkthroughs(): Promise<WalkthroughRecord[]> {
    const { rows } = await this.pool.query<WalkthroughRecord>(`${SELECT_WALKTHROUGH} ORDER BY scope_kind, scope_ref`);
    return rows;
  }
}

const SELECT_SYMBOL = `SELECT s.id, f.path AS file, s.name, s.kind, s.start_line, s.end_line, s.exported, s.signature
  FROM symbols s JOIN files f ON f.id = s.file_id`;

const SELECT_WALKTHROUGH = `SELECT scope_kind AS "scopeKind", scope_ref AS "scopeRef", content_hash AS "contentHash",
  content, created_at AS "createdAt" FROM walkthroughs`;

const PREFIXED_SYMBOL = `s.id AS s_id, sf.path AS s_file, s.name AS s_name, s.kind AS s_kind, s.start_line AS s_start_line,
  s.end_line AS s_end_line, s.exported AS s_exported, s.signature AS s_signature`;

interface PrefixedSymbolRow {
  s_id: string | null;
  s_file: string | null;
  s_name: string | null;
  s_kind: SymbolKind | null;
  s_start_line: number | null;
  s_end_line: number | null;
  s_exported: boolean | null;
  s_signature: string | null;
}

interface RouteRow extends PrefixedSymbolRow {
  id: string;
  method: string;
  full_path: string;
  handler_label: string;
  mount_chain: RouteRecord['mountChain'];
  file: string;
  line: number;
  end_line: number;
  warnings: string[];
}

interface MiddlewareRow extends PrefixedSymbolRow {
  order_idx: number;
  phase: MiddlewareRecord['phase'];
  label: string;
  file: string;
  line: number;
  end_line: number;
  unresolved_note: string | null;
}

interface RouterCallRow {
  file: string;
  receiver_key: string | null;
  receiver_kind: 'app' | 'router' | null;
  receiver_text: string;
  call_kind: 'use' | 'route';
  method: string | null;
  path: string | null;
  path_text: string | null;
  line: number;
  end_line: number;
  order_idx: number;
  handlers: RouterCallRecord['handlers'];
}

function optionalSymbol(r: PrefixedSymbolRow): SymbolRecord | null {
  if (r.s_id === null) return null;
  return toSymbolRecord({
    id: r.s_id, file: r.s_file!, name: r.s_name!, kind: r.s_kind!, start_line: r.s_start_line!, end_line: r.s_end_line!,
    exported: r.s_exported!, signature: r.s_signature,
  });
}

function toRouterCallRecord(r: RouterCallRow): RouterCallRecord {
  return {
    file: r.file,
    receiver: r.receiver_key && r.receiver_kind ? { key: r.receiver_key, kind: r.receiver_kind } : null,
    receiverText: r.receiver_text, callKind: r.call_kind, method: r.method, path: r.path, pathText: r.path_text,
    line: r.line, endLine: r.end_line, orderIdx: r.order_idx, handlers: r.handlers,
  };
}

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
