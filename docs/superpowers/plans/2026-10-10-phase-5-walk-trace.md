# Phase 5: `walk trace` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `walk trace "POST /api/patients/enroll"` explains one request from the user's click through the component, hook, API call, middleware, service and database, back to the UI. It has one combined Mermaid diagram and one verified LLM narrative.

**Architecture:** On every index pass, a pure matcher (`core/src/routes/crossEdges.ts`) links each stored API call to candidate routes and resolves confident or pinned ones. The store replaces `cross_edges` in one transaction. `buildTraceContext` matches the route, takes its resolved calls, walks up the call graph to the component that triggers them, then reuses `buildComponentContext` and `buildEndpointContext` (half the budget each). Loose matches raise `PinNeededError`, which the CLI resolves by prompting (TTY) or `--pin`; the choice is written to `pinnedEdges`. The prompt is the component and endpoint prompt sections joined under a link section. The section reuses the Phase 4 multi-block machinery.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), ts-morph, `pg` + `node-pg-migrate`, zod, commander, Ink, vitest, `node:readline/promises`.

**Spec:** `docs/superpowers/specs/2026-10-10-phase-5-walk-trace-design.md` (implements `CLAUDE.md` §6.5, §8.1, §8.1a, §9, §10, §12 Phase 5, §13).

## Global Constraints

- Node `>=24`, pnpm workspaces, vitest, tsup. TypeScript 7; `pnpm typecheck` must pass at the end.
- Nothing outside `core/src/store` writes SQL (CLAUDE.md §8.1a). Matching in `routes/crossEdges.ts` is pure TypeScript.
- Database tests use the real compose Postgres, each in its own `cw_test_<random>` schema that is dropped afterwards (CLAUDE.md §14). Never mock the DB.
- LLM calls are mocked in tests with a handcrafted recorded response (CLAUDE.md §14).
- Docs URLs are never produced by the LLM (CLAUDE.md §8.4).
- Never guess silently: loose matches need a pin; stale pins warn (CLAUDE.md §8.1, §6.5).
- The only file the tool writes outside `.walkthrough/walkthroughs/` is `.walkthrough/config.json` (pins), and only after the user chose a pin.
- A non-interactive run never blocks on a prompt.
- `SAVED_VERSION` stays `2`; new saved fields are optional. The fixture is unchanged (edits happen in temp copies).
- **Do not commit** (CLAUDE.md §15). Each task ends with a checkpoint.
- Run tests from the repo root with Postgres up (`pnpm db:up`). Baseline before starting: `pnpm test` → 37 files, 251 tests passing.

## Review Focus

1. **A frontend URL without the backend's `/api` prefix** (axios `baseURL`) must neither be traced to a wrong route nor be silently dropped. It is a `suffix` candidate that asks for a pin. Tested in Tasks 1, 3 and 7.
2. **A pin that no longer matches** (call renamed, route removed) must warn on every index pass, not crash or silently trace. Tested in Tasks 1 and 2.
3. **Several components calling the same endpoint** must require an explicit `--from`, not pick one arbitrarily. Tested in Task 3.
4. **Non-interactive runs (CI, piped output)** must exit with the exact `--pin` command, never wait for input. Tested in Task 7.
5. **Editing a backend function deep in the trace** (`insertConsent`) must mark the saved trace stale; moving lines must not. Tested in Tasks 6 and 7.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/config.ts` (modify) | `pinnedEdgeSchema`, `PinnedEdge`, `addPinnedEdge` |
| `core/src/routes/crossEdges.ts` (create) | Pure: candidate routes per call, resolution, pins → `CrossEdgeFact[]` + warnings |
| `core/src/store/migrations/1794000000000_cross-edge-resolution.ts` (create) | `confidence` → double precision; `match`, `resolved` |
| `core/src/store/types.ts`, `store.ts` (modify) | `EdgeMatch`, `CrossEdgeFact`, `ApiCallWithCaller`, `CrossEdgeRecord`; `listApiCalls`, `replaceCrossEdges`, `getCrossEdges`, `getHandlerOwners` |
| `core/src/indexer/index.ts` (modify) | Rebuild cross edges every pass; `IndexResult.warnings` |
| `core/src/context/endpoint.ts`, `component.ts` (modify) | Export `findRoute`, `componentStructure`, `ComponentStructure` |
| `core/src/context/trace.ts` (create) | `buildTraceContext`, `PinNeededError`, `describeCandidate`, `describeLink`, `pinFor`, `currentTraceHash` |
| `core/src/render/mermaid.ts` (modify) | `traceDiagram` |
| `core/src/llm/prompt.ts`, `endpointPrompt.ts`, `componentPrompt.ts` (modify) | `citeFiles`; `…PromptSections` split |
| `core/src/llm/tracePrompt.ts` (create), `__fixtures__/enrollTrace.response.json` (create) | Trace prompt; recorded response |
| `core/src/verify/verify.ts` (modify) | `traceVerifyFacts` |
| `core/src/walkthrough/trace.ts` (create) | `explainTrace`, `traceBlocks`, `generateTraceSection`, `traceOverviewOf` |
| `core/src/walkthrough/saved.ts`, `staleness.ts`, `render/markdown.ts` (modify) | `trace` scope, `TraceOverview`, `traceNotes`, staleness, Markdown |
| `cli/src/commands/trace.ts` (create), `index.ts`, `list.ts`, `shared.ts`, `ui/format.ts`, `ui/output.ts` (modify) | `walk trace` with the pin flow |

---

### Task 1: Pins in config and the pure matcher

**Files:**
- Modify: `core/src/config.ts`; Test: `core/src/config.test.ts` (append)
- Modify: `core/src/store/types.ts` (types only)
- Create: `core/src/routes/crossEdges.ts`; Test: `core/src/routes/crossEdges.test.ts`

**Interfaces:**
- Produces (`config.ts`): `pinnedEdgeSchema`; `type PinnedEdge = { caller: string; method: string; url: string; route: string }`; `addPinnedEdge(repoRoot: string, pin: PinnedEdge): void`; `WalkConfig.pinnedEdges: PinnedEdge[]`.
- Produces (`store/types.ts`): `type EdgeMatch = 'exact' | 'param' | 'suffix' | 'method' | 'pinned'`; `interface CrossEdgeFact { apiCallId: number; routeId: number; match: EdgeMatch; confidence: number; pinned: boolean; resolved: boolean }`.
- Produces (`crossEdges.ts`):
  - `candidateRoutes<R extends { method: string; fullPath: string }>(call: { method: string; urlPattern: string }, routes: R[]): { route: R; match: EdgeMatch; confidence: number }[]`, sorted best first.
  - `computeCrossEdges(calls: CallForMatching[], routes: { id: number; method: string; fullPath: string }[], pins: PinnedEdge[]): { edges: CrossEdgeFact[]; warnings: string[] }`, where `CallForMatching = { id: number; method: string; urlPattern: string; caller: { file: string; name: string } }`.
  - `describePin(pin: PinnedEdge): string`; `RESOLVE_THRESHOLD = 0.9`.

- [ ] **Step 1: Write the failing config test**

Append inside the `describe('config', …)` block of `core/src/config.test.ts` (and add `addPinnedEdge` and `readFileSync` to the imports):

```ts
  it('validates pinned edges', () => {
    const base = loadConfig(FIXTURE);
    writeConfig({ ...base, roots: { frontend: '.' }, pinnedEdges: [{ caller: 'no-hash', method: 'POST', url: '/x', route: 'POST /x' }] });
    expect(() => loadConfig(dir)).toThrow(/pinnedEdges/);
  });

  it('adds a pin, replacing one for the same call and keeping every other field', () => {
    const base = loadConfig(FIXTURE);
    writeConfig({ ...base, roots: { frontend: '.' } });
    const pin = { caller: 'web/a.ts#load', method: 'GET', url: '/items', route: 'GET /api/items' };
    addPinnedEdge(dir, pin);
    addPinnedEdge(dir, { ...pin, route: 'GET /api/v2/items' });
    addPinnedEdge(dir, { ...pin, url: '/other', route: 'GET /api/other' });
    const config = loadConfig(dir);
    expect(config.pinnedEdges).toEqual([
      { ...pin, route: 'GET /api/v2/items' },
      { ...pin, url: '/other', route: 'GET /api/other' },
    ]);
    expect(config.apiClientWrappers).toEqual(base.apiClientWrappers);
    expect(readFileSync(join(dir, CONFIG_FILE), 'utf8')).toMatch(/\n {2}"pinnedEdges": \[\n/);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run core/src/config.test.ts`
Expected: FAIL: `addPinnedEdge` is not exported, and the invalid pin is accepted.

- [ ] **Step 3: Implement the config part**

In `core/src/config.ts`:

1. Change the fs import to `import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';`.
2. Before `export const configSchema`, add:

```ts
/** A user-confirmed link from a frontend API call to a route (CLAUDE.md §6.5), keyed so it survives line moves. */
export const pinnedEdgeSchema = z.object({
  /** The function making the call: "<file>#<symbol>". */
  caller: z.string().regex(/^[^#]+#.+$/, 'use "<file>#<function>", e.g. web/hooks/useEnrollMutation.ts#useEnrollMutation.mutate'),
  method: z.string().min(1),
  /** The call's URL pattern, e.g. "/patients/enroll". */
  url: z.string().min(1),
  /** The route: "<METHOD> <full path>". */
  route: z.string().regex(/^[A-Z]+ \/\S*$/, 'use "<METHOD> <path>", e.g. "POST /api/patients/enroll"'),
});
```

3. Replace the two lines `// Entry shape is defined in Phase 5 …` and `pinnedEdges: z.array(z.unknown()).default([]),` with `pinnedEdges: z.array(pinnedEdgeSchema).default([]),`.
4. After `export type ApiClientWrapper = …`, add:

```ts
export type PinnedEdge = z.infer<typeof pinnedEdgeSchema>;

/**
 * Records a pin in .walkthrough/config.json, replacing any pin for the same call. The rest of the file
 * is kept as written (only re-indented), so a user's other settings are never lost.
 */
export function addPinnedEdge(repoRoot: string, pin: PinnedEdge): void {
  const path = join(repoRoot, CONFIG_FILE);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { pinnedEdges?: PinnedEdge[] };
  const sameCall = (p: PinnedEdge) => p.caller === pin.caller && p.method === pin.method && p.url === pin.url;
  raw.pinnedEdges = [...(raw.pinnedEdges ?? []).filter((p) => !sameCall(p)), pin];
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}
```

Run: `pnpm vitest run core/src/config.test.ts`
Expected: PASS.

- [ ] **Step 4: Add the edge types**

In `core/src/store/types.ts`, after `ApiCallRecord`, add:

```ts
/** How a frontend API call was linked to a route (CLAUDE.md §6.5). */
export type EdgeMatch = 'exact' | 'param' | 'suffix' | 'method' | 'pinned';

/** One candidate link from an API call to a route; `resolved` marks the one a trace follows. */
export interface CrossEdgeFact {
  apiCallId: number;
  routeId: number;
  match: EdgeMatch;
  confidence: number;
  pinned: boolean;
  resolved: boolean;
}
```

- [ ] **Step 5: Write the failing matcher test**

Create `core/src/routes/crossEdges.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { candidateRoutes, computeCrossEdges } from './crossEdges.js';

const routes = [
  { id: 1, method: 'POST', fullPath: '/api/patients/enroll' },
  { id: 2, method: 'GET', fullPath: '/api/patients/:id' },
  { id: 3, method: 'GET', fullPath: '/api/patients/me' },
  { id: 4, method: 'ALL', fullPath: '/api/health' },
  { id: 5, method: 'GET', fullPath: '/api/health' },
];
const best = (method: string, urlPattern: string) =>
  candidateRoutes({ method, urlPattern }, routes).map((c) => `${c.route.id} ${c.match} ${c.confidence}`);
const call = (id: number, method: string, urlPattern: string) => ({ id, method, urlPattern, caller: { file: 'web/a.ts', name: `f${id}` } });

describe('candidateRoutes', () => {
  it('matches literal and param segments exactly', () => {
    expect(best('POST', '/api/patients/enroll')).toEqual(['1 exact 1']);
    expect(best('GET', '/api/patients/:id')).toEqual(['2 exact 1']);
  });

  it('prefers a literal route over a param route for a literal URL', () => {
    expect(best('GET', '/api/patients/me')).toEqual(['3 exact 1', '2 param 0.9']);
  });

  it('prefers a specific method over ALL', () => {
    expect(best('GET', '/api/health')).toEqual(['5 exact 1', '4 exact 0.95']);
  });

  it('offers a route whose path ends with the URL as a loose suffix match', () => {
    expect(best('POST', '/patients/enroll')).toEqual(['1 suffix 0.6']);
  });

  it('caps a call with an unknown method', () => {
    expect(best('UNKNOWN', '/api/patients/enroll')).toEqual(['1 method 0.5']);
  });

  it('never matches a call param against a route literal, or a different method', () => {
    expect(best('DELETE', '/api/patients/:id')).toEqual([]);
    expect(best('POST', '/api/patients/:id')).toEqual([]);
  });
});

describe('computeCrossEdges', () => {
  it('resolves a call only to a confident, unique best route', () => {
    const { edges, warnings } = computeCrossEdges([call(10, 'GET', '/api/patients/me'), call(11, 'POST', '/patients/enroll')], routes, []);
    expect(edges).toEqual([
      { apiCallId: 10, routeId: 3, match: 'exact', confidence: 1, pinned: false, resolved: true },
      { apiCallId: 10, routeId: 2, match: 'param', confidence: 0.9, pinned: false, resolved: false },
      { apiCallId: 11, routeId: 1, match: 'suffix', confidence: 0.6, pinned: false, resolved: false },
    ]);
    expect(warnings).toEqual([]);
  });

  it('leaves equally good candidates unresolved', () => {
    const twice = [...routes, { id: 6, method: 'POST', fullPath: '/api/patients/enroll' }];
    const { edges } = computeCrossEdges([call(10, 'POST', '/api/patients/enroll')], twice, []);
    expect(edges.map((e) => `${e.routeId} ${e.resolved}`)).toEqual(['1 false', '6 false']);
  });

  it('a pin overrides matching; stale pins warn and are ignored', () => {
    const pins = [
      { caller: 'web/a.ts#f11', method: 'POST', url: '/patients/enroll', route: 'POST /api/patients/enroll' },
      { caller: 'web/a.ts#f12', method: 'GET', url: '/x', route: 'GET /api/gone' },
      { caller: 'web/gone.ts#g', method: 'GET', url: '/y', route: 'GET /api/health' },
    ];
    const { edges, warnings } = computeCrossEdges([call(11, 'POST', '/patients/enroll'), call(12, 'GET', '/x')], routes, pins);
    expect(edges).toEqual([{ apiCallId: 11, routeId: 1, match: 'pinned', confidence: 1, pinned: true, resolved: true }]);
    expect(warnings).toEqual([
      'Pinned edge web/a.ts#f12 GET /x → GET /api/gone: no such route; the pin is ignored.',
      'Pinned edge web/gone.ts#g GET /y → GET /api/health: no such API call in the index; remove it from pinnedEdges.',
    ]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run core/src/routes/crossEdges.test.ts`
Expected: FAIL: cannot resolve `./crossEdges.js`.

- [ ] **Step 7: Implement the matcher**

Create `core/src/routes/crossEdges.ts`:

```ts
import type { PinnedEdge } from '../config.js';
import type { CrossEdgeFact, EdgeMatch } from '../store/types.js';

// Links frontend API calls to backend routes (CLAUDE.md §6.5): `/patients/${id}` (stored as
// `/patients/:id`) matches the route `/patients/:id`. Only a confident, unique match is followed
// automatically; anything looser waits for the user to pin it. Pure: the store persists the result.

export const RESOLVE_THRESHOLD = 0.9;
const CONFIDENCE: Record<Exclude<EdgeMatch, 'pinned'>, number> = { exact: 1, param: 0.9, suffix: 0.6, method: 0.5 };
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
    else if (want.length > 0 && have.length > want.length && compare(have.slice(have.length - want.length), want)) match = 'suffix';
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
  const warnings: string[] = [];
  const used = new Set<PinnedEdge>();
  for (const call of calls) {
    const candidates = candidateRoutes(call, routes);
    const pin = pins.find((p) => p.caller === `${call.caller.file}#${call.caller.name}` && p.method === call.method && p.url === call.urlPattern);
    if (pin) {
      used.add(pin);
      const route = routes.find((r) => `${r.method} ${r.fullPath}` === pin.route);
      if (route) {
        edges.push({ apiCallId: call.id, routeId: route.id, match: 'pinned', confidence: 1, pinned: true, resolved: true });
        for (const c of candidates) {
          if (c.route.id !== route.id) edges.push({ apiCallId: call.id, routeId: c.route.id, match: c.match, confidence: c.confidence, pinned: false, resolved: false });
        }
        continue;
      }
      warnings.push(`Pinned edge ${describePin(pin)}: no such route; the pin is ignored.`);
    }
    const [top, next] = candidates;
    const resolved = top !== undefined && top.confidence >= RESOLVE_THRESHOLD && (next === undefined || next.confidence < top.confidence);
    for (const c of candidates) {
      edges.push({ apiCallId: call.id, routeId: c.route.id, match: c.match, confidence: c.confidence, pinned: false, resolved: resolved && c === top });
    }
  }
  for (const pin of pins) {
    if (!used.has(pin)) warnings.push(`Pinned edge ${describePin(pin)}: no such API call in the index; remove it from pinnedEdges.`);
  }
  return { edges, warnings };
}

export function describePin(pin: PinnedEdge): string {
  return `${pin.caller} ${pin.method} ${pin.url} → ${pin.route}`;
}

/** "exact" when every segment is equal or param-for-param; "param" when a route param stands for a literal. */
function compare(route: string[], call: string[]): 'exact' | 'param' | null {
  let result: 'exact' | 'param' = 'exact';
  for (let i = 0; i < route.length; i++) {
    const routeParam = route[i].startsWith(':') || route[i] === '*';
    const callParam = call[i].startsWith(':');
    if (routeParam && callParam) continue;
    if (routeParam) {
      result = 'param';
      continue;
    }
    if (callParam || route[i] !== call[i]) return null;
  }
  return result;
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vitest run core/src/routes core/src/config.test.ts`
Expected: PASS.

- [ ] **Step 9: Checkpoint**

Do not commit. `pnpm --filter @codewalk/core exec tsc --noEmit` is clean.

---

### Task 2: Cross-edge storage, rebuilt on every index pass

**Files:**
- Create: `core/src/store/migrations/1794000000000_cross-edge-resolution.ts`
- Modify: `core/src/store/types.ts`, `core/src/store/store.ts`, `core/src/indexer/index.ts`, `cli/src/commands/shared.ts`
- Test: `core/src/store/migrations.test.ts` (append), `core/src/indexer/indexer.test.ts` (append)

**Interfaces:**
- Consumes: `computeCrossEdges`, `CrossEdgeFact`, `EdgeMatch` (Task 1).
- Produces (types):
  ```ts
  export interface ApiCallWithCaller extends ApiCallRecord { caller: SymbolRecord }
  export interface CrossEdgeRecord { apiCall: ApiCallWithCaller; routeId: number; match: EdgeMatch; confidence: number; pinned: boolean; resolved: boolean; callResolved: boolean }
  ```
  (`callResolved`: some edge of this API call is resolved, to this route or another.)
- Produces (`Store`): `listApiCalls(): Promise<ApiCallWithCaller[]>`; `replaceCrossEdges(edges: CrossEdgeFact[]): Promise<void>`; `getCrossEdges(routeId: number): Promise<CrossEdgeRecord[]>`, best first; `getHandlerOwners(key: SymbolKey): Promise<SymbolRecord[]>`, the components whose handler bindings target `key`.
- Produces: `IndexResult.warnings: string[]` (stale pins); `printIndexResult` prints them.

- [ ] **Step 1: Write the failing migration test**

Append to `core/src/store/migrations.test.ts`:

```ts
describe('cross-edge-resolution migration', () => {
  const schema = `cw_test_mig5_${randomBytes(4).toString('hex')}`;
  let store: Store;
  let pool: pg.Pool;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema });
    await store.migrate();
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema},public` });
  });

  afterAll(async () => {
    await pool?.end();
    await store?.dropSchema();
    await store?.close();
  });

  it('stores confidence as double precision and adds match and resolved', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'cross_edges' AND column_name IN ('confidence', 'match', 'resolved') ORDER BY 1`,
      [schema],
    );
    expect(rows.map((r) => `${r.column_name} ${r.data_type}`)).toEqual(['confidence double precision', 'match text', 'resolved boolean']);
  });
});
```

Run: `pnpm vitest run core/src/store/migrations.test.ts -t "cross-edge"`
Expected: FAIL: `confidence real`, with no `match`/`resolved` columns.

- [ ] **Step 2: Write the migration**

Create `core/src/store/migrations/1794000000000_cross-edge-resolution.ts`:

```ts
import type { MigrationBuilder } from 'node-pg-migrate';

