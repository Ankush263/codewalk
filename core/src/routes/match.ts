import { TargetError } from '../context/target.js';

// `walk endpoint "<METHOD> <path>"`: parses the target and matches it to stitched route patterns, so
// a concrete URL (`/patients/42`) finds its route (`/patients/:id`). Phase 5 reuses this for API calls.

export interface EndpointTarget {
  method: string;
  path: string;
}

export interface RouteLike {
  method: string;
  fullPath: string;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ALL']);
const TARGET = /^\s*([A-Za-z]+)\s+(\S+)\s*$/;

export function parseEndpointTarget(arg: string): EndpointTarget {
  const m = TARGET.exec(arg);
  if (!m) throw new TargetError(`Expected "<METHOD> <path>", e.g. "POST /api/patients/enroll", got "${arg}"`);
  const method = m[1].toUpperCase();
  if (!METHODS.has(method)) throw new TargetError(`Unknown HTTP method "${m[1]}"; use one of ${[...METHODS].join(', ')}`);
  const raw = m[2].replace(/[?#].*$/, '');
  if (!raw.startsWith('/')) throw new TargetError(`The path must start with "/", got "${m[2]}"`);
  return { method, path: normalizePath(raw) };
}

export function normalizePath(path: string): string {
  const collapsed = `/${path}`.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

/** `/patients/:id` matches `/patients/42`; `*` matches one segment; everything else must be equal. */
export function pathMatches(pattern: string, path: string): boolean {
  const p = segments(pattern);
  const s = segments(path);
  return p.length === s.length && p.every((seg, i) => segmentMatches(seg, s[i]));
}

/** Routes for the target: exact paths win over patterns, and an exact method wins over ALL. */
export function matchRoutes<R extends RouteLike>(routes: R[], target: EndpointTarget): R[] {
  const byMethod = (rs: R[]) => {
    const exact = rs.filter((r) => r.method === target.method);
    return exact.length > 0 ? exact : rs.filter((r) => r.method === 'ALL');
  };
  const exactPath = byMethod(routes.filter((r) => r.fullPath === target.path));
  if (exactPath.length > 0) return exactPath;
  return byMethod(routes.filter((r) => pathMatches(r.fullPath, target.path)));
}

/** Up to `n` routes that look most like the target: segments matching by position, then method. */
export function closestRoutes<R extends RouteLike>(routes: R[], target: EndpointTarget, n = 5): R[] {
  const want = segments(target.path);
  const score = (r: R) => {
    const have = segments(r.fullPath);
    const shared = want.filter((seg, i) => have[i] !== undefined && segmentMatches(have[i], seg)).length;
    return shared + (r.method === target.method || r.method === 'ALL' ? 0.5 : 0);
  };
  return [...routes]
    .map((r) => ({ r, s: score(r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.r.fullPath.localeCompare(b.r.fullPath))
    .slice(0, n)
    .map((x) => x.r);
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function segmentMatches(pattern: string, value: string): boolean {
  return pattern === '*' || (pattern.startsWith(':') && value.length > 0) || pattern === value;
}
