import type { MigrationBuilder } from 'node-pg-migrate';

// Phase 6 (walk serve): questions asked on a walkthrough's steps and their verified answers. step_hash is
// the step's hash when asked, so an answer to code that has since changed is shown as stale.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('walkthrough_questions', {
    id: 'id',
    scope_kind: { type: 'text', notNull: true },
    scope_ref: { type: 'text', notNull: true },
    step_id: { type: 'text', notNull: true },
    question: { type: 'text', notNull: true },
    answer: { type: 'jsonb', notNull: true },
    step_hash: { type: 'text', notNull: true },
    model: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('walkthrough_questions', ['scope_kind', 'scope_ref']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('walkthrough_questions');
}