// Phase 5 (walk trace): how each API call -> route edge was found, and which one a trace follows.
// confidence becomes double precision so 0.9 reads back as 0.9. Rows are rebuilt on every index pass.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('cross_edges', 'confidence', { type: 'double precision' });
  pgm.addColumns('cross_edges', {
    match: { type: 'text', notNull: true, default: 'exact', check: "match IN ('exact', 'param', 'suffix', 'method', 'pinned')" },
    resolved: { type: 'boolean', notNull: true, default: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('cross_edges', ['match', 'resolved']);
  pgm.alterColumn('cross_edges', 'confidence', { type: 'real' });
}
```

Run: `pnpm vitest run core/src/store/migrations.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing indexer test**

Append to `core/src/indexer/indexer.test.ts`:

```ts
describe('indexRepo: frontend calls linked to routes', () => {
  let store: Store;
  const config = loadConfig(FIXTURE);
  const routeId = async (method: string, path: string) => (await store.listRoutes()).find((r) => r.method === method && r.fullPath === path)!.id;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_idx5_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, config, store);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('lists every API call with its calling function', async () => {
    expect((await store.listApiCalls()).map((a) => `${a.method} ${a.urlPattern} ${a.caller.file}#${a.caller.name}:${a.line}`)).toEqual([
      'POST /api/patients/enroll web/hooks/useEnrollMutation.ts#useEnrollMutation.mutate:19',
      'GET /api/patients/:id web/hooks/usePatient.ts#usePatient:13',
    ]);
  });

  it('resolves each fixture call to its route with an exact match', async () => {
    const [enroll] = await store.getCrossEdges(await routeId('POST', '/api/patients/enroll'));
    expect(enroll).toMatchObject({ match: 'exact', confidence: 1, pinned: false, resolved: true, callResolved: true, apiCall: { method: 'POST', caller: { name: 'useEnrollMutation.mutate' } } });
    expect((await store.getCrossEdges(await routeId('GET', '/api/patients/:id'))).map((e) => `${e.apiCall.caller.name} ${e.match} ${e.resolved}`)).toEqual(['usePatient exact true']);
  });

  it('finds the components whose handlers name a function', async () => {
    const owners = await store.getHandlerOwners({ file: 'web/components/EnrollForm.tsx', name: 'EnrollForm.handleSubmit', startLine: 32 });
    expect(owners.map((s) => s.name)).toEqual(['EnrollForm']);
  });

  it('applies pins from config on the next pass, warning about stale ones', async () => {
    const pinned = {
      ...config,
      pinnedEdges: [
        { caller: 'web/hooks/usePatient.ts#usePatient', method: 'GET', url: '/api/patients/:id', route: 'GET /api/patients/:id' },
        { caller: 'web/gone.ts#gone', method: 'GET', url: '/x', route: 'GET /x' },
      ],
    };
    const result = await indexRepo(FIXTURE, pinned, store);
    expect(result.changed).toEqual([]);
    expect(result.warnings).toEqual(['Pinned edge web/gone.ts#gone GET /x → GET /x: no such API call in the index; remove it from pinnedEdges.']);
    const [edge] = await store.getCrossEdges(await routeId('GET', '/api/patients/:id'));
    expect(edge).toMatchObject({ match: 'pinned', pinned: true, resolved: true });
    expect((await indexRepo(FIXTURE, config, store)).warnings).toEqual([]);
  });
});
```

Run: `pnpm vitest run core/src/indexer/indexer.test.ts -t "linked to routes"`
Expected: FAIL: `store.listApiCalls is not a function`.

- [ ] **Step 4: Store types and methods**

In `core/src/store/types.ts`, after `CrossEdgeFact`, add:

```ts
export interface ApiCallWithCaller extends ApiCallRecord {
  caller: SymbolRecord;
}

