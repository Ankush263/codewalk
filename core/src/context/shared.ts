import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/index.js';
import type { CodeBlock, PackageFact } from './fn.js';

// Helpers shared by the context builders (fn, endpoint): reading source once, the token budget,
// and the packages imported by the files a context cites.

/** Room kept for the system prompt, instructions and schema. */
export const PROMPT_RESERVE_TOKENS = 3000;
export const NON_CODE_KINDS = new Set(['type', 'class']);

/** Rough token estimate; good enough to keep the prompt under the configured budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Package imports of `files`, first occurrence of each package wins. */
export async function collectPackages(store: Store, files: string[]): Promise<PackageFact[]> {
  const packages = new Map<string, PackageFact>();
  for (const file of new Set(files)) {
    for (const i of await store.getImportsForFile(file)) {
      if (i.packageName === null || packages.has(i.packageName)) continue;
      packages.set(i.packageName, { name: i.packageName, version: i.packageVersion, importedPath: i.importedPath, importedNames: i.importedNames });
    }
  }
  return [...packages.values()];
}

export class SourceCache {
  private readonly files = new Map<string, { text: string; lines: string[] }>();

  constructor(private readonly repoRoot: string) {}

  block(file: string, start: number, end: number): CodeBlock {
    const lines = this.read(file).lines;
    const last = Math.min(end, lines.length);
    return { file, start, end: last, lines: lines.slice(start - 1, last) };
  }

  lineCount(file: string): number {
    return this.read(file).lines.length;
  }

  hash(file: string): string {
    return createHash('sha256').update(this.read(file).text).digest('hex');
  }

  private read(file: string) {
    let entry = this.files.get(file);
    if (!entry) {
      const text = readFileSync(join(this.repoRoot, file), 'utf8');
      const lines = text.split(/\r?\n/);
      if (lines.length > 1 && lines.at(-1) === '') lines.pop();
      entry = { text, lines };
      this.files.set(file, entry);
    }
    return entry;
  }
}

export class Budget {
  constructor(private remaining: number) {}

  take(block: CodeBlock): boolean {
    const cost = estimateTokens(block.lines.join('\n')) + 10;
    if (cost > this.remaining) return false;
    this.remaining -= cost;
    return true;
  }
}
