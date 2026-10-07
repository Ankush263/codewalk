import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, ConfigError, createDefaultConfig, findRepoRoot, loadConfig, schemaNameFor } from './config.js';

const FIXTURE = new URL('../../fixture', import.meta.url).pathname;

describe('config', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-config-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeConfig = (value: unknown) => {
    mkdirSync(join(dir, '.walkthrough'), { recursive: true });
    writeFileSync(join(dir, CONFIG_FILE), typeof value === 'string' ? value : JSON.stringify(value));
  };

  it('loads the fixture config', () => {
    const config = loadConfig(FIXTURE);
    expect(config.roots).toEqual({ backend: 'api', frontend: 'web' });
    expect(config.database.schema).toBe('cw_fixture');
    expect(config.apiClientWrappers.map((w) => w.name)).toEqual(['api.get', 'api.post']);
  });

  it('finds the repo root from a nested directory', () => {
    expect(findRepoRoot(join(FIXTURE, 'api', 'services'))).toBe(FIXTURE);
    expect(findRepoRoot(dir)).toBeNull();
  });

  it('fills defaults for optional fields', () => {
    mkdirSync(join(dir, 'api'));
    writeConfig({
      roots: { backend: 'api' },
      database: { url: 'postgres://x', schema: 'cw_x' },
      llm: { provider: 'anthropic', model: 'm', maxContextTokens: 1000 },
    });
    const config = loadConfig(dir);
    expect(config.apiClientWrappers).toEqual([]);
    expect(config.ignore).toContain('**/node_modules/**');
  });

  it('reports schema errors with the field path', () => {
    writeConfig({ roots: {}, database: { url: 'postgres://x', schema: 'Bad-Name' }, llm: { provider: 'anthropic', model: 'm', maxContextTokens: 1 } });
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/roots[\s\S]*database\.schema/);
  });

  it('reports invalid JSON and missing root directories', () => {
    writeConfig('{ not json');
    expect(() => loadConfig(dir)).toThrow(/Could not read/);

    writeConfig({ roots: { backend: 'nope' }, database: { url: 'postgres://x', schema: 'cw_x' }, llm: { provider: 'anthropic', model: 'm', maxContextTokens: 1 } });
    expect(() => loadConfig(dir)).toThrow(/roots\.backend is "nope"/);
  });

  it('derives a safe schema name from the directory', () => {
    expect(schemaNameFor('/src/My-Repo.v2')).toBe('cw_my_repo_v2');
    expect(schemaNameFor('/src/---')).toBe('cw_repo');
  });

  it('guesses roots from common layouts', () => {
    mkdirSync(join(dir, 'apps', 'api'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    expect(createDefaultConfig(dir).roots).toEqual({ backend: 'apps/api', frontend: 'apps/web' });
    expect(createDefaultConfig(FIXTURE).roots).toEqual({ backend: 'api', frontend: 'web' });
  });
});
