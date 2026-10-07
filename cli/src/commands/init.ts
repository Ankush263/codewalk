import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_FILE, ConfigError, createDefaultConfig, indexRepo, loadConfig, type WalkConfig } from '@codewalk/core';
import { connectStore, printIndexResult, type IO } from './shared.js';

/** `walk init`: write or validate the config, connect to Postgres, migrate, build the index. Returns an exit code. */
export async function runInit(repoRoot: string, io: IO): Promise<number> {
  const configPath = join(repoRoot, CONFIG_FILE);

  let config: WalkConfig;
  try {
    if (existsSync(configPath)) {
      config = loadConfig(repoRoot);
      io.log(`✔ Using existing ${CONFIG_FILE}`);
    } else {
      config = createDefaultConfig(repoRoot);
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      io.log(`✔ Created ${CONFIG_FILE}`);
      io.log(`  roots: backend=${config.roots.backend ?? '-'}  frontend=${config.roots.frontend ?? '-'}  (edit if wrong)`);
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      io.error(`✖ ${err.message}`);
      return 1;
    }
    throw err;
  }

  const store = await connectStore(config, io);
  if (!store) return 1;

  try {
    await store.migrate();
    io.log(`✔ Database schema "${config.database.schema}" is ready`);
    printIndexResult(await indexRepo(repoRoot, config, store), io);
  } finally {
    await store.close();
  }
  return 0;
}