/** A stored edge as a trace reads it: the API call with its calling function, and how it matched. */
export interface CrossEdgeRecord {
  apiCall: ApiCallWithCaller;
  routeId: number;
  match: EdgeMatch;
  confidence: number;
  pinned: boolean;
  resolved: boolean;
  /** True when some edge of this API call is resolved (to this route or another). */
  callResolved: boolean;
}
```

In `core/src/store/store.ts`, add `ApiCallWithCaller`, `CrossEdgeFact`, `CrossEdgeRecord` to the type imports, and add after `getApiCalls`:

```ts
  /** Every API call with the function that makes it, by file and line. */
  async listApiCalls(): Promise<ApiCallWithCaller[]> {
    const { rows } = await this.pool.query<ApiCallRow>(
      `SELECT a.id, a.symbol_id, a.method, a.url_pattern, a.url_text, a.line, ${PREFIXED_SYMBOL}
       FROM api_calls a JOIN symbols s ON s.id = a.symbol_id JOIN files sf ON sf.id = s.file_id
       ORDER BY sf.path, a.line, a.id`,
    );
    return rows.map(toApiCallWithCaller);
  }

  /** Replaces every API call -> route edge in one transaction (they are rebuilt on each index pass). */
  async replaceCrossEdges(edges: CrossEdgeFact[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM cross_edges');
      await client.query(
        `INSERT INTO cross_edges (api_call_id, route_id, confidence, pinned, match, resolved)
         SELECT x."apiCallId", x."routeId", x.confidence, x.pinned, x.match, x.resolved
         FROM jsonb_to_recordset($1::jsonb) AS x("apiCallId" bigint, "routeId" bigint, confidence double precision,
                                                 pinned boolean, match text, resolved boolean)`,
        [JSON.stringify(edges)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Edges into a route, best first, each with its API call and calling function. */
  async getCrossEdges(routeId: number): Promise<CrossEdgeRecord[]> {
    const { rows } = await this.pool.query<ApiCallRow & { route_id: string; match: CrossEdgeRecord['match']; confidence: number; pinned: boolean; resolved: boolean; call_resolved: boolean }>(
      `SELECT e.route_id, e.match, e.confidence, e.pinned, e.resolved,
              EXISTS (SELECT 1 FROM cross_edges r WHERE r.api_call_id = e.api_call_id AND r.resolved) AS call_resolved,
              a.id, a.symbol_id, a.method, a.url_pattern, a.url_text, a.line, ${PREFIXED_SYMBOL}
       FROM cross_edges e
       JOIN api_calls a ON a.id = e.api_call_id
       JOIN symbols s ON s.id = a.symbol_id JOIN files sf ON sf.id = s.file_id
       WHERE e.route_id = $1
       ORDER BY e.confidence DESC, sf.path, a.line`,
      [routeId],
    );
    return rows.map((r) => ({
      apiCall: toApiCallWithCaller(r), routeId: Number(r.route_id), match: r.match, confidence: r.confidence, pinned: r.pinned,
      resolved: r.resolved, callResolved: r.call_resolved,
    }));
  }

  /** Components whose JSX handlers name `key`, e.g. `onClick={logout}`. */
  async getHandlerOwners(key: SymbolKey): Promise<SymbolRecord[]> {
    const { rows } = await this.pool.query<SymbolRow>(
      `SELECT DISTINCT s.id, f.path AS file, s.name, s.kind, s.start_line, s.end_line, s.exported, s.signature
       FROM components c
       JOIN symbols s ON s.id = c.symbol_id JOIN files f ON f.id = s.file_id
       CROSS JOIN LATERAL jsonb_array_elements(c.handlers) AS h
       WHERE h->'target'->>'file' = $1 AND h->'target'->>'name' = $2 AND (h->'target'->>'startLine')::int = $3
       ORDER BY f.path, s.start_line`,
      [key.file, key.name, key.startLine],
    );
    return rows.map(toSymbolRecord);
  }
```

Next to the other row types and helpers, add:

```ts
interface ApiCallRow extends PrefixedSymbolRow {
  id: string;
  symbol_id: string;
  method: string;
  url_pattern: string;
  url_text: string;
  line: number;
}

function toApiCallWithCaller(r: ApiCallRow): ApiCallWithCaller {
  return {
    id: Number(r.id), symbolId: Number(r.symbol_id), method: r.method, urlPattern: r.url_pattern, urlText: r.url_text, line: r.line,
    caller: optionalSymbol(r)!,
  };
}
```

- [ ] **Step 5: Rebuild edges on every pass**

In `core/src/indexer/index.ts`:

1. `import { computeCrossEdges } from '../routes/crossEdges.js';`
2. Add to `IndexResult`, after `stats`: `/** Pinned edges that no longer match anything (CLAUDE.md §6.5). */ warnings: string[];`
3. After the `if (touched.length > 0) { … }` block and before `return`, add:

```ts
  // Frontend API calls -> routes (CLAUDE.md §6.5). Rebuilt on every pass: pins live in config, not in files.
  const crossEdges = computeCrossEdges(await store.listApiCalls(), await store.listRoutes(), config.pinnedEdges);
  await store.replaceCrossEdges(crossEdges.edges);
```

4. Add `warnings: crossEdges.warnings,` to the returned object.

In `cli/src/commands/shared.ts`, at the end of `printIndexResult`, add:

```ts
  for (const warning of result.warnings) io.log(`! ${warning}`);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run core/src/indexer core/src/store cli/src`
Expected: PASS. If a CLI test builds an `IndexResult` by hand, add `warnings: []` to it.

- [ ] **Step 7: Checkpoint**

Do not commit. `pnpm typecheck` is clean.

---

### Task 3: Trace context

**Files:**
- Modify: `core/src/context/endpoint.ts` (export `findRoute`), `core/src/context/component.ts` (export `componentStructure`, `ComponentStructure`), `core/src/context/index.ts`
- Create: `core/src/context/trace.ts`
- Test: `core/src/context/trace.test.ts`

**Interfaces:**
- Consumes: `getCrossEdges`, `getHandlerOwners`, `getCallers`, `getSymbolsInFile`, `listRoutes` (Store); `buildComponentContext`, `componentStructure`, `structureHashOf`, `ComponentApiCall`; `buildEndpointContext`, `currentChainHash`, `findRoute`; `parseEndpointTarget`; `PinnedEdge`.
- Produces:
  ```ts
  export interface TraceTarget { endpoint: EndpointTarget; from: ComponentTarget | null }
  export interface TraceLink { call: ComponentApiCall; match: EdgeMatch; confidence: number; pinned: boolean }
  export interface AfterResponse { calleeText: string; file: string; line: number; callee: string | null }
  export interface TraceContext { scopeRef: string; component: ComponentContext; endpoint: EndpointContext; link: TraceLink; afterResponse: AfterResponse[]; files: Record<string, number>; packages: PackageFact[]; unresolved: UnresolvedFact[]; warnings: string[]; traceHash: string }
  export class PinNeededError extends Error { route: { method: string; fullPath: string }; candidates: CrossEdgeRecord[] }
  buildTraceContext(store, repoRoot, target: TraceTarget, options: { depth: number; maxContextTokens: number }): Promise<TraceContext>
  currentTraceHash(store, repoRoot, scopeRef: string, depth: number): Promise<string | null>
  describeCandidate(c: CrossEdgeRecord): string   // "POST /patients/enroll in useEnrollMutation.mutate (web/hooks/useEnrollMutation.ts:19): suffix match (0.6)"
  describeLink(link: TraceLink): string           // "exact match, confidence 1.0" | "pinned in .walkthrough/config.json"
  pinFor(c: CrossEdgeRecord, route: { method: string; fullPath: string }): PinnedEdge
  ```

- [ ] **Step 1: Write the failing test**

Create `core/src/context/trace.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addPinnedEdge, loadConfig } from '../config.js';
import { indexRepo } from '../indexer/index.js';
import { openStore, type Store } from '../store/index.js';
import { buildTraceContext, currentTraceHash, describeCandidate, PinNeededError, pinFor, type TraceContext } from './trace.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const OPTIONS = { depth: 3, maxContextTokens: 60000 };
const ENROLL = { method: 'POST', path: '/api/patients/enroll' };
const schema = (tag: string) => `cw_test_${tag}_${Math.random().toString(16).slice(2, 10)}`;

describe('buildTraceContext on the fixture', () => {
  let store: Store;
  let ctx: TraceContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: schema('trc') });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildTraceContext(store, FIXTURE, { endpoint: ENROLL, from: null }, OPTIONS);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('links the click in EnrollForm to the route (Phase 5 acceptance)', () => {
    expect(ctx.scopeRef).toBe('POST /api/patients/enroll <- web/components/EnrollForm.tsx#EnrollForm');
    expect(ctx.link).toMatchObject({ match: 'exact', confidence: 1, pinned: false, call: { method: 'POST', urlPattern: '/api/patients/enroll', line: 19 } });
    expect(ctx.link.call.symbol.name).toBe('useEnrollMutation.mutate');
    expect(ctx.link.call.triggers.map((t) => `${t.label}: ${t.path.join(' → ')}`)).toEqual(['onSubmit on <form>: EnrollForm.handleSubmit → useEnrollMutation.mutate']);
  });

  it('carries the server side and what the frontend does after the response (Phase 5 acceptance)', () => {
    expect(ctx.endpoint.chain.map((n) => n.label)).toEqual(['express.json()', 'requireAuth', 'rateLimit', 'validate.validateBody', 'enrollHandler']);
    expect(ctx.endpoint.sideEffects.map((e) => `${e.kind} ${e.detail}`)).toEqual(expect.arrayContaining(['db_write INSERT patients', 'db_write INSERT consents']));
    expect(ctx.afterResponse.map((a) => `${a.calleeText}:${a.line}`)).toEqual(['setStatus:20', 'onSuccess:21', 'setStatus:23', 'setError:24']);
    expect(Object.keys(ctx.files)).toEqual(expect.arrayContaining(['api/services/enrollService.ts', 'web/components/EnrollForm.tsx', 'web/hooks/useEnrollMutation.ts']));
  });

  it('accepts a concrete path and follows an effect-triggered call', async () => {
    const get = await buildTraceContext(store, FIXTURE, { endpoint: { method: 'GET', path: '/api/patients/42' }, from: null }, OPTIONS);
    expect(get.scopeRef).toBe('GET /api/patients/:id <- web/components/PatientSummary.tsx#PatientSummary');
    expect(get.link.call.triggers[0]).toMatchObject({ kind: 'effect', label: 'useEffect [id] in usePatient' });
  });

  it('recomputes the trace hash from the index alone', async () => {
    expect(await currentTraceHash(store, '/nonexistent-repo-root', ctx.scopeRef, 3)).toBe(ctx.traceHash);
    expect(await currentTraceHash(store, FIXTURE, 'POST /api/gone <- web/components/EnrollForm.tsx#EnrollForm', 3)).toBeNull();
  });
});

describe('buildTraceContext: choosing a caller and pinning', () => {
  let repo: string;
  let store: Store;
  const reindex = async () => indexRepo(repo, loadConfig(repo), store);

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-trace-'));
    cpSync(FIXTURE, repo, { recursive: true });
    writeFileSync(
      join(repo, 'web/components/QuickEnroll.tsx'),
      [
        "import { useEnrollMutation } from '../hooks/useEnrollMutation';",
        "import type { EnrollFormValues } from '../types';",
        '',
        'export function QuickEnroll({ values }: { values: EnrollFormValues }) {',
        '  const { mutate } = useEnrollMutation();',
        '  return <button onClick={() => mutate(values)}>Enroll again</button>;',
        '}',
        '',
      ].join('\n'),
    );
    store = await openStore({ url: DATABASE_URL, schema: schema('trcp') });
    await store.migrate();
    await reindex();
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('asks which component to trace when several call the endpoint', async () => {
    await expect(buildTraceContext(store, repo, { endpoint: ENROLL, from: null }, OPTIONS)).rejects.toThrow(
      'POST /api/patients/enroll is called from 2 components: web/components/EnrollForm.tsx#EnrollForm, web/components/QuickEnroll.tsx#QuickEnroll. Choose one with --from <file>#<Component>.',
    );
    const quick = await buildTraceContext(store, repo, { endpoint: ENROLL, from: { file: 'web/components/QuickEnroll.tsx', name: null } }, OPTIONS);
    expect(quick.link.call.triggers[0].label).toBe('onClick on <button>');
    await expect(buildTraceContext(store, repo, { endpoint: ENROLL, from: { file: 'web/components/PatientSummary.tsx', name: null } }, OPTIONS)).rejects.toThrow(
      /web\/components\/PatientSummary\.tsx doesn't call POST \/api\/patients\/enroll; callers: /,
    );
  });

  it('needs a pin for a URL that only matches by suffix, then follows the pin', async () => {
    const hook = join(repo, 'web/hooks/useEnrollMutation.ts');
    writeFileSync(hook, readFileSync(hook, 'utf8').replace("'/api/patients/enroll'", "'/patients/enroll'"));
    await reindex();
    const failure = await buildTraceContext(store, repo, { endpoint: ENROLL, from: null }, OPTIONS).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PinNeededError);
    const { candidates, route } = failure as PinNeededError;
    expect(candidates.map(describeCandidate)).toEqual(['POST /patients/enroll in useEnrollMutation.mutate (web/hooks/useEnrollMutation.ts:19): suffix match (0.6)']);

    addPinnedEdge(repo, pinFor(candidates[0], route));
    expect(loadConfig(repo).pinnedEdges).toEqual([
      { caller: 'web/hooks/useEnrollMutation.ts#useEnrollMutation.mutate', method: 'POST', url: '/patients/enroll', route: 'POST /api/patients/enroll' },
    ]);
    await reindex();
    const pinned = await buildTraceContext(store, repo, { endpoint: ENROLL, from: { file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' } }, OPTIONS);
    expect(pinned.link).toMatchObject({ match: 'pinned', pinned: true, confidence: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run core/src/context/trace.test.ts`
Expected: FAIL: cannot resolve `./trace.js`.

- [ ] **Step 3: Export what the trace reuses**

- In `core/src/context/endpoint.ts`: change `async function findRoute(` to `export async function findRoute(`.
- In `core/src/context/component.ts`: change `interface ComponentStructure {` to `export interface ComponentStructure {` and `async function componentStructure(` to `export async function componentStructure(`.
- In `core/src/context/index.ts`: append `export * from './trace.js';`.

- [ ] **Step 4: Implement the trace context**

Create `core/src/context/trace.ts`:

```ts
import { createHash } from 'node:crypto';
import type { PinnedEdge } from '../config.js';
import { parseEndpointTarget, type EndpointTarget } from '../routes/match.js';
import type { Store } from '../store/index.js';
import type { CrossEdgeRecord, EdgeMatch, RouteRecord, SymbolRecord } from '../store/types.js';
import { buildComponentContext, componentStructure, structureHashOf, type ComponentApiCall, type ComponentContext } from './component.js';
import { buildEndpointContext, currentChainHash, findRoute, type EndpointContext } from './endpoint.js';
import type { PackageFact, UnresolvedFact } from './fn.js';
import { parseComponentTarget, TargetError, type ComponentTarget } from './target.js';

// Selects the facts for `walk trace` (CLAUDE.md §6.5): the route, the frontend call(s) linked to it
// (cross_edges), the component whose user action or effect reaches that call, and both sides' contexts.
// A loose link is never followed silently: PinNeededError hands the choice to the user.

export interface TraceTarget {
  endpoint: EndpointTarget;
  /** --from: which calling component to trace; null = the only one. */
  from: ComponentTarget | null;
}

export interface TraceLink {
  /** The API call as the component context sees it, with its triggers. */
  call: ComponentApiCall;
  match: EdgeMatch;
  confidence: number;
  pinned: boolean;
}

/** A call the calling function makes after the request line, e.g. `setStatus('success')`, `onSuccess?.(patient)`. */
export interface AfterResponse {
  calleeText: string;
  file: string;
  line: number;
  /** The repo function called, when resolved. */
  callee: string | null;
}

export interface TraceContext {
  /** "<METHOD> <full path> <- <file>#<Component>"; the saved walkthrough's scope. */
  scopeRef: string;
  component: ComponentContext;
  endpoint: EndpointContext;
  link: TraceLink;
  afterResponse: AfterResponse[];
  files: Record<string, number>;
  packages: PackageFact[];
  unresolved: UnresolvedFact[];
  warnings: string[];
  /** Changes when the component's structure, the route's chain or the link changes. */
  traceHash: string;
}

export interface TraceContextOptions {
  depth: number;
  maxContextTokens: number;
}

/** The route has no confirmed caller, but these calls match it loosely: the user must pin one. */
export class PinNeededError extends Error {
  constructor(
    public readonly route: { method: string; fullPath: string },
    public readonly candidates: CrossEdgeRecord[],
  ) {
    super(
      `${route.method} ${route.fullPath} has no confirmed frontend caller. These calls match it only loosely:\n` +
        candidates.map((c, i) => `  [${i + 1}] ${describeCandidate(c)}`).join('\n'),
    );
    this.name = 'PinNeededError';
  }
}

const MAX_HOPS = 8;

export async function buildTraceContext(store: Store, repoRoot: string, target: TraceTarget, options: TraceContextOptions): Promise<TraceContext> {
  const { route, warnings: matchWarnings } = await findRoute(store, target.endpoint);
  const edges = await store.getCrossEdges(route.id);
  const resolved = edges.filter((e) => e.resolved);
  const loose = edges.filter((e) => !e.callResolved);
  if (resolved.length === 0) {
    if (loose.length > 0) throw new PinNeededError(route, loose);
    throw new TargetError(
      `No frontend API call matches ${route.method} ${route.fullPath}. Check apiClientWrappers in .walkthrough/config.json, and that the frontend builds this URL from a string or template literal.`,
    );
  }

  const caller = pickCaller(route, resolved, await callersOf(store, resolved), target.from);
  const half = Math.floor(options.maxContextTokens / 2);
  const component = await buildComponentContext(store, repoRoot, { file: caller.component.file, name: caller.component.name }, { depth: options.depth, maxContextTokens: half });
  const call = component.apiCalls.find((a) => a.symbol.id === caller.edge.apiCall.caller.id && a.line === caller.edge.apiCall.line);
  if (!call) {
    throw new TargetError(
      `${caller.component.name} reaches ${caller.edge.apiCall.caller.name} only beyond --depth ${options.depth}; run again with a larger --depth.`,
    );
  }
  const endpoint = await buildEndpointContext(store, repoRoot, { method: route.method, path: route.fullPath }, { depth: options.depth, maxContextTokens: half });
  const link: TraceLink = { call, match: caller.edge.match, confidence: caller.edge.confidence, pinned: caller.edge.pinned };

  const afterResponse: AfterResponse[] = component.callees
    .filter((c) => c.caller.id === call.symbol.id && c.callLine > call.line)
    .map((c) => ({ calleeText: c.calleeText, file: c.caller.file, line: c.callLine, callee: c.callee?.name ?? null }));

  const warnings = [
    ...matchWarnings,
    ...component.warnings,
    ...endpoint.warnings,
    ...(call.triggers.length === 0 ? [`No user action or effect in ${caller.component.name} was found to trigger this call.`] : []),
    ...loose.map((e) => `Also loosely matching this route, not traced (pin it to trace it): ${describeCandidate(e)}`),
  ];
  const files = Object.fromEntries(Object.entries({ ...component.files, ...endpoint.files }).sort(([a], [b]) => a.localeCompare(b)));
  const packages = [...new Map([...component.packages, ...endpoint.packages].map((p) => [p.name, p])).values()];
  const unresolved = [...new Map([...component.unresolved, ...endpoint.unresolved].map((u) => [u.note, u])).values()];

  return {
    scopeRef: `${route.method} ${route.fullPath} <- ${component.scopeRef}`,
    component,
    endpoint,
    link,
    afterResponse,
    files,
    packages,
    unresolved,
    warnings: [...new Set(warnings)],
    traceHash: traceHashOf(component.structureHash, endpoint.chainHash, caller.edge),
  };
}

/** The trace hash a saved trace would have now, from the index alone; null when its route, component or link is gone. */
export async function currentTraceHash(store: Store, _repoRoot: string, scopeRef: string, depth: number): Promise<string | null> {
  const [routeRef, componentRef] = scopeRef.split(' <- ');
  if (!componentRef) return null;
  try {
    const target = parseEndpointTarget(routeRef);
    const route = (await store.listRoutes()).find((r) => r.method === target.method && r.fullPath === target.path);
    const chain = await currentChainHash(store, routeRef);
    if (!route || chain === null) return null;
    const structure = await componentStructure(store, parseComponentTarget(componentRef), depth);
    const edge = (await store.getCrossEdges(route.id)).find(
      (e) => e.resolved && structure.apiCalls.some((a) => a.symbol.id === e.apiCall.caller.id && a.line === e.apiCall.line),
    );
    return edge ? traceHashOf(structureHashOf(structure), chain, edge) : null;
  } catch (err) {
    if (err instanceof TargetError) return null;
    throw err;
  }
}

export function describeCandidate(c: CrossEdgeRecord): string {
  const a = c.apiCall;
  return `${a.method} ${a.urlPattern} in ${a.caller.name} (${a.caller.file}:${a.line}): ${c.match} match (${c.confidence.toFixed(1)})`;
}

export function describeLink(link: TraceLink): string {
  return link.pinned ? 'pinned in .walkthrough/config.json' : `${link.match} match, confidence ${link.confidence.toFixed(1)}`;
}

/** The pinnedEdges entry that links candidate `c` to `route`. */
export function pinFor(c: CrossEdgeRecord, route: { method: string; fullPath: string }): PinnedEdge {
  return { caller: `${c.apiCall.caller.file}#${c.apiCall.caller.name}`, method: c.apiCall.method, url: c.apiCall.urlPattern, route: `${route.method} ${route.fullPath}` };
}

function traceHashOf(structureHash: string, chainHash: string, edge: CrossEdgeRecord): string {
  const a = edge.apiCall;
  const link = `${a.caller.file}#${a.caller.name} ${a.method} ${a.urlPattern} ${edge.match} ${edge.pinned}`;
  return createHash('sha256').update([`component ${structureHash}`, `endpoint ${chainHash}`, `link ${link}`].join('\n')).digest('hex');
}

interface Caller {
  component: SymbolRecord;
  edge: CrossEdgeRecord;
}

/** Each component that reaches one of the edges' calls, with the first such edge. */
async function callersOf(store: Store, edges: CrossEdgeRecord[]): Promise<Caller[]> {
  const callers = new Map<number, Caller>();
  for (const edge of edges) {
    for (const component of await componentsReaching(store, edge.apiCall.caller)) {
      if (!callers.has(component.id)) callers.set(component.id, { component, edge });
    }
  }
  return [...callers.values()].sort((a, b) => a.component.file.localeCompare(b.component.file) || a.component.startLine - b.component.startLine);
}

/**
 * Components from which `start` is reached, walking up at most MAX_HOPS: through callers, through JSX
 * handlers that name a function (`onClick={logout}`), and stopping at the component that encloses a
 * function (`EnrollForm.handleSubmit` -> `EnrollForm`).
 */
async function componentsReaching(store: Store, start: SymbolRecord): Promise<SymbolRecord[]> {
  const found = new Map<number, SymbolRecord>();
  const seen = new Set<number>([start.id]);
  const fileSymbols = new Map<string, SymbolRecord[]>();
  const symbolsOf = async (file: string) => {
    if (!fileSymbols.has(file)) fileSymbols.set(file, await store.getSymbolsInFile(file));
    return fileSymbols.get(file)!;
  };
  let frontier = [start];
  for (let hop = 0; hop <= MAX_HOPS && frontier.length > 0; hop++) {
    const next: SymbolRecord[] = [];
    for (const s of frontier) {
      const enclosing =
        s.kind === 'component'
          ? s
          : (await symbolsOf(s.file))
              .filter((c) => c.kind === 'component' && c.startLine <= s.startLine && c.endLine >= s.endLine)
              .sort((a, b) => b.startLine - a.startLine)[0];
      if (enclosing) {
        found.set(enclosing.id, enclosing);
        continue;
      }
      const up = [...(await store.getCallers(s.id)).map((c) => c.caller), ...(await store.getHandlerOwners({ file: s.file, name: s.name, startLine: s.startLine }))];
      for (const u of up) {
        if (!seen.has(u.id)) {
          seen.add(u.id);
          next.push(u);
        }
      }
    }
    frontier = next;
  }
  return [...found.values()];
}

function pickCaller(route: RouteRecord, resolved: CrossEdgeRecord[], callers: Caller[], from: ComponentTarget | null): Caller {
  const ref = (c: Caller) => `${c.component.file}#${c.component.name}`;
  const list = callers.map(ref).join(', ');
  const endpoint = `${route.method} ${route.fullPath}`;
  if (from) {
    const matches = callers.filter((c) => c.component.file === from.file && (from.name === null || c.component.name === from.name));
    if (matches.length === 1) return matches[0];
    const named = `${from.file}${from.name ? `#${from.name}` : ''}`;
    if (matches.length > 1) throw new TargetError(`${named} has several components calling ${endpoint} (${matches.map(ref).join(', ')}); name one.`);
    throw new TargetError(`${named} doesn't call ${endpoint}; callers: ${list || 'none found'}.`);
  }
  if (callers.length === 1) return callers[0];
  if (callers.length === 0) {
    const calls = resolved.map((e) => `${e.apiCall.caller.name} (${e.apiCall.caller.file}:${e.apiCall.line})`).join(', ');
    throw new TargetError(`No component reaches the frontend call(s) to ${endpoint} within ${MAX_HOPS} calls: ${calls}. Use \`walk fn\` on the calling function instead.`);
  }
  throw new TargetError(`${endpoint} is called from ${callers.length} components: ${list}. Choose one with --from <file>#<Component>.`);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run core/src/context`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Do not commit. `pnpm --filter @codewalk/core exec tsc --noEmit` is clean.

---

### Task 4: Combined sequence diagram

**Files:**
- Modify: `core/src/render/mermaid.ts`, `core/src/index.ts`
- Test: `core/src/render/mermaid.test.ts` (append)

**Interfaces:**
- Consumes: `TraceContext` (Task 3); `endpointDiagram` (existing).
- Produces: `traceDiagram(ctx: TraceContext): string`.

- [ ] **Step 1: Write the failing test**

Append to `core/src/render/mermaid.test.ts` (add `buildTraceContext` to the imports from `../context/trace.js` and `traceDiagram` from `./mermaid.js`):

```ts
describe('traceDiagram', () => {
  let store: Store;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_mmt_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  const trace = async (method: string, path: string) =>
    traceDiagram(await buildTraceContext(store, FIXTURE, { endpoint: { method, path }, from: null }, { depth: 3, maxContextTokens: 60000 }));

  it('draws the click through the frontend into the endpoint and back (Phase 5 acceptance)', async () => {
    const diagram = await trace('POST', '/api/patients/enroll');
    const lines = diagram.split('\n');
    expect(lines.slice(0, 4)).toEqual(['sequenceDiagram', '  actor User', '  participant C as EnrollForm', '  participant F1 as useEnrollMutation.ts']);
    expect(lines).toContain('  participant P1 as express.json()');
    expect(lines).toContain('  User->>C: onSubmit on <form>');
    expect(lines).toContain('  C->>C: handleSubmit()');
    expect(lines).toContain('  C->>F1: mutate()');
    expect(lines).toContain('  F1->>P1: POST /api/patients/enroll');
    expect(lines).toContain('  P5-->>F1: response');
    expect(diagram).toMatch(/->>P\d+: INSERT consents/);
    expect(diagram).toMatch(/ {2}alt ConflictError\n {4}P\d+-->>F1: 409\n {2}end/);
    expect(diagram).not.toContain('Client');
    expect(lines.at(-1)).toBe('  Note over F1: then setStatus(), onSuccess(), setError()');
  });

  it('starts an effect-triggered trace with a note instead of a user action', async () => {
    const lines = (await trace('GET', '/api/patients/42')).split('\n');
    expect(lines).toContain('  Note over C: useEffect [id] in usePatient');
    expect(lines).toContain('  C->>F1: usePatient()');
    expect(lines).toContain('  F1->>P1: GET /api/patients/:id');
    expect(lines.some((l) => l.startsWith('  User->>'))).toBe(false);
  });
});
```

Run: `pnpm vitest run core/src/render/mermaid.test.ts`
Expected: FAIL: `traceDiagram` is not exported.

- [ ] **Step 2: Implement**

In `core/src/render/mermaid.ts`, add `import type { TraceContext } from '../context/trace.js';` and append:

```ts
/**
 * The full-stack diagram (CLAUDE.md §6.5): the user (or an effect) → the component → the frontend files
 * on the trigger path → the endpoint diagram, whose Client is the frontend function making the call, so
 * responses and error statuses come back to it → what that function does after the response.
 */
export function traceDiagram(ctx: TraceContext): string {
  const comp = ctx.component.component.symbol;
  const fileOf = new Map<string, string>();
  for (const u of [ctx.component.component, ...ctx.component.hooks]) for (const s of [u.symbol, ...u.inner]) fileOf.set(s.name, s.file);
  for (const c of ctx.component.callees) if (c.callee) fileOf.set(c.callee.name, c.callee.file);

  const participants = ['  actor User', `  participant C as ${text(comp.name)}`];
  const ids = new Map<string, string>([[comp.file, 'C']]);
  const idFor = (file: string): string => {
    let id = ids.get(file);
    if (!id) {
      id = `F${ids.size}`;
      ids.set(file, id);
      participants.push(`  participant ${id} as ${text(basename(file))}`);
    }
    return id;
  };

  const messages: string[] = [];
  const trigger = ctx.link.call.triggers[0];
  if (!trigger) messages.push('  Note over C: no trigger found');
  else if (trigger.kind === 'effect') messages.push(`  Note over C: ${text(trigger.label)}`);
  else messages.push(`  User->>C: ${text(trigger.label)}`);
  let from = 'C';
  for (const name of trigger?.path ?? [ctx.link.call.symbol.name]) {
    const to = idFor(fileOf.get(name) ?? ctx.link.call.symbol.file);
    messages.push(`  ${from}->>${to}: ${text(name.slice(name.lastIndexOf('.') + 1))}()`);
    from = to;
  }

  const server = endpointDiagram(ctx.endpoint).split('\n').slice(1);
  for (const line of server) {
    if (line === '  participant Client') continue;
    if (line.trimStart().startsWith('participant ')) participants.push(line);
    else messages.push(line.replace(/^(\s+)Client(?=-?->>)/, `$1${from}`).replace(/(-?->>)Client:/, `$1${from}:`));
  }

  const after = [...new Set(ctx.afterResponse.map((a) => `${a.calleeText.slice(a.calleeText.lastIndexOf('.') + 1)}()`))];
  if (after.length > 0) messages.push(`  Note over ${from}: then ${text(after.join(', '))}`);
  return ['sequenceDiagram', ...participants, ...messages].join('\n');
}
```

In `core/src/index.ts`, change the mermaid export to `export { endpointDiagram, traceDiagram } from './render/mermaid.js';`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm vitest run core/src/render`
Expected: PASS. If `text()` strips something the test expects (it removes only `;`, `#` and newlines), fix the code, not the test.

- [ ] **Step 4: Checkpoint**

Do not commit. Core typecheck is clean.

---

### Task 5: Trace prompt, verifier facts, recorded response, `explainTrace`

**Files:**
- Modify: `core/src/llm/prompt.ts`, `core/src/llm/endpointPrompt.ts`, `core/src/llm/componentPrompt.ts`, `core/src/llm/index.ts`
- Create: `core/src/llm/tracePrompt.ts`, `core/src/llm/__fixtures__/enrollTrace.response.json`
- Modify: `core/src/verify/verify.ts`
- Create: `core/src/walkthrough/trace.ts`; modify `core/src/walkthrough/index.ts`
- Test: `core/src/walkthrough/trace.test.ts`

**Interfaces:**
- Produces: `citeFiles(files: Record<string, number>): string[]`; `endpointPromptSections(ctx): string[]`; `componentPromptSections(ctx): string[]` (the existing renderers' output is unchanged); `TRACE_SYSTEM_PROMPT`; `renderTracePrompt(ctx: TraceContext): string`; `traceVerifyFacts(ctx: TraceContext): VerifyFacts`; `explainTrace(provider, ctx, repoRoot): Promise<FnWalkthrough>`, with `scope = { file, start, end of the component, symbol: ctx.scopeRef }`.

- [ ] **Step 1: Write the recorded response**

Create `core/src/llm/__fixtures__/enrollTrace.response.json`:

```json
{
  "title": "How enrolling a patient works, from the Enroll button to the database",
  "summary": "Submitting EnrollForm calls mutate from useEnrollMutation, which posts the form to POST /api/patients/enroll; the request passes body parsing, session auth, rate limiting and validation, enrollPatient writes the patient and consent in one transaction, the server answers 201, and the form resets.",
  "stages": [
    {
      "name": "UI trigger",
      "steps": [
        {
          "id": "s1",
          "code_ref": { "file": "web/components/EnrollForm.tsx", "start": 32, "end": 36 },
          "explanation": "`handleSubmit` runs when the `form` fires `onSubmit`: it calls `preventDefault`, stops unless `values.consentGiven` is true, and calls `mutate` with `values`.",
          "example": {
            "input": "the user fills Asha / Rao / +91 98765-43210 / 1990-04-02, ticks consent and clicks Enroll",
            "state_after": "mutate(values) called with values = { firstName: 'Asha', lastName: 'Rao', phone: '+91 98765-43210', dateOfBirth: '1990-04-02', consentGiven: true }"
          },
          "references": [{ "file": "web/hooks/useEnrollMutation.ts", "line": 15, "role": "callee" }],
          "docs": [],
          "concepts": ["form submission"],
          "risks": ["Without consent nothing is sent."]
        }
      ]
    },
    {
      "name": "Request",
      "steps": [
        {
          "id": "s2",
          "code_ref": { "file": "web/hooks/useEnrollMutation.ts", "start": 15, "end": 19 },
          "explanation": "`mutate` sets `status` to `submitting`, clears `error` and awaits `api.post` on `/api/patients/enroll` with the form `values`.",
          "example": { "input": "mutate(values)", "state_after": "status = 'submitting'; POST /api/patients/enroll sent with the values as the JSON body" },
          "references": [{ "file": "web/apiClient.ts", "line": 28, "role": "callee" }],
          "docs": [],
          "concepts": ["API client"],
          "risks": []
        },
        {
          "id": "s3",
          "code_ref": { "file": "api/app.ts", "start": 9, "end": 10 },
          "explanation": "`express.json` parses the JSON body into `req.body`, then `app.use` hands every path under `/api` to `apiRouter`.",
          "example": { "input": "the POST arrives at the server", "state_after": "req.body = { firstName: 'Asha', lastName: 'Rao', phone: '+91 98765-43210', dateOfBirth: '1990-04-02', consentGiven: true }" },
          "references": [{ "file": "api/routes/index.ts", "line": 6, "role": "callee" }],
          "docs": [{ "package": "express", "symbol": "express.json" }],
          "concepts": ["middleware chain"],
          "risks": []
        }
      ]
    },
    {
      "name": "Server",
      "steps": [
        {
          "id": "s4",
          "code_ref": { "file": "api/middleware/auth.ts", "start": 11, "end": 23 },
          "explanation": "`requireAuth` takes the bearer token from the `authorization` header, loads `session:${token}` with `redis.get` and stores the parsed `SessionUser` on `req.user`.",
          "example": { "input": "Authorization: Bearer tok_1 (from localStorage)", "state_after": "req.user = { id: 'u_7', role: 'staff' } (session assumed to exist)" },
          "references": [{ "file": "api/routes/patients.ts", "line": 11, "role": "caller" }],
          "docs": [],
          "concepts": ["session auth"],
          "risks": ["Missing or expired session: UnauthorizedError, 401, and mutate shows 'Enrollment failed.'"]
        },
        {
          "id": "s5",
          "code_ref": { "file": "api/middleware/validate.ts", "start": 7, "end": 13 },
          "explanation": "`validateBody` runs `schema.safeParse` on `req.body`; on failure it passes a `ValidationError` with the issue list to `next`, otherwise it replaces `req.body` with `result.data`.",
          "example": { "input": "the same body", "state_after": "result.success = true; req.body is the parsed EnrollInput" },
          "references": [{ "file": "api/routes/patients.ts", "line": 13, "role": "caller" }],
          "docs": [],
          "concepts": ["schema validation"],
          "risks": ["Invalid body: ValidationError, 400"]
        },
        {
          "id": "s6",
          "code_ref": { "file": "api/controllers/patientsController.ts", "start": 9, "end": 10 },
          "explanation": "`enrollHandler` reads `user` from the request and calls `enrollPatient` with `req.body` and `user.id`.",
          "example": { "input": "the validated request", "state_after": "enrollPatient(body, 'u_7') awaited" },
          "references": [{ "file": "api/services/enrollService.ts", "line": 35, "role": "callee" }],
          "docs": [],
          "concepts": ["controller / service split"],
          "risks": []
        }
      ]
    },
    {
      "name": "Persistence",
      "steps": [
        {
          "id": "s7",
          "code_ref": { "file": "api/services/enrollService.ts", "start": 47, "end": 58 },
          "explanation": "It opens a transaction with `client.query`, writes the patient with `insertPatient` and the consent with `insertConsent`, then sends `COMMIT`.",
          "example": { "input": "phone normalised to 9876543210, no existing patient", "state_after": "rows inserted in patients and consents; patient.id = 'p_101' (assumed)" },
          "references": [
            { "file": "api/repositories/patientRepository.ts", "line": 35, "role": "callee" },
            { "file": "api/repositories/patientRepository.ts", "line": 45, "role": "callee" }
          ],
          "docs": [],
          "concepts": ["database transaction"],
          "risks": ["Phone already enrolled: ConflictError, 409, and mutate shows 'This patient is already enrolled.'"]
        }
      ]
    },
    {
      "name": "Response",
      "steps": [
        {
          "id": "s8",
          "code_ref": { "file": "api/controllers/patientsController.ts", "start": 11, "end": 11 },
          "explanation": "`res.status` sets 201 and `res.json` sends the created patient back.",
          "example": { "input": "the inserted patient", "state_after": "HTTP 201 with { id: 'p_101', firstName: 'Asha', ... }" },
          "references": [],
          "docs": [],
          "concepts": ["HTTP status codes"],
          "risks": []
        }
      ]
    },
    {
      "name": "UI update",
      "steps": [
        {
          "id": "s9",
          "code_ref": { "file": "web/hooks/useEnrollMutation.ts", "start": 20, "end": 21 },
          "explanation": "When the response arrives, `mutate` sets `status` to `success` and calls `onSuccess` with the returned `patient`; the callback `EnrollForm` passed resets `values` with `setValues` to `EMPTY_FORM` and calls `onEnrolled`.",
          "example": { "input": "the 201 response", "state_after": "status = 'success'; values = EMPTY_FORM; onEnrolled(patient) called" },
          "references": [{ "file": "web/components/EnrollForm.tsx", "line": 21, "role": "caller" }],
          "docs": [],
          "concepts": ["callback props"],
          "risks": []
        }
      ]
    }
  ],
  "unresolved": []
}
```

- [ ] **Step 2: Write the failing test**

Create `core/src/walkthrough/trace.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildTraceContext, type TraceContext } from '../context/trace.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmMessage, LlmProvider } from '../llm/generate.js';
import { openStore, type Store } from '../store/index.js';
import { explainTrace } from './trace.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollTrace.response.json', import.meta.url), 'utf8');

function replay(...responses: string[]) {
  const requests: LlmMessage[][] = [];
  const provider: LlmProvider = {
    generate: async ({ messages }) => {
      requests.push([...messages]);
      const next = responses.shift();
      if (next === undefined) throw new Error('no more recorded responses');
      return next;
    },
  };
  return { provider, requests };
}

describe('explainTrace on the fixture', () => {
  let store: Store;
  let ctx: TraceContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_trw_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildTraceContext(store, FIXTURE, { endpoint: { method: 'POST', path: '/api/patients/enroll' }, from: null }, { depth: 3, maxContextTokens: 60000 });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('keeps every grounded step across both stacks, in the fixed stage order (Phase 5 acceptance)', async () => {
    const { provider, requests } = replay(RECORDED);
    const w = await explainTrace(provider, ctx, FIXTURE);
    expect(w.verification.dropped).toEqual([]);
    expect(w.verification.keptSteps).toBe(9);
    expect(w.stages.map((s) => s.name)).toEqual(['UI trigger', 'Request', 'Server', 'Persistence', 'Response', 'UI update']);
    expect(w.scope).toEqual({ file: 'web/components/EnrollForm.tsx', start: 18, end: 54, symbol: 'POST /api/patients/enroll <- web/components/EnrollForm.tsx#EnrollForm' });
    expect(w.stages[1].steps[1].docLinks[0]).toMatchObject({ package: 'express', symbol: 'express.json' });

    const prompt = requests[0][0].content;
    expect(prompt.split('\n')[0]).toBe('# Trace: onSubmit on <form> in EnrollForm → POST /api/patients/enroll');
    expect(prompt).toContain('- matched to route POST /api/patients/enroll by exact match, confidence 1.0');
    expect(prompt).toContain('# Component: EnrollForm (web/components/EnrollForm.tsx:18-54)');
    expect(prompt).toContain('# Endpoint: POST /api/patients/enroll');
    expect(prompt.match(/## Files you may cite/g)).toHaveLength(1);
  });

  it('drops a step citing a file outside both contexts', async () => {
    const bad = JSON.parse(RECORDED);
    bad.stages[0].steps[0].code_ref.file = 'web/components/PatientSummary.tsx';
    const { provider } = replay(JSON.stringify(bad));
    const w = await explainTrace(provider, ctx, FIXTURE);
    expect(w.verification.dropped.map((d) => d.stepId)).toEqual(['s1']);
  });
});
```

Run: `pnpm vitest run core/src/walkthrough/trace.test.ts`
Expected: FAIL: cannot resolve `./trace.js`.

- [ ] **Step 3: Split the prompt renderers (output unchanged)**

In `core/src/llm/prompt.ts`, append:

```ts
/** The closing list every prompt ends with: the only files a step may cite, with their line counts. */
export function citeFiles(files: Record<string, number>): string[] {
  return ['## Files you may cite (with line counts)', ...Object.entries(files).map(([file, lines]) => `- ${file}: ${lines} lines`)];
}
```

In `core/src/llm/endpointPrompt.ts`:
1. Import `citeFiles` from `./prompt.js` alongside `describe` and `fence`.
2. Rename `export function renderEndpointPrompt(ctx: EndpointContext): string {` to `export function endpointPromptSections(ctx: EndpointContext): string[] {`.
3. Replace its last four statements (the files heading push, the files loop, the `Write the walkthrough …` push and `return out.join('\n\n');`) with `return out;`.
4. Add:

```ts
export function renderEndpointPrompt(ctx: EndpointContext): string {
  const { route } = ctx;
  return [...endpointPromptSections(ctx), ...citeFiles(ctx.files), `Write the walkthrough of ${route.method} ${route.fullPath}.`].join('\n\n');
}
```

In `core/src/llm/componentPrompt.ts`, do the same: import `citeFiles`; rename `renderComponentPrompt` to `componentPromptSections(ctx: ComponentContext): string[]`; replace its last four statements with `return out;`; add:

```ts
export function renderComponentPrompt(ctx: ComponentContext): string {
  return [...componentPromptSections(ctx), ...citeFiles(ctx.files), `Write the walkthrough of ${ctx.component.symbol.name}.`].join('\n\n');
}
```

Run: `pnpm vitest run core/src/walkthrough/endpoint.test.ts core/src/walkthrough/component.test.ts`
Expected: PASS (the prompt text is identical).

- [ ] **Step 4: Trace prompt and verifier facts**

Create `core/src/llm/tracePrompt.ts`:

```ts
import { describeTrigger } from '../context/component.js';
import { describeLink, type TraceContext } from '../context/trace.js';
import { componentPromptSections } from './componentPrompt.js';
import { endpointPromptSections } from './endpointPrompt.js';
import { citeFiles } from './prompt.js';

// Turns a TraceContext into one prompt: how the frontend reaches the route, then the component's facts,
// then the endpoint's facts, then one list of citable files. Same contract as every walkthrough (CLAUDE.md §8.2).

export const TRACE_SYSTEM_PROMPT = `You explain one full-stack request of a TypeScript monorepo (React frontend, Express backend), from the user's action to the database and back, to a developer who must be able to explain it to someone else afterwards.

You are given facts from static analysis: the user action or effect that starts it, the frontend code on the way to the API call, how that call was matched to the backend route, the route's middleware chain, handler and the code it calls with their side effects, error paths, and what the frontend does after the response. Explain only what these facts show.

Rules:
- Never invent files, line numbers, symbols or behaviour. If something is not in the facts, say it is unknown or put it in "unresolved".
- Use these stages, in this order, and leave out any with no steps: "UI trigger" (the user action or effect and the handler code), "Request" (from the frontend call through the API client to the route registrations and body parsing), "Server" (middleware, validation, the handler and business logic), "Persistence" (database, cache and queue effects), "Response" (what the server sends back, including error statuses), "UI update" (what the frontend does with the response: state changes and callbacks).
- Follow ONLY the traced API call; other code in the component or endpoint matters only as far as this request uses it.
- Each step covers a contiguous group of lines in ONE file: "code_ref" is a file listed under "Files you may cite" and a start/end line inside code shown to you.
- "explanation": what the lines do and why, in plain English. Wrap every identifier and code expression in backticks, and only use identifiers that appear in the given code or facts.
- "example": invent ONE concrete user input at the first step and trace the same data through every step: form values -> request body -> req fields -> rows written -> response JSON -> UI state. "input" names what is in effect; "state_after" lists what changed. When a value depends on code you were not shown, say what it is assumed to be.
- "references": only file:line locations given in the facts, with role "caller", "callee" or "type". Use an empty list when none apply.
- "docs": only for calls into packages listed under "Packages". "package" is the package name exactly as listed and "symbol" is the API used. Never write URLs.
- "concepts": short names of general ideas a reader should know.
- "risks": what can go wrong at this step and what the user then sees in the UI, using the error paths given. Empty list if none.
- Step ids are unique, e.g. "s1", "s2".
- "unresolved": copy every note listed under "Unresolved", plus anything else you could not determine.`;

export function renderTracePrompt(ctx: TraceContext): string {
  const { link } = ctx;
  const comp = ctx.component.component.symbol;
  const route = `${ctx.endpoint.route.method} ${ctx.endpoint.route.fullPath}`;
  const trigger = link.call.triggers[0];
  const after = ctx.afterResponse.map((a) => `- \`${a.calleeText}\` at ${a.file}:${a.line}${a.callee ? ` (${a.callee})` : ''}`);
  return [
    `# Trace: ${trigger ? trigger.label : 'no trigger found'} in ${comp.name} → ${route}`,
    '## How the frontend reaches the backend',
    [
      `- trigger: ${trigger ? describeTrigger(trigger) : '(none found: explain the call without a user action)'}`,
      `- API call: ${link.call.method} ${link.call.urlPattern} (\`${link.call.urlText}\`) in ${link.call.symbol.name} (${link.call.symbol.file}:${link.call.line})`,
      `- matched to route ${route} by ${describeLink(link)}`,
    ].join('\n'),
    '## After the response, the calling function calls',
    after.length ? after.join('\n') : '(nothing found)',
    ...componentPromptSections(ctx.component),
    ...endpointPromptSections(ctx.endpoint),
    ...citeFiles(ctx.files),
    `Write the trace of ${link.call.method} ${link.call.urlPattern} from ${comp.name} to ${route} and back.`,
  ].join('\n\n');
}
```

In `core/src/llm/index.ts`, append: `export { renderTracePrompt, TRACE_SYSTEM_PROMPT } from './tracePrompt.js';`.

In `core/src/verify/verify.ts`, add `import type { TraceContext } from '../context/trace.js';` and, after `componentVerifyFacts`:

```ts
/** A trace may cite and name anything its component or endpoint context may. */
export function traceVerifyFacts(ctx: TraceContext): VerifyFacts {
  const front = componentVerifyFacts(ctx.component);
  const back = endpointVerifyFacts(ctx.endpoint);
  return { files: ctx.files, packages: new Set([...front.packages, ...back.packages]), vocabulary: new Set([...front.vocabulary, ...back.vocabulary]) };
}
```

- [ ] **Step 5: `explainTrace`**

Create `core/src/walkthrough/trace.ts` (Task 6 adds more):

```ts
import type { TraceContext } from '../context/trace.js';
import type { LlmProvider } from '../llm/generate.js';
import { renderTracePrompt, TRACE_SYSTEM_PROMPT } from '../llm/tracePrompt.js';
import { traceVerifyFacts } from '../verify/verify.js';
import { explainGrounded } from './explain.js';
import type { FnWalkthrough } from './fn.js';

// `walk trace` after the facts are gathered: LLM -> verifier -> docs links (CLAUDE.md §6.5, §8.3).

export async function explainTrace(provider: LlmProvider, ctx: TraceContext, repoRoot: string): Promise<FnWalkthrough> {
  const s = ctx.component.component.symbol;
  return explainGrounded(
    provider,
    {
      system: TRACE_SYSTEM_PROMPT,
      prompt: renderTracePrompt(ctx),
      facts: traceVerifyFacts(ctx),
      packages: ctx.packages,
      unresolved: ctx.unresolved.map((u) => u.note),
      scope: { file: s.file, start: s.startLine, end: s.endLine, symbol: ctx.scopeRef },
    },
    repoRoot,
  );
}
```

In `core/src/walkthrough/index.ts`, append `export { explainTrace } from './trace.js';`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run core/src/walkthrough core/src/verify`
Expected: PASS. If a step is dropped, read its reasons. Fix the recorded response only if it cites something that is really outside the context.

- [ ] **Step 7: Checkpoint**

Do not commit. Core typecheck is clean.

---

### Task 6: Sections, staleness, overview and Markdown for traces

**Files:**
- Modify: `core/src/walkthrough/saved.ts`, `core/src/walkthrough/staleness.ts`, `core/src/walkthrough/trace.ts`, `core/src/walkthrough/index.ts`, `core/src/render/markdown.ts`
- Test: `core/src/walkthrough/traceSection.test.ts`

**Interfaces:**
- Consumes: `componentBlocks`, `endpointBlocks`, `recordSection`, `reuseMultiBlockSection`; `traceDiagram`; `describeTrigger`, `describeLink`.
- Produces: `ScopeKind` adds `'trace'`; `TraceOverview`; `SavedWalkthrough.trace?`; `traceNotes(o)`; `traceBlocks(ctx): BlockRef[]`; `generateTraceSection(provider, ctx, repoRoot, { model, depth }): Promise<Section>`; `traceOverviewOf(ctx): TraceOverview`; `checkWalkthrough` applies `chains` to traces.

- [ ] **Step 1: Write the failing test**

Create `core/src/walkthrough/traceSection.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildTraceContext } from '../context/trace.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmProvider } from '../llm/generate.js';
import { renderMarkdown } from '../render/markdown.js';
import { openStore, type Store } from '../store/index.js';
import { reuseMultiBlockSection } from './endpoint.js';
import { codeReader } from './persist.js';
import { SAVED_VERSION, sourceFiles, traceNotes, type SavedWalkthrough, type Section } from './saved.js';
import { checkWalkthrough, filesOf, loadCurrentSource } from './staleness.js';
import { generateTraceSection, traceBlocks, traceOverviewOf } from './trace.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollTrace.response.json', import.meta.url), 'utf8');
const recorded: LlmProvider = { generate: async () => RECORDED };
const TARGET = { endpoint: { method: 'POST', path: '/api/patients/enroll' }, from: null };
const OPTIONS = { depth: 3, maxContextTokens: 60000 };

describe('trace sections and staleness', () => {
  let repo: string;
  let store: Store;
  let section: Section;

  const context = async () => {
    await indexRepo(repo, loadConfig(repo), store);
    return buildTraceContext(store, repo, TARGET, OPTIONS);
  };
  const edit = (file: string, from: string, to: string) => {
    const path = join(repo, file);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(from);
    writeFileSync(path, text.replace(from, to));
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-trace-sec-'));
    cpSync(FIXTURE, repo, { recursive: true });
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_trs_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    section = await generateTraceSection(recorded, await context(), repo, { model: 'recorded', depth: 3 });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('records the blocks of both stacks, the component first, and the trace hash', async () => {
    const ctx = await context();
    const names = section.blocks!.map((b) => b.symbol);
    expect(names[0]).toBe('EnrollForm');
    expect(names).toEqual(expect.arrayContaining(['useEnrollMutation', 'enrollHandler', 'enrollPatient', 'insertConsent']));
    expect(section.chainHash).toBe(ctx.traceHash);
  });

  it('builds the overview from the index', async () => {
    expect(traceNotes(traceOverviewOf(await context()))).toEqual(
      expect.arrayContaining([
        'Trace: web/components/EnrollForm.tsx#EnrollForm → POST /api/patients/enroll',
        'Trigger: onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate',
        'API call: POST /api/patients/enroll in useEnrollMutation.mutate (web/hooks/useEnrollMutation.ts:19) — exact match, confidence 1.0',
        'Server: express.json() → requireAuth → rateLimit → validate.validateBody → enrollHandler',
        'After the response: setStatus, onSuccess, setError',
      ]),
    );
  });

  it('reuses the section when lines move, without regenerating', async () => {
    edit('api/services/enrollService.ts', "import { pool } from '../db/pool';", "// Enrollment.\nimport { pool } from '../db/pool';");
    const ctx = await context();
    const reused = reuseMultiBlockSection(section, { blocks: traceBlocks(ctx), chainHash: ctx.traceHash }, sourceFiles(repo), 3);
    expect(reused).not.toBeNull();
    const persistence = reused!.walkthrough.stages.find((s) => s.name === 'Persistence')!.steps[0];
    expect(persistence.code_ref).toEqual({ file: 'api/services/enrollService.ts', start: 48, end: 59 });
    section = reused!;
  });

  it('marks the trace stale when a backend function deep in it changes; Markdown has the diagram', async () => {
    edit('api/repositories/patientRepository.ts', 'VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())');
    const ctx = await context();
    const saved: SavedWalkthrough = { version: SAVED_VERSION, scopeKind: 'trace', scopeRef: ctx.scopeRef, overview: null, trace: traceOverviewOf(ctx), sections: [section] };
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    const status = checkWalkthrough(saved, source, () => ctx.traceHash);
    expect(status.fresh).toBe(false);
    expect(status.sections[0].changedBlocks).toContain('insertConsent');
    expect(checkWalkthrough(saved, source, () => null).routeRemoved).toBe(true);

    const md = renderMarkdown(saved, codeReader(repo));
    expect(md).toContain('# How enrolling a patient works, from the Enroll button to the database');
    expect(md).toContain('## Trace');
    expect(md).toContain('```mermaid\nsequenceDiagram\n  actor User');
  });
});
```

Run: `pnpm vitest run core/src/walkthrough/traceSection.test.ts`
Expected: FAIL: `traceNotes`, `traceBlocks` etc. are not exported.

- [ ] **Step 2: Saved shape and notes**

In `core/src/walkthrough/saved.ts`:
1. `export type ScopeKind = 'fn' | 'file' | 'endpoint' | 'component' | 'trace';`
2. After `ComponentOverview`, add:

```ts
/** A full-stack trace's facts (CLAUDE.md §6.5), from the index alone; rebuilt on every run. */
export interface TraceOverview {
  method: string;
  path: string;
  /** "file#Component" that triggers the call. */
  component: string;
  /** describeTrigger of the first trigger, or a note that none was found. */
  trigger: string;
  /** "POST /api/patients/enroll in useEnrollMutation.mutate (web/hooks/useEnrollMutation.ts:19)". */
  call: string;
  /** describeLink: how the call was matched to the route. */
  link: string;
  /** Labels of the route's middleware chain and handler. */
  chain: string[];
  /** Calls made after the response, in order, each once. */
  afterResponse: string[];
  warnings: string[];
  /** Mermaid sequenceDiagram source. */
  diagram: string;
}
```

3. In `SavedWalkthrough`, extend the `scopeRef` comment with `, "METHOD /path <- file#Component" for trace`, and add after `component?`:

```ts
  /** Trace walkthroughs only. */
  trace?: TraceOverview;
```

4. After `componentNotes`, add:

```ts
/** The trace overview as plain lines, shared by the terminal, the stepper and Markdown. */
export function traceNotes(o: TraceOverview): string[] {
  return [
    `Trace: ${o.component} → ${o.method} ${o.path}`,
    `Trigger: ${o.trigger}`,
    `API call: ${o.call} — ${o.link}`,
    `Server: ${o.chain.join(' → ')}`,
    `After the response: ${o.afterResponse.join(', ') || 'nothing in the calling function'}`,
    ...o.warnings.map((w) => `Warning: ${w}`),
  ];
}
```

- [ ] **Step 3: Blocks, section and overview**

Append to `core/src/walkthrough/trace.ts` (extending its imports with `describeTrigger` from `../context/component.js`, `describeLink` from `../context/trace.js`, `traceDiagram` from `../render/mermaid.js`, `componentBlocks` from `./component.js`, `endpointBlocks` from `./endpoint.js`, `type BlockRef, type Section, type TraceOverview` from `./saved.js`, and `recordSection` from `./section.js`):

```ts
/** Every block either side explained, the component first; a block shared by both is listed once. */
export function traceBlocks(ctx: TraceContext): BlockRef[] {
  const blocks = new Map<string, BlockRef>();
  for (const b of [...componentBlocks(ctx.component), ...endpointBlocks(ctx.endpoint)]) {
    const key = `${b.file}:${b.start}-${b.end}`;
    if (!blocks.has(key)) blocks.set(key, b);
  }
  return [...blocks.values()];
}

export async function generateTraceSection(
  provider: LlmProvider,
  ctx: TraceContext,
  repoRoot: string,
  options: { model: string; depth: number },
): Promise<Section> {
  const walkthrough = await explainTrace(provider, ctx, repoRoot);
  const blocks = traceBlocks(ctx);
  return { ...recordSection(walkthrough, blocks[0], Object.keys(ctx.files), repoRoot, options), blocks, chainHash: ctx.traceHash };
}

export function traceOverviewOf(ctx: TraceContext): TraceOverview {
  const { call } = ctx.link;
  const trigger = call.triggers[0];
  return {
    method: ctx.endpoint.route.method,
    path: ctx.endpoint.route.fullPath,
    component: ctx.component.scopeRef,
    trigger: trigger ? describeTrigger(trigger) : 'no user action or effect found',
    call: `${call.method} ${call.urlPattern} in ${call.symbol.name} (${call.symbol.file}:${call.line})`,
    link: describeLink(ctx.link),
    chain: ctx.endpoint.chain.map((n) => n.label),
    afterResponse: [...new Set(ctx.afterResponse.map((a) => a.calleeText))],
    warnings: ctx.warnings,
    diagram: traceDiagram(ctx),
  };
}
```

In `core/src/walkthrough/index.ts`, replace the trace export with `export { explainTrace, generateTraceSection, traceBlocks, traceOverviewOf } from './trace.js';`.

- [ ] **Step 4: Staleness and Markdown**

In `core/src/walkthrough/staleness.ts`, change the `structural` line to:

```ts
  const structural = saved.scopeKind === 'endpoint' || saved.scopeKind === 'component' || saved.scopeKind === 'trace';
```

and update the `chainChanged` / `routeRemoved` doc comments to add: `Trace: the component, chain or link changed.` / `Trace: the route, component or link is gone.`

In `core/src/render/markdown.ts`, import `traceNotes`, and add a branch before the final `else`:

```ts
  } else if (saved.scopeKind === 'trace') {
    const w = saved.sections[0].walkthrough;
    const t = saved.trace!;
    out.push(`# ${w.title}`, '', `\`${saved.scopeRef}\``, '', w.summary, '', '## Trace', '', ...traceNotes(t).map((n) => `- ${n}`));
    out.push('', '## Sequence', '', '```mermaid', t.diagram, '```');
    renderStages(out, w, 2, codeLines);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run core/src`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Do not commit. `pnpm typecheck` is clean.

---

### Task 7: CLI `walk trace` with the pin flow, `walk list`, formatters

**Files:**
- Create: `cli/src/commands/trace.ts`
- Modify: `cli/src/index.ts`, `cli/src/commands/list.ts`, `cli/src/ui/format.ts`, `cli/src/ui/output.ts`
- Test: `cli/src/commands/trace.test.ts`

**Interfaces:**
- Consumes: `buildTraceContext`, `PinNeededError`, `pinFor`, `describeLink`, `currentTraceHash`, `traceBlocks`, `generateTraceSection`, `traceOverviewOf`, `traceNotes`, `traceDiagram`, `addPinnedEdge`, `loadConfig`, `parseEndpointTarget`, `parseComponentTarget`.
- Produces: `runTrace(cwd, routeArg, options: TraceOptions, io, deps?: TraceDeps): Promise<number>`, with `TraceOptions = { llm: boolean; depth: number; out: OutFormat; refresh: boolean; from?: string; pin?: number }` and `TraceDeps = { provider?: LlmProvider; interactive?: boolean; ask?: (question: string) => Promise<string> }`; `formatTraceFacts(ctx: TraceContext): string`.

- [ ] **Step 1: Write the failing test**

Create `cli/src/commands/trace.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, openStore, type LlmProvider } from '@codewalk/core';
import { runList } from './list.js';
import { runTrace, type TraceOptions } from './trace.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../../../core/src/llm/__fixtures__/enrollTrace.response.json', import.meta.url), 'utf8');
const TARGET = 'POST /api/patients/enroll';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) }, out, err };
}

let generated = 0;
const recorded: LlmProvider = {
  generate: async () => {
    generated++;
    return RECORDED;
  },
};
const opts = (o: Partial<TraceOptions> = {}): TraceOptions => ({ llm: true, depth: 3, out: 'terminal', refresh: false, ...o });

function fixtureCopy(tag: string) {
  const repo = mkdtempSync(join(tmpdir(), `cw-trace-${tag}-`));
  cpSync(FIXTURE, repo, { recursive: true });
  const schema = `cw_test_${tag}_${Math.random().toString(16).slice(2, 10)}`;
  const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
  writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  return {
    repo,
    async cleanup() {
      const store = await openStore({ url: DATABASE_URL, schema });
      await store.dropSchema();
      await store.close();
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

describe('walk trace', () => {
  let copy: ReturnType<typeof fixtureCopy>;
  beforeAll(() => {
    copy = fixtureCopy('trcli');
  });
  afterAll(() => copy.cleanup());

  it('--no-llm prints the click-to-database trace (Phase 5 acceptance)', async () => {
    const { io, out } = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts({ llm: false }), io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('trace POST /api/patients/enroll ← web/components/EnrollForm.tsx#EnrollForm');
    expect(text).toContain('  onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate');
    expect(text).toContain('  POST /api/patients/enroll  useEnrollMutation.mutate web/hooks/useEnrollMutation.ts:19  (exact match, confidence 1.0)');
    expect(text).toContain('  5. enrollHandler [handler]');
    expect(text).toContain('db_write INSERT consents');
    expect(text).toContain('  setStatus  web/hooks/useEnrollMutation.ts:20');
    expect(text).toContain('  User->>C: onSubmit on <form>');
  });

  it('explains, saves, and reuses the trace; walk list marks it stale after a deep backend change', async () => {
    const first = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts(), first.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(first.err.join('\n')).toContain('Saved .walkthrough/walkthroughs/trace--');

    const second = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts({ out: 'md' }), second.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(second.out.join('\n')).toContain('```mermaid');

    const path = join(copy.repo, 'api/repositories/patientRepository.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())'));
    const list = captureIO();
    expect(await runList(copy.repo, { out: 'terminal' }, list.io)).toBe(0);
    expect(list.out.join('\n')).toMatch(/stale {2}trace {2}POST \/api\/patients\/enroll <- web\/components\/EnrollForm\.tsx#EnrollForm .*insertConsent/);
  });
});

describe('walk trace: pinning a loose match', () => {
  let copy: ReturnType<typeof fixtureCopy>;
  beforeAll(() => {
    copy = fixtureCopy('trpin');
    const hook = join(copy.repo, 'web/hooks/useEnrollMutation.ts');
    writeFileSync(hook, readFileSync(hook, 'utf8').replace("'/api/patients/enroll'", "'/patients/enroll'"));
  });
  afterAll(() => copy.cleanup());

  it('a non-interactive run lists the candidates and the --pin command, without prompting', async () => {
    const { io, err } = captureIO();
    let asked = false;
    expect(await runTrace(copy.repo, TARGET, opts({ llm: false }), io, { interactive: false, ask: async () => ((asked = true), '1') })).toBe(1);
    expect(asked).toBe(false);
    expect(err.join('\n')).toContain('[1] POST /patients/enroll in useEnrollMutation.mutate (web/hooks/useEnrollMutation.ts:19): suffix match (0.6)');
    expect(err.join('\n')).toContain('Pin one with: walk trace "POST /api/patients/enroll" --pin <n>');
  });

  it('rejects a --pin outside the list', async () => {
    const { io, err } = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts({ llm: false, pin: 9 }), io, { interactive: false })).toBe(1);
    expect(err.join('\n')).toContain('--pin 9 is not one of the 1 candidates');
  });

  it('an interactive answer pins the call in config, and later runs follow the pin', async () => {
    const first = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts({ llm: false }), first.io, { interactive: true, ask: async () => '1' })).toBe(0);
    expect(first.out.join('\n')).toContain('(pinned in .walkthrough/config.json)');
    expect(JSON.parse(readFileSync(join(copy.repo, CONFIG_FILE), 'utf8')).pinnedEdges).toEqual([
      { caller: 'web/hooks/useEnrollMutation.ts#useEnrollMutation.mutate', method: 'POST', url: '/patients/enroll', route: 'POST /api/patients/enroll' },
    ]);

    const again = captureIO();
    expect(await runTrace(copy.repo, TARGET, opts({ llm: false }), again.io, { interactive: false })).toBe(0);
  });
});
```

Run: `pnpm vitest run cli/src/commands/trace.test.ts`
Expected: FAIL: cannot resolve `./trace.js`.

- [ ] **Step 2: The command**

Create `cli/src/commands/trace.ts`:

```ts
import { createInterface } from 'node:readline/promises';
import {
  addPinnedEdge,
  AnthropicProvider,
  buildTraceContext,
  generateTraceSection,
  indexRepo,
  loadConfig,
  loadSavedWalkthrough,
  parseComponentTarget,
  parseEndpointTarget,
  persistWalkthrough,
  PinNeededError,
  pinFor,
  reuseMultiBlockSection,
  SAVED_VERSION,
  sourceFiles,
  traceBlocks,
  traceOverviewOf,
  type LlmProvider,
  type SavedWalkthrough,
  type TraceContext,
  type TraceTarget,
  type WalkConfig,
} from '@codewalk/core';
import { formatTraceFacts } from '../ui/format.js';
import { printWalkthrough, type OutFormat } from '../ui/output.js';
import { connectStore, loadRepo, reportError, type IO } from './shared.js';

export interface TraceOptions {
  /** False with --no-llm: print only the static facts. */
  llm: boolean;
  depth: number;
  out: OutFormat;
  /** Ignore the saved walkthrough and regenerate (--refresh). */
  refresh: boolean;
  /** --from <file>[#<Component>]: which caller to trace. */
  from?: string;
  /** --pin <n>: pin loose candidate n (1-based) to the route. */
  pin?: number;
}

export interface TraceDeps {
  provider?: LlmProvider;
  /** Use the Ink stepper and allow prompts; defaults to true when stdin and stdout are terminals. */
  interactive?: boolean;
  /** Asks the user a question (tests inject answers); defaults to a readline prompt. */
  ask?: (question: string) => Promise<string>;
}

/** `walk trace "<METHOD> <path>"`. Returns an exit code. */
export async function runTrace(cwd: string, routeArg: string, options: TraceOptions, io: IO, deps: TraceDeps = {}): Promise<number> {
  let target: TraceTarget;
  try {
    target = { endpoint: parseEndpointTarget(routeArg), from: options.from ? parseComponentTarget(options.from) : null };
  } catch (err) {
    return reportError(err, io);
  }

  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  let saved: SavedWalkthrough;
  try {
    await store.migrate();
    const index = async (config: WalkConfig) => {
      const result = await indexRepo(repo.repoRoot, config, store);
      for (const warning of result.warnings) io.error(`! ${warning}`);
    };
    const build = () => buildTraceContext(store, repo.repoRoot, target, { depth: options.depth, maxContextTokens: repo.config.llm.maxContextTokens });

    await index(repo.config);
    let ctx: TraceContext;
    try {
      ctx = await build();
    } catch (err) {
      if (!(err instanceof PinNeededError)) throw err;
      const choice = options.pin ?? (interactive ? await askForPin(err, deps.ask ?? terminalAsk, io) : null);
      const candidate = choice === null ? undefined : err.candidates[choice - 1];
      if (!candidate) {
        if (choice !== null) io.error(`✖ --pin ${choice} is not one of the ${err.candidates.length} candidates.`);
        io.error(`✖ ${err.message}`);
        io.error(`  Pin one with: walk trace "${err.route.method} ${err.route.fullPath}" --pin <n>`);
        return 1;
      }
      addPinnedEdge(repo.repoRoot, pinFor(candidate, err.route));
      io.error(`Pinned ${candidate.apiCall.method} ${candidate.apiCall.urlPattern} in ${candidate.apiCall.caller.name} to ${err.route.method} ${err.route.fullPath} (.walkthrough/config.json).`);
      await index(loadConfig(repo.repoRoot));
      ctx = await build();
    }
    for (const warning of ctx.warnings) io.error(`! ${warning}`);

    if (!options.llm) {
      io.log(options.out === 'json' ? JSON.stringify(ctx, null, 2) : formatTraceFacts(ctx));
      return 0;
    }

    const previous = options.refresh ? null : await loadSavedWalkthrough(store, 'trace', ctx.scopeRef);
    const current = { blocks: traceBlocks(ctx), chainHash: ctx.traceHash };
    let section = previous && reuseMultiBlockSection(previous.sections[0], current, sourceFiles(repo.repoRoot), options.depth);
    if (section) {
      io.error(`Code unchanged since ${section.generatedAt}: showing the saved walkthrough (--refresh to regenerate).`);
    } else {
      io.error(`Explaining ${ctx.scopeRef} with ${repo.config.llm.model}…`);
      const provider = deps.provider ?? new AnthropicProvider(repo.config.llm.model);
      section = await generateTraceSection(provider, ctx, repo.repoRoot, { model: repo.config.llm.model, depth: options.depth });
    }
    saved = { version: SAVED_VERSION, scopeKind: 'trace', scopeRef: ctx.scopeRef, overview: null, trace: traceOverviewOf(ctx), sections: [section] };
    const paths = await persistWalkthrough(store, repo.repoRoot, saved);
    io.error(`Saved ${paths.markdown}`);
  } catch (err) {
    return reportError(err, io);
  } finally {
    await store.close();
  }

  await printWalkthrough(saved, options.out, repo.repoRoot, io, interactive);
  return 0;
}

/** Lists the candidates and asks for one; null when the user cancels or answers something else. */
async function askForPin(err: PinNeededError, ask: (question: string) => Promise<string>, io: IO): Promise<number | null> {
  io.error(err.message);
  const answer = (await ask(`Pin which call to ${err.route.method} ${err.route.fullPath}? [1-${err.candidates.length}, Enter to cancel] `)).trim();
  const n = Number(answer);
  return answer !== '' && Number.isInteger(n) ? n : null;
}

async function terminalAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
```

In `cli/src/index.ts`, import `runTrace, type TraceOptions` from `./commands/trace.js` and register it after `component`:

```ts
program
  .command('trace')
  .description('full-stack trace: the UI action that calls an endpoint, the request through the server to the database, and back')
  .argument('<route>', 'e.g. "POST /api/patients/enroll"')
  .option('--from <component>', 'which calling component to trace, e.g. web/components/EnrollForm.tsx#EnrollForm')
  .option('--pin <n>', 'pin loose candidate <n> to this route (saved in .walkthrough/config.json)', parseDepth)
  .option('--no-llm', 'print only the static facts')
  .option('--depth <n>', 'how many levels of calls to include on each side', parseDepth, 3)
  .option('--refresh', 'ignore the saved walkthrough and regenerate', false)
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json', 'md']).default('terminal'))
  .action(async (route: string, opts: TraceOptions) => {
    process.exitCode = await runTrace(process.cwd(), route, opts, io);
  });
```

- [ ] **Step 3: Formatters, output and list**

In `cli/src/ui/format.ts`, add `describeLink`, `traceDiagram` and `type TraceContext` to the `@codewalk/core` import, and add after `formatComponentFacts`:

```ts
export function formatTraceFacts(ctx: TraceContext): string {
  const { link } = ctx;
  const route = ctx.endpoint.route;
  const out = [`trace ${route.method} ${route.fullPath} ← ${ctx.component.scopeRef}`];
  section(out, 'Trigger', link.call.triggers.length ? link.call.triggers.map(describeTrigger) : ['no user action or effect found']);
  section(out, 'API call', [`${link.call.method} ${link.call.urlPattern}  ${link.call.symbol.name} ${link.call.symbol.file}:${link.call.line}  (${describeLink(link)})`]);
  section(out, 'Middleware chain', ctx.endpoint.chain.map((n, i) => `${i + 1}. ${n.label} [${n.phase}]`));
  section(out, 'Side effects', ctx.endpoint.sideEffects.map((e) => `${e.kind} ${e.detail}  (${e.symbol.name} ${e.symbol.file}:${e.line})`));
  section(out, 'Error paths', ctx.endpoint.errorPaths.map((p) => `${p.error}${p.status !== null ? ` → ${p.status}` : ''}  (${p.symbol.name} ${p.symbol.file}:${p.line})`));
  section(out, 'After the response', ctx.afterResponse.map((a) => `${a.calleeText}  ${a.file}:${a.line}`));
  section(out, 'Unresolved', ctx.unresolved.map((u) => u.note));
  section(out, 'Not expanded', ctx.component.limits);
  section(out, 'Warnings', ctx.warnings);
  section(out, 'Sequence diagram (Mermaid)', traceDiagram(ctx).split('\n'));
  return out.join('\n');
}
```

In the same file, update the empty-list message to ``'No saved walkthroughs yet. Run `walk fn`, `walk file`, `walk endpoint`, `walk component` or `walk trace` to create one.'``. In `staleDetail`, handle traces:

```ts
  if (s.routeRemoved) parts.push(kind === 'component' ? 'component removed' : kind === 'trace' ? 'trace removed' : 'route removed');
  if (s.chainChanged) parts.push(kind === 'component' ? 'structure changed' : kind === 'trace' ? 'trace changed' : 'middleware chain changed');
```

Update `cli/src/commands/list.test.ts`'s expected empty-list message to match the new text.

In `cli/src/ui/output.ts`, import `traceNotes`; extend the `notes` chain with `: saved.trace ? traceNotes(saved.trace)` before the final `: []`, and add `trace: saved.trace ?? null` to the JSON object.

In `cli/src/commands/list.ts`, import `currentTraceHash`, and inside the `chains` loop add:

```ts
      if (saved.scopeKind === 'trace') {
        chains.set(saved.scopeRef, await currentTraceHash(store, repo.repoRoot, saved.scopeRef, saved.sections[0]?.depth ?? 3));
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run cli/src`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `pnpm test && pnpm typecheck`
Expected: every test passes and typecheck is clean.

Manual check (no LLM needed):

```bash
cd fixture && ../node_modules/.bin/tsx ../cli/src/index.ts trace "POST /api/patients/enroll" --no-llm
```

Expected: the facts from Step 1, ending with the Mermaid diagram.

- [ ] **Step 6: Checkpoint (end of Phase 5)**

Do not commit. Stop for review (CLAUDE.md §12, §15): report the test counts against the baseline and paste the `--no-llm` output.

---

## Self-review notes

- **Spec coverage:** §1 → Tasks 1–2; §2–3 → Task 3; §4 → Task 4; §5 → Task 5; §6 → Task 6; §7 → Task 7; §8 is spread across all tasks.
- **Type consistency:** `CrossEdgeRecord.apiCall.caller` is a full `SymbolRecord` everywhere. The link key (caller file#name, method, URL, match, pinned) is built only by `traceHashOf`, which both the builder and `currentTraceHash` use. `reuseMultiBlockSection` serves endpoint, component and trace sections.
- **Known limits, stated in output:** one caller per trace; calls more than 8 hops above the component are not found (the error says so); the response status comes from the code the LLM sees, not from a static fact.
