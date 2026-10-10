import type { ScopeKind } from '@codewalk/core';

export type Route = { page: 'list' } | { page: 'walkthrough'; kind: ScopeKind; ref: string };

const KINDS: readonly string[] = ['fn', 'file', 'endpoint', 'component', 'trace'];

export function parseHash(hash: string): Route {
  const m = /^#\/w\/([a-z]+)\/(.+)$/.exec(hash);
  if (m && KINDS.includes(m[1])) {
    try {
      return { page: 'walkthrough', kind: m[1] as ScopeKind, ref: decodeURIComponent(m[2]) };
    } catch {
      // A malformed link falls back to the list.
    }
  }
  return { page: 'list' };
}

export function hrefFor(kind: ScopeKind, ref: string): string {
  return `#/w/${kind}/${encodeURIComponent(ref)}`;
}
