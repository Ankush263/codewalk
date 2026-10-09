import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PackageFact } from '../context/fn.js';
import { DocsResolver } from './resolve.js';

const repo = mkdtempSync(join(tmpdir(), 'cw-docs-'));
const install = (name: string, manifest: object) => {
  mkdirSync(join(repo, 'node_modules', name), { recursive: true });
  writeFileSync(join(repo, 'node_modules', name, 'package.json'), JSON.stringify(manifest));
};
install('with-homepage', { name: 'with-homepage', homepage: 'https://example.dev/docs' });
install('with-repo', { name: 'with-repo', repository: { type: 'git', url: 'git+https://github.com/acme/with-repo.git' } });
install('@scope/shorthand', { name: '@scope/shorthand', repository: 'github:acme/shorthand' });

afterAll(() => rmSync(repo, { recursive: true, force: true }));

const pkg = (name: string, version: string | null = null, importedPath = name): PackageFact => ({ name, version, importedPath, importedNames: [] });
const resolver = new DocsResolver(repo, join(repo, 'api'));
const url = (name: string, symbol: string, version?: string | null, importedPath?: string) =>
  resolver.resolve({ package: name, symbol }, pkg(name, version ?? null, importedPath));

describe('DocsResolver', () => {
  it('uses the curated map for common packages, by major version', () => {
    expect(url('express', 'res.json', '^4.19.2')).toMatchObject({ url: 'https://expressjs.com/en/4x/api.html#res.json', source: 'curated' });
    expect(url('express', 'Router', '5.1.0').url).toBe('https://expressjs.com/en/5x/api.html#express.router');
    expect(url('react', 'useState', '^18.3.1').url).toBe('https://react.dev/reference/react/useState');
    expect(url('pg', 'pool.connect').url).toBe('https://node-postgres.com/apis/pool');
    expect(url('ioredis', 'redis.set').url).toBe('https://redis.io/docs/latest/commands/set/');
    expect(url('zod', 'z.object', '^3.23.8').url).toBe('https://v3.zod.dev/');
    expect(url('zod', 'z.object', '4.1.0').url).toBe('https://zod.dev/api');
    expect(url('node', 'EventEmitter', null, 'node:events').url).toBe('https://nodejs.org/api/events.html');
  });

  it("falls back to the installed package's homepage or repository", () => {
    expect(url('with-homepage', 'x')).toMatchObject({ url: 'https://example.dev/docs', source: 'package.json' });
    expect(url('with-repo', 'x').url).toBe('https://github.com/acme/with-repo');
    expect(url('@scope/shorthand', 'x').url).toBe('https://github.com/acme/shorthand');
  });

  it('links unknown packages to npm, pinned to an exact version', () => {
    expect(url('left-pad', 'leftPad', '1.3.0')).toMatchObject({ url: 'https://www.npmjs.com/package/left-pad/v/1.3.0', source: 'npm' });
    expect(url('left-pad', 'leftPad', '^1.3.0').url).toBe('https://www.npmjs.com/package/left-pad');
  });
});
