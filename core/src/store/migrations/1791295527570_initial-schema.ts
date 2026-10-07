import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

// Runs once per indexed repo, with search_path set to that repo's schema (cw_<slug>),
// so unqualified table names below land in the repo schema. pgvector is installed
// database-wide in `public`, so its type and operator class must be schema-qualified.

export const shorthands: ColumnDefinitions = {
  id: { type: 'bigserial', primaryKey: true },
};

const SYMBOL_KINDS = ['function', 'method', 'class', 'component', 'hook', 'route_handler', 'type'];
const SIDE_EFFECT_KINDS = ['db_read', 'db_write', 'redis', 'http_out', 'queue', 'throws'];

const inList = (column: string, values: string[]) =>
  `${column} IN (${values.map((v) => `'${v}'`).join(', ')})`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createExtension('vector', { ifNotExists: true, schema: 'public' });

  pgm.createTable('files', {
    id: 'id',
    path: { type: 'text', notNull: true, unique: true }, // relative to the repo root
    hash: { type: 'text', notNull: true },
    language: { type: 'text', notNull: true },
  });

  pgm.createTable('symbols', {
    id: 'id',
    file_id: { type: 'bigint', notNull: true, references: 'files', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true, check: inList('kind', SYMBOL_KINDS) },
    start_line: { type: 'integer', notNull: true },
    end_line: { type: 'integer', notNull: true },
    exported: { type: 'boolean', notNull: true, default: false },
    signature: { type: 'text' },
    embedding: { type: 'public.vector(768)' },
  });
  pgm.addConstraint('symbols', 'symbols_line_range', { check: 'start_line >= 1 AND end_line >= start_line' });
  pgm.createIndex('symbols', 'file_id');
  pgm.createIndex('symbols', 'name');
  // node-pg-migrate's createIndex doesn't type the hnsw method, so this one is raw SQL.
  pgm.sql('CREATE INDEX symbols_embedding_hnsw ON symbols USING hnsw (embedding public.vector_cosine_ops)');

  // callee_symbol_id is NULL when the callee is not a symbol in this repo: an external
  // package call (resolved = true) or a dynamic call we could not resolve (resolved = false).
  // callee_text keeps the call expression (e.g. "handlers[name]") for "unresolved: likely X".
  // Edges cascade away when either end is deleted; the indexer re-indexes importers of
  // changed files so cross-file edges are rebuilt.
  pgm.createTable('calls', {
    id: 'id',
    caller_symbol_id: { type: 'bigint', notNull: true, references: 'symbols', onDelete: 'CASCADE' },
    callee_symbol_id: { type: 'bigint', references: 'symbols', onDelete: 'CASCADE' },
    callee_text: { type: 'text', notNull: true },
    call_line: { type: 'integer', notNull: true },
    resolved: { type: 'boolean', notNull: true },
  });
  pgm.createIndex('calls', 'caller_symbol_id');
  pgm.createIndex('calls', 'callee_symbol_id');

  // resolved_path is the repo-relative file an import points to (NULL for packages);
  // it lets incremental indexing find the importers of a changed file.
  pgm.createTable('imports', {
    id: 'id',
    file_id: { type: 'bigint', notNull: true, references: 'files', onDelete: 'CASCADE' },
    imported_path: { type: 'text', notNull: true },
    resolved_path: { type: 'text' },
    imported_names: { type: 'text[]', notNull: true, default: pgm.func(`'{}'`) },
    package_name: { type: 'text' },
    package_version: { type: 'text' },
  });
  pgm.createIndex('imports', 'file_id');
  pgm.createIndex('imports', 'resolved_path');

  pgm.createTable('routes', {
    id: 'id',
    method: { type: 'text', notNull: true },
    full_path: { type: 'text', notNull: true },
    handler_symbol_id: { type: 'bigint', references: 'symbols', onDelete: 'CASCADE' },
    mount_chain: { type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) },
  });
  pgm.createIndex('routes', ['method', 'full_path']);
  pgm.createIndex('routes', 'handler_symbol_id');

  pgm.createTable(
    'middleware',
    {
      route_id: { type: 'bigint', notNull: true, references: 'routes', onDelete: 'CASCADE' },
      order_idx: { type: 'integer', notNull: true },
      symbol_id: { type: 'bigint', references: 'symbols', onDelete: 'CASCADE' },
    },
    { constraints: { primaryKey: ['route_id', 'order_idx'] } },
  );
  pgm.createIndex('middleware', 'symbol_id');

  pgm.createTable('side_effects', {
    id: 'id',
    symbol_id: { type: 'bigint', notNull: true, references: 'symbols', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true, check: inList('kind', SIDE_EFFECT_KINDS) },
    detail: { type: 'text', notNull: true },
    line: { type: 'integer', notNull: true },
  });
  pgm.createIndex('side_effects', 'symbol_id');

  pgm.createTable('components', {
    symbol_id: { type: 'bigint', primaryKey: true, references: 'symbols', onDelete: 'CASCADE' },
    props_type: { type: 'text' },
    state_vars: { type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) },
    hooks_used: { type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) },
    context_used: { type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) },
  });

  pgm.createTable('api_calls', {
    id: 'id',
    symbol_id: { type: 'bigint', notNull: true, references: 'symbols', onDelete: 'CASCADE' },
    method: { type: 'text', notNull: true },
    url_pattern: { type: 'text', notNull: true },
    line: { type: 'integer', notNull: true },
  });
  pgm.createIndex('api_calls', 'symbol_id');

  pgm.createTable(
    'cross_edges',
    {
      api_call_id: { type: 'bigint', notNull: true, references: 'api_calls', onDelete: 'CASCADE' },
      route_id: { type: 'bigint', notNull: true, references: 'routes', onDelete: 'CASCADE' },
      confidence: { type: 'real', notNull: true },
      pinned: { type: 'boolean', notNull: true, default: false },
    },
    { constraints: { primaryKey: ['api_call_id', 'route_id'] } },
  );
  pgm.createIndex('cross_edges', 'route_id');

  pgm.createTable('walkthroughs', {
    id: 'id',
    scope_kind: { type: 'text', notNull: true },
    scope_ref: { type: 'text', notNull: true },
    content_hash: { type: 'text', notNull: true },
    content: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('walkthroughs', ['scope_kind', 'scope_ref']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // The vector extension is shared by every repo schema in the database, so it stays.
  pgm.dropTable('walkthroughs');
  pgm.dropTable('cross_edges');
  pgm.dropTable('api_calls');
  pgm.dropTable('components');
  pgm.dropTable('side_effects');
  pgm.dropTable('middleware');
  pgm.dropTable('routes');
  pgm.dropTable('imports');
  pgm.dropTable('calls');
  pgm.dropTable('symbols');
  pgm.dropTable('files');
}
