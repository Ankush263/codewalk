import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { basename, extname, join, matchesGlob } from 'node:path';
import type { WalkConfig } from '../config.js';

export interface DiscoveredFile {
  /** Repo-relative, forward slashes. */
  path: string;
  absPath: string;
  hash: string;
  language: 'typescript' | 'javascript';
}

const SOURCE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** Source files under the configured roots, minus ignore globs and declaration files, with content hashes. */
export function discoverFiles(repoRoot: string, config: WalkConfig): DiscoveredFile[] {
  const roots = [...new Set(Object.values(config.roots).filter((r): r is string => r !== undefined))];
  const found = new Map<string, DiscoveredFile>();

  for (const root of roots) {
    const rootAbs = join(repoRoot, root);
    const matches = globSync(SOURCE_GLOB, {
      cwd: rootAbs,
      exclude: (p) => basename(p) === 'node_modules',
    });
    for (const match of matches) {
      const path = toPosix(join(root, match)).replace(/^\.\//, '');
      if (found.has(path) || /\.d\.[mc]?ts$/.test(path)) continue;
      if (config.ignore.some((pattern) => matchesGlob(path, pattern))) continue;

      const absPath = join(repoRoot, path);
      const content = readFileSync(absPath);
      found.set(path, {
        path,
        absPath,
        hash: createHash('sha256').update(content).digest('hex'),
        language: TS_EXTENSIONS.has(extname(path)) ? 'typescript' : 'javascript',
      });
    }
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function toPosix(path: string): string {
  return path.split('\\').join('/');
}
