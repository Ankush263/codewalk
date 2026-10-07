import { builtinModules } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const BUILTINS = new Set(builtinModules);

/** "express" -> "express", "@tanstack/react-query/x" -> "@tanstack/react-query", "node:events" -> "node". */
export function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:') || BUILTINS.has(specifier.split('/')[0])) return 'node';
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Version of `pkg` as seen from `fromDir`: the installed node_modules/<pkg>/package.json version
 * if present, else the range declared in the nearest package.json that lists it. Lockfile
 * parsing is not implemented yet. Walks up no further than `repoRoot`.
 */
export class PackageVersions {
  private readonly cache = new Map<string, string | null>();
  private readonly manifests = new Map<string, Record<string, unknown> | null>();

  constructor(private readonly repoRoot: string) {}

  versionOf(pkg: string, fromDir: string): string | null {
    if (pkg === 'node') return null;
    const key = `${fromDir}\0${pkg}`;
    if (!this.cache.has(key)) this.cache.set(key, this.lookup(pkg, fromDir));
    return this.cache.get(key)!;
  }

  private lookup(pkg: string, fromDir: string): string | null {
    const root = resolve(this.repoRoot);
    let declared: string | null = null;
    for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
      const installed = this.readJson(join(dir, 'node_modules', pkg, 'package.json'));
      if (typeof installed?.version === 'string') return installed.version;

      const manifest = this.readJson(join(dir, 'package.json'));
      if (declared === null && manifest) {
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
          const range = (manifest[field] as Record<string, unknown> | undefined)?.[pkg];
          if (typeof range === 'string') {
            declared = range;
            break;
          }
        }
      }
      if (dir === root || dirname(dir) === dir) return declared;
    }
  }

  private readJson(path: string): Record<string, unknown> | null {
    if (!this.manifests.has(path)) {
      let value: Record<string, unknown> | null = null;
      if (existsSync(path)) {
        try {
          value = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          value = null;
        }
      }
      this.manifests.set(path, value);
    }
    return this.manifests.get(path)!;
  }
}
