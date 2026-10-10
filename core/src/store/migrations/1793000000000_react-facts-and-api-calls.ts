import type { MigrationBuilder } from 'node-pg-migrate';

// Phase 4 (walk component): React facts per component/hook, the source text of API call URLs, and the
// extraction settings an index was built with (a config change must re-extract unchanged files).

export async function up(pgm: MigrationBuilder): Promise<void> {
  const list = () => ({ type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) });
  pgm.addColumns('components', { props: list(), effects: list(), render: list(), handlers: list() });
  pgm.addColumns('api_calls', { url_text: { type: 'text', notNull: true, default: '' } });
  pgm.createTable('index_settings', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'text', notNull: true },
  });
  // Files indexed before this migration have no React facts or API calls.
  pgm.sql("UPDATE files SET hash = ''");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('index_settings');
  pgm.dropColumns('api_calls', ['url_text']);
  pgm.dropColumns('components', ['props', 'effects', 'render', 'handlers']);
}
