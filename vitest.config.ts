import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against core's source, not its last build.
    alias: { '@codewalk/core': fileURLToPath(new URL('./core/src/index.ts', import.meta.url)) },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'fixture/**'],
  },
});
