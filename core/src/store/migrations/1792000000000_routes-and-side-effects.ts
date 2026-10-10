import type { MigrationBuilder } from 'node-pg-migrate';

// Phase 3 (walk endpoint): per-file Express registrations, and the columns routes/middleware need
// once they are stitched from them. Rows in routes/middleware are rebuilt on every index pass.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('router_calls', {
    id: { type: 'bigserial', primaryKey: true },
    file_id: { type: 'bigint', notNull: true, references: 'files', onDelete: 'CASCADE' },
    receiver_key: { type: 'text' }, // "<file>#<variable>"; NULL for Express values we can't place
    receiver_kind: { type: 'text', check: "receiver_kind IN ('app', 'router')" },
    receiver_text: { type: 'text', notNull: true },
    call_kind: { type: 'text', notNull: true, check: "call_kind IN ('use', 'route')" },
    method: { type: 'text' },
    path: { type: 'text' },
    path_text: { type: 'text' },
    line: { type: 'integer', notNull: true },
    end_line: { type: 'integer', notNull: true },
    order_idx: { type: 'integer', notNull: true },
    handlers: { type: 'jsonb', notNull: true },
  });
  pgm.createIndex('router_calls', 'file_id');
  pgm.createIndex('router_calls', 'receiver_key');

  pgm.addColumns('routes', {
    handler_label: { type: 'text', notNull: true, default: '' },
    file: { type: 'text', notNull: true, default: '' },
    line: { type: 'integer', notNull: true, default: 0 },
    end_line: { type: 'integer', notNull: true, default: 0 },
    warnings: { type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) },
  });

  pgm.addColumns('middleware', {
    phase: { type: 'text', notNull: true, default: 'route', check: "phase IN ('app', 'router', 'route', 'error')" },
    label: { type: 'text', notNull: true, default: '' },
    file: { type: 'text', notNull: true, default: '' },
    line: { type: 'integer', notNull: true, default: 0 },
    end_line: { type: 'integer', notNull: true, default: 0 },
    unresolved_note: { type: 'text' },
  });

  pgm.createTable('route_warnings', { message: { type: 'text', notNull: true } });

  // Files indexed before this migration have no router or side-effect facts. Clearing their hashes
  // makes the next index pass re-extract every file instead of reporting "no routes".
  pgm.sql("UPDATE files SET hash = ''");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('route_warnings');
  pgm.dropColumns('middleware', ['phase', 'label', 'file', 'line', 'end_line', 'unresolved_note']);
  pgm.dropColumns('routes', ['handler_label', 'file', 'line', 'end_line', 'warnings']);
  pgm.dropTable('router_calls');
}
