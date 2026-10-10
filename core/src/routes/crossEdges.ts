import type { PinnedEdge } from '../config.js';
import type { CrossEdgeFact, EdgeMatch } from '../store/types.js';

// Links frontend API calls to backend routes (CLAUDE.md §6.5): `/patients/${id}` (stored as
// `/patients/:id`) matches the route `/patients/:id`. Only a confident, unique match is followed
// automatically; anything looser waits for the user to pin it. Pure: the store persists the result.

export const RESOLVE_THRESHOLD = 0.9;
const CONFIDENCE: Record<Exclude<EdgeMatch, 'pinned'>, number> = { exact: 1, param: 0.9, suffix: 0.6, wildcard: 0.6, method: 0.5 };
const ANY_METHOD_PENALTY = 0.05;

export interface CallForMatching {
  id: number;
  method: string;
  urlPattern: string;
  caller: { file: string; name: string };
}

/** Every route the call could reach, best first. */
export function candidateRoutes<R extends { method: string; fullPath: string }>(
  call: { method: string; urlPattern: string },
  routes: R[],
): { route: R; match: EdgeMatch; confidence: number }[] {
  const want = segments(call.urlPattern);
  const unknownMethod = call.method === 'UNKNOWN';
  const out: { route: R; match: EdgeMatch; confidence: number }[] = [];
  for (const route of routes) {
    if (!unknownMethod && route.method !== call.method && route.method !== 'ALL') continue;
    const have = segments(route.fullPath);
    let match: EdgeMatch | null = null;
    if (have.length === want.length) match = compare(have, want);
    else if (want.length > 0 && have.length > want.length) {
      // A suffix only counts when it shares a literal segment: `/patients` must not reach `/api/users/:id`.
      const tail = compare(have.slice(have.length - want.length), want);
      if (tail === 'exact' || tail === 'param') match = 'suffix';
    }
    if (!match) continue;
    let confidence = CONFIDENCE[match as Exclude<EdgeMatch, 'pinned'>];
    if (unknownMethod) {
      match = 'method';
      confidence = Math.min(confidence, CONFIDENCE.method);
    } else if (route.method === 'ALL') {
      confidence = Math.round((confidence - ANY_METHOD_PENALTY) * 100) / 100;
    }
    out.push({ route, match, confidence });
  }
  return out.sort((a, b) => b.confidence - a.confidence || a.route.fullPath.localeCompare(b.route.fullPath) || a.route.method.localeCompare(b.route.method));
}

/** Every candidate edge for every call; a pin, or a confident unique best candidate, is resolved. */
export function computeCrossEdges(
  calls: CallForMatching[],
  routes: { id: number; method: string; fullPath: string }[],
  pins: PinnedEdge[],
): { edges: CrossEdgeFact[]; warnings: string[] } {
  const edges: CrossEdgeFact[] = [];
  for (const call of calls) {
    const candidates = candidateRoutes(call, routes);
    const pin = pins.find((p) => p.caller === `${call.caller.file}#${call.caller.name}` && p.method === call.method && p.url === call.urlPattern);
    if (pin) {
      const route = routes.find((r) => `${r.method} ${r.fullPath}` === pin.route);
      if (route) {
        edges.push({ apiCallId: call.id, routeId: route.id, match: 'pinned', confidence: 1, pinned: true, resolved: true });
        for (const c of candidates) {
          if (c.route.id !== route.id) edges.push({ apiCallId: call.id, routeId: c.route.id, match: c.match, confidence: c.confidence, pinned: false, resolved: false });
        }
        continue;
      }
    }
    const [top, next] = candidates;
    const resolved = top !== undefined && top.confidence >= RESOLVE_THRESHOLD && (next === undefined || next.confidence < top.confidence);
    for (const c of candidates) {
      edges.push({ apiCallId: call.id, routeId: c.route.id, match: c.match, confidence: c.confidence, pinned: false, resolved: resolved && c === top });
    }
  }
  return { edges, warnings: pinWarnings(calls, routes, pins) };
}

/** Pins that no longer match an indexed API call or route. Cheap: reported on every pass, even without a rebuild. */
export function pinWarnings(
  calls: CallForMatching[],
  routes: { method: string; fullPath: string }[],
  pins: PinnedEdge[],
): string[] {
  return pins.flatMap((pin) => {
    const call = calls.some((c) => pin.caller === `${c.caller.file}#${c.caller.name}` && pin.method === c.method && pin.url === c.urlPattern);
    if (!call) return [`Pinned edge ${describePin(pin)}: no such API call in the index; remove it from pinnedEdges.`];
    const route = routes.some((r) => `${r.method} ${r.fullPath}` === pin.route);
    return route ? [] : [`Pinned edge ${describePin(pin)}: no such route; the pin is ignored.`];
  });
}

export function describePin(pin: PinnedEdge): string {
  return `${pin.caller} ${pin.method} ${pin.url} → ${pin.route}`;
}

/**
 * "exact" when every segment is equal or param-for-param; "param" when a route param stands for a call
 * literal but at least one literal is shared; "wildcard" when the call's literals meet only route params
 * or `*` (an SPA catch-all, `/:code`), which must never be followed without a pin.
 */
function compare(route: string[], call: string[]): 'exact' | 'param' | 'wildcard' | null {
  let sharedLiterals = 0;
  let paramForLiteral = 0;
  for (let i = 0; i < route.length; i++) {
    const routeParam = route[i].startsWith(':') || route[i] === '*';
    const callParam = call[i].startsWith(':');
    if (routeParam && callParam) continue;
    if (routeParam) {
      paramForLiteral++;
      continue;
    }
    if (callParam || route[i] !== call[i]) return null;
    sharedLiterals++;
  }
  if (route.includes('*') || (paramForLiteral > 0 && sharedLiterals === 0)) return 'wildcard';
  return paramForLiteral > 0 ? 'param' : 'exact';
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}
