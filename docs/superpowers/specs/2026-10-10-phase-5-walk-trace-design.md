# Phase 5: `walk trace` Design

**Spec:** `CLAUDE.md` §6.5 (full-stack trace), §8.1 (`cross_edges`), §8.1a, §9, §10 (`pinnedEdges`), §12 Phase 5, §13.

**Goal:** `walk trace "POST /api/patients/enroll"` explains one request end to end, grounded in static facts: the user action in the component that calls it, the frontend path to the API call, the route it matches, the middleware chain, handler, services and database writes, the response, and what the frontend does with it. It has one combined Mermaid diagram and one LLM narrative that traces a single example from click to database and back.

**Acceptance (CLAUDE.md §12):** on the fixture, `walk trace "POST /api/patients/enroll"` renders the click-to-database trace end to end:

```
onSubmit on <form> → EnrollForm.handleSubmit → useEnrollMutation.mutate → POST /api/patients/enroll
  → express.json → requireAuth → rateLimit → validate.validateBody → enrollHandler → enrollPatient
  → INSERT patients, INSERT consents → response → setStatus, onSuccess
```

## Decisions (approved)

1. **One combined narrative, one LLM call.** The stages are fixed: "UI trigger" → "Request" → "Server" → "Persistence" → "Response" → "UI update", and empty stages are omitted. One example (the user's input → request body → rows written → response JSON → UI state) is traced through every stage. The component and endpoint contexts each get half of `maxContextTokens`.
2. **Pinning: prompt in a TTY, flag otherwise.** When a route has no confirmed caller but some calls match it loosely, an interactive run lists them and asks which one to pin. The answer is written to `pinnedEdges` in `.walkthrough/config.json`. A non-interactive run exits 1, listing the candidates and the exact `walk trace "<METHOD> <path>" --pin <n>` command.
3. **One caller per trace.** If several components reach the route's call(s), the command exits 1, listing them and asking for `--from <file>#<Component>`.
4. **Exact first, suffix as fallback.** Exact method + pattern matches are confident. A route whose path ends with the call's pattern (the call is `/patients/:id`, the route is `/api/patients/:id`) is only a loose candidate and must be pinned before it can be traced. No new config.

## 1. Matching API calls to routes (`core/src/routes/crossEdges.ts`, pure)

Segments are compared pairwise. A route param (`:id`, `*`) matches a call param or a literal. A call param matches only a route param. A literal matches only an equal literal.

| match | when | confidence |
|---|---|---|
| `exact` | same method, same length, every segment literal = literal or param = param | 1.0 |
| `param` | as exact, but some route param stands for a call literal (`/patients/:id` ← `/patients/42`) | 0.9 |
| `suffix` | same method, the route's last *k* segments match the call's *k* segments (route is longer) | 0.6 |
| `method` | the call's method is `UNKNOWN` and the path matches any of the above | min(·, 0.5) |
| `pinned` | a `pinnedEdges` entry names this call and route | 1.0 |

A route registered with `ALL` loses 0.05, so a specific method wins.

A call is **resolved** to a route when it has a pin, or when its best candidate has confidence ≥ 0.9 and is strictly better than the next one. Every candidate is stored in `cross_edges`, with `match`, `confidence`, `pinned` and `resolved`.

**Pins** (`pinnedEdges`): `{ "caller": "<file>#<function>", "method": "POST", "url": "/patients/enroll", "route": "POST /api/patients/enroll" }`. A pin is keyed by the calling function, method and URL pattern, so it survives line moves. A pin whose call or route no longer exists produces an index warning and is ignored.

`cross_edges` is rebuilt on **every** index pass, because pins live in config, not in files. The rebuild is in-memory matching of all API calls against all routes, then one transactional replace.

**Migration:** `cross_edges.confidence` becomes `double precision`, so 0.9 reads back as 0.9. It also gains `match TEXT` and `resolved BOOLEAN`.

## 2. Trace target and caller

`walk trace "<METHOD> <path>" [--from <file>[#<Component>]] [--pin <n>]`.

1. The route is found as `walk endpoint` finds it (a concrete path matches its pattern).
2. **Resolved edges** to the route select the frontend calls. If there are none:
   - if loose candidates exist (calls with no resolved edge anywhere), raise `PinNeededError` with them (Decision 2);
   - otherwise fail with a message pointing at `apiClientWrappers`.
3. **Components reaching each call:** walk up from the calling function, breadth-first, at most 8 hops:
   - its callers (`calls`),
   - components whose handler bindings name it (`onClick={logout}`),
   - the component whose body encloses it (`EnrollForm.handleSubmit` → `EnrollForm`).
4. **Choose a caller:** use `--from` when given; otherwise the single caller; otherwise fail and list them (Decision 3).
5. Build the component context and the endpoint context (each with half the budget, same `--depth`). The linked call must appear in the component's API calls; otherwise fail and suggest a larger `--depth`.

## 3. Trace context (`core/src/context/trace.ts`)

`TraceContext` contains:
- `component`: a `ComponentContext`.
- `endpoint`: an `EndpointContext`.
- `link`: the component's API call (with triggers), plus `match`, `confidence` and `pinned`.
- `afterResponse`: calls the calling function makes after the request line, e.g. `setStatus`, `onSuccess`.
- `files`, `packages`, `unresolved`, `warnings`: merged from both contexts.
- `scopeRef` = `"<METHOD> <full path> <- <file>#<Component>"`.
- `traceHash` = hash of (component structure hash, endpoint chain hash, link key). Warnings also list the loose candidates that weren't traced.

`currentTraceHash(store, repoRoot, scopeRef, depth)` recomputes the hash from the index alone (DB-only, like Phase 4's `currentStructureHash`); it is null when the route, component or link is gone.

## 4. Diagram (`traceDiagram`, static facts only)

`actor User` → the component → the frontend files on the trigger path → the endpoint's diagram. Its `Client` participant is replaced by the frontend participant that makes the call, so the response and error statuses return to the frontend. A closing `Note over <caller>: then setStatus(), onSuccess(), …` comes from `afterResponse`. An effect trigger starts with `Note over <component>: useEffect [id] in usePatient` instead of a `User` message.

## 5. LLM and verifier

- Schema §8.2, unchanged.
- The trace prompt = the link section + the component prompt sections + the endpoint prompt sections + the merged "Files you may cite" + the instruction. The prompt renderers are split into a `…PromptSections` part and a files/instruction tail, with no change to their output.
- `traceVerifyFacts` is the union of the component and endpoint verify facts, with the merged files.

## 6. Persistence and staleness

- `ScopeKind` adds `'trace'`.
- `SavedWalkthrough.trace?: TraceOverview` holds the trigger, call, link, server chain, after-response, warnings and diagram. `traceNotes(o)` renders it.
- One section, whose `blocks` are the union of the component and endpoint blocks (component first), with `chainHash = traceHash`. It is reused through `reuseMultiBlockSection`.
- `checkWalkthrough` applies `chains` to traces. `walk list` uses `currentTraceHash` and shows `trace changed` / `trace removed`.

## 7. CLI

`walk trace "<METHOD> <path>" [--from …] [--pin <n>] [--no-llm] [--out md|json|terminal] [--depth <n>] [--refresh]`, with default depth 3.

`--no-llm` prints the trigger, API call + link, middleware chain, side effects, error paths, after-response, unresolved, limits, warnings and the Mermaid source. Otherwise it reuses or generates, saves, and shows the stepper, like the other commands.

`walk index` prints pin warnings. In tests, the pin prompt is injected (`ask`), and it is never used when stdin/stdout are not TTYs.

## 8. Testing

- **Pure:** every row of the §1 table, ALL vs a specific method, literal vs param priority, pins (override, stale route, stale call).
- **Config:** pin schema; `addPinnedEdge` replaces a pin with the same caller/method/url and keeps other config fields.
- **Store/indexer (real Postgres):** migration; fixture edges are exact and resolved; `getHandlerOwners`; pins override and warn.
- **Context (fixture plus temp copies):** acceptance facts for `POST /api/patients/enroll`; `GET /api/patients/42` → `PatientSummary` via the effect; two callers → `--from`; a suffix-only URL → `PinNeededError`, then pin → `pinned`; `currentTraceHash` equals `traceHash`.
- **Diagram:** user → component → hook file → chain → Postgres → response to the hook → after-response note; the effect variant.
- **LLM (recorded):** six stages in order, every step verified.
- **Staleness:** editing `insertConsent` marks the trace stale; moving lines reuses it.
- **CLI:** `--no-llm` acceptance output; the pin flow (non-TTY exit with command, invalid `--pin`, prompt → config written → later runs need no pin); explain + save + reuse; `walk list` stale.

## Out of scope

Tracing from a component (`walk trace` starts from a route, per §5), several callers in one trace, response status inference beyond what the code shows, GraphQL/WebSocket calls, `walk serve`.
