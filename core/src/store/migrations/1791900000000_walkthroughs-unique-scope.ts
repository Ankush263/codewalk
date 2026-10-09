import type { MigrationBuilder } from 'node-pg-migrate';

// One saved walkthrough per scope: `walk fn` and `walk file` upsert on (scope_kind, scope_ref).

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Rows saved before this index existed may repeat a scope: keep the newest of each.
  pgm.sql(`DELETE FROM walkthroughs a USING walkthroughs b
           WHERE a.scope_kind = b.scope_kind AND a.scope_ref = b.scope_ref AND a.id < b.id`);
  pgm.dropIndex('walkthroughs', ['scope_kind', 'scope_ref']);
  pgm.createIndex('walkthroughs', ['scope_kind', 'scope_ref'], { unique: true });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('walkthroughs', ['scope_kind', 'scope_ref'], { unique: true });
  pgm.createIndex('walkthroughs', ['scope_kind', 'scope_ref']);
}
