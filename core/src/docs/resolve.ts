import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PackageFact } from '../context/fn.js';
import type { DocRef } from '../llm/schema.js';

// Docs links (CLAUDE.md §8.4). The LLM only names {package, symbol}; URLs come from a curated map
// for common packages, then the installed package's homepage/repository, then npm.

export interface DocLink {
  package: string;
  symbol: string;
  version: string | null;
  url: string;
  source: 'curated' | 'package.json' | 'npm';
}

type Curated = (symbol: string, major: number | null, pkg: PackageFact) => string;

const CURATED: Record<string, Curated> = {
  express: (symbol, major) => {
    const base = `https://expressjs.com/en/${major !== null && major >= 5 ? '5x' : '4x'}/api.html`;
    const anchor = symbol === 'Router' ? 'express.router' : /^(express|app|router|req|res)\.\w+$/i.test(symbol) ? symbol.toLowerCase() : null;
    return anchor ? `${base}#${anchor}` : base;
  },
  react: (symbol) => {
    const name = lastSegment(symbol);
    return /^(use[A-Z]\w*|memo|forwardRef|createContext|lazy|startTransition|Suspense|Fragment|StrictMode)$/.test(name)
      ? `https://react.dev/reference/react/${name}`
      : 'https://react.dev/reference/react';
  },
  pg: (symbol) => {
    if (/pool/i.test(symbol)) return 'https://node-postgres.com/apis/pool';
    if (/client/i.test(symbol)) return 'https://node-postgres.com/apis/client';
    if (/result|rows/i.test(symbol)) return 'https://node-postgres.com/apis/result';
    return 'https://node-postgres.com';
  },
  ioredis: (symbol) => {
    const command = lastSegment(symbol);
    return /^[a-z]+$/.test(command) ? `https://redis.io/docs/latest/commands/${command}/` : 'https://github.com/redis/ioredis#readme';
  },
  zod: (_symbol, major) => (major !== null && major < 4 ? 'https://v3.zod.dev/' : 'https://zod.dev/api'),
  node: (_symbol, _major, pkg) => {
    const module = pkg.importedPath.replace(/^node:/, '').split('/')[0];
    return `https://nodejs.org/api/${module}.html`;
  },
};

export class DocsResolver {
  private readonly manifests = new Map<string, Record<string, unknown> | null>();

  /** `fromDir` is where package lookup starts (the target file's directory); it stops at `repoRoot`. */
  constructor(
    private readonly repoRoot: string,
    private readonly fromDir: string = repoRoot,
  ) {}

  resolve(ref: DocRef, pkg: PackageFact): DocLink {
    const version = pkg.version;
    const link = (url: string, source: DocLink['source']): DocLink => ({ package: ref.package, symbol: ref.symbol, version, url, source });

    const curated = CURATED[ref.package];
    if (curated) return link(curated(ref.symbol, majorOf(version), pkg), 'curated');

    const manifest = this.installedManifest(ref.package);
    const fromManifest = manifest && (stringField(manifest.homepage) ?? repositoryUrl(manifest.repository));
    if (fromManifest) return link(fromManifest, 'package.json');

    const exact = version && /^\d+\.\d+\.\d+/.test(version) ? `/v/${version}` : '';
    return link(`https://www.npmjs.com/package/${ref.package}${exact}`, 'npm');
  }

  private installedManifest(pkg: string): Record<string, unknown> | null {
    const root = resolve(this.repoRoot);
    for (let dir = resolve(this.fromDir); ; dir = dirname(dir)) {
      const manifest = this.readJson(join(dir, 'node_modules', pkg, 'package.json'));
      if (manifest) return manifest;
      if (dir === root || dirname(dir) === dir) return null;
    }
  }

  private readJson(path: string): Record<string, unknown> | null {
    if (!this.manifests.has(path)) {
      let value: Record<string, unknown> | null = null;
      try {
        if (existsSync(path)) value = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        value = null;
      }
      this.manifests.set(path, value);
    }
    return this.manifests.get(path)!;
  }
}

/** "^4.19.2" -> 4, "5.0.0-beta" -> 5, null -> null. */
function majorOf(version: string | null): number | null {
  const match = version?.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function lastSegment(symbol: string): string {
  return symbol.replace(/\(.*$/, '').split('.').at(-1) ?? symbol;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//.test(value) ? value : null;
}

/** "git+https://github.com/a/b.git", {url: "..."} or "github:a/b" -> "https://github.com/a/b". */
function repositoryUrl(repository: unknown): string | null {
  const raw = typeof repository === 'string' ? repository : (repository as { url?: unknown } | undefined)?.url;
  if (typeof raw !== 'string') return null;
  const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw);
  if (shorthand) return `https://github.com/${shorthand[1]}`;
  const url = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
  return /^https?:\/\//.test(url) ? url : null;
}
