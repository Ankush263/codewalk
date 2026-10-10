import type { MigrationBuilder } from 'node-pg-migrate';

// Phase 5 (walk trace): how each API call -> route edge was found, and which one a trace follows.
// confidence becomes double precision so 0.9 reads back as 0.9. Rows are rebuilt on every index pass.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('cross_edges', 'confidence', { type: 'double precision' });
  pgm.addColumns('cross_edges', {
    match: { type: 'text', notNull: true, default: 'exact', check: "match IN ('exact', 'param', 'suffix', 'wildcard', 'method', 'pinned')" },
    resolved: { type: 'boolean', notNull: true, default: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('cross_edges', ['match', 'resolved']);
  pgm.alterColumn('cross_edges', 'confidence', { type: 'real' });
}
