# Phase 3: `walk endpoint` Design

**Spec:** `CLAUDE.md` §6.3 (endpoint mode), §8.1 (`routes`, `middleware`, `side_effects`), §8.1a (store interface, recursive CTEs), §9 (staleness), §12 Phase 3, §13 (unresolved edges).

**Goal:** `walk endpoint "POST /api/patients/enroll"` explains one Express endpoint end to end, grounded in static facts: the full path resolved through `app.use` mounts, the middleware chain in execution order, handler → service → data-layer calls, side effects tagged per node, error paths, and a Mermaid sequence diagram, with one LLM narrative tracing a single example payload through fixed stages.

**Acceptance (CLAUDE.md §12):** the fixture's nested-router endpoint `POST /api/patients/enroll` resolves to the correct full path, with the correct middleware order and tagged side effects.

## Decisions (approved)

1. **One narrative, one LLM call per endpoint.** Stages are fixed: request → middleware → validation → business logic → persistence → response (empty ones omitted). One example payload threads through every stage. A change to any explained block regenerates the whole walkthrough; per-step staleness still reports which steps changed.
2. **Inline arrow handlers become `route_handler` symbols** so they can be cited, called from, and tagged with side effects.
3. **The Mermaid diagram is generated from static facts**, never by the LLM.
4. **knex and prisma detection ships now**, tested with snippets (the fixture uses raw `pg`).
5. **Express only.** Fastify, Koa and Nest are out of scope.

## 1. Indexing routes

Mounts span files (`api/app.ts` → `api/routes/index.ts` → `api/routes/patients.ts`), so route indexing has two layers.

### 1.1 Per-file router facts (incremental)

Extracted with the other per-file facts, only for changed files (and refreshed with the same importer/caller rules), into a new table:

```
router_calls(id, file_id, receiver_key, receiver_kind, receiver_text, call_kind, method, path, path_text, line, end_line, order_idx, handlers JSONB)
  -- receiver_key: "<file>#<name>" of the app/router variable the call is made on; NULL when the receiver is an
  --               Express value that isn't a router declared in the repo (e.g. a parameter typed Express)
  -- receiver_kind: app | router            (declared via express() vs Router()/express.Router())
  -- call_kind: use | route                 (route = .get/.post/.put/.patch/.delete/.options/.head/.all, incl. .route(p).get(...))
  -- method: GET|POST|... ; NULL for use, ALL for .all
  -- path: string literal, or NULL (no path arg = "/"); path_text holds the source of a non-literal path
  -- line / end_line: the registration call's lines
  -- order_idx: registration order within the file
  -- handlers: ordered list of handler args (below), each with its source text
```

A router declaration is a variable initialised with `express()`, `Router()` or `express.Router()` (origin traced to the `express` package by the existing logic in `indexer/calls.ts`). Each handler argument (arrays flattened in order) is classified as one of:

| class | example | stored |
|---|---|---|
| `symbol` | `requireAuth` | symbol key; `arity` (parameter count) |
| `factory` | `validate(enrollSchema)` | factory symbol key + returned-function symbol key when the factory returns exactly one function (`validate.validateBody`); else `unresolved` |
| `router` | `apiRouter` | receiver key of the mounted router |
| `package` | `express.json()` | label (callee text) + package name |
| `inline` | `(req, res) => …` | key of the new `route_handler` symbol |
| `unresolved` | `handlers[x]`, values of unknown origin | callee text + note |

Inline handlers are registered by `collectSymbols` as kind `route_handler`, named `<receiver>.<method> <path>` (e.g. `patientsRouter.get /:id`); `use` inline handlers are named `<receiver>.use`. Calls inside them are attributed to that symbol as for any function.

### 1.2 Stitching (whole repo, cheap)

After `applyIndexChanges`, in the same transaction, the store rebuilds `routes` and `middleware` from all `router_calls` rows. Stitching is pure TypeScript over stored facts (`core/src/routes/stitch.ts`); it never re-parses source. Stitching runs only when at least one file changed.

Algorithm:

1. Roots are `app` receivers. Walk `use` calls whose handlers include a `router` arg to build the mount tree; each mount records `{file, line, prefix}` in `mount_chain`. Cycles are cut and reported as warnings.
2. For each `route` call reached, `full_path` = joined prefixes + route path, normalised (single slashes, no trailing slash except `/`).
3. **Middleware order** follows Express semantics. For the chain root → … → route's router, in order, for each router take its `use` calls with `order_idx` lower than the call that leads onward (the next mount, or the route itself) and whose path prefix matches the remaining path. Non-error handlers in those calls are appended in argument order. The route's own handlers come next; the last one is the `handler_symbol_id`, the earlier ones are `phase = route` middleware.
4. **Error handlers:** handlers with `arity = 4` in `use` calls anywhere on the chain (before or after the route) are recorded with `phase = error`, in registration order.
5. A route reached through a non-literal path keeps the literal parts and is stored with `full_path` containing `*` and a warning; it is matched only by exact string.

### 1.3 Migration

- New table `router_calls` (above), index on `file_id` and `receiver_key`.
- `middleware` gains `label TEXT NOT NULL`, `phase TEXT NOT NULL CHECK (phase IN ('app','router','route','error'))`, `file TEXT NOT NULL`, `line INTEGER NOT NULL`, `end_line INTEGER NOT NULL`, `unresolved_note TEXT`.
- `routes` gains `handler_label TEXT NOT NULL`, `file TEXT NOT NULL`, `line INTEGER NOT NULL`, `end_line INTEGER NOT NULL`, `warnings JSONB NOT NULL DEFAULT '[]'`.
- New table `route_warnings(message TEXT NOT NULL)`: registrations stitching couldn't place (unattached receivers, never-mounted routers, mount loops).

## 2. Side-effect tagging

Per file, per enclosing symbol, written to `side_effects` with the other file facts (`core/src/indexer/sideEffects.ts`). Package origin uses the existing origin tracing.

| kind | detected from | detail |
|---|---|---|
| `db_read` / `db_write` | `.query(sql, …)` on a value from `pg`; SQL from a string/template literal, or a `const` with one. Leading verb: `SELECT` → read (tables from `FROM`/`JOIN`); `INSERT INTO` / `UPDATE` / `DELETE FROM` → write. `BEGIN/COMMIT/ROLLBACK` are skipped. knex: `knex('t').select|first|where… → read`, `.insert|update|del|delete → write`. prisma: `prisma.<model>.find*|count|aggregate → read`, `create*|update*|upsert|delete* → write`. | `SELECT patients`, `INSERT consents` |
| `redis` | method calls on a value from `ioredis` or `redis` | command + key text, e.g. `GET session:${token}` |
| `http_out` | `fetch`, `axios` / `axios.<verb>`, `got`, `http(s).request` | method (from the verb or a literal `method` option, default GET) + URL text |
| `queue` | `.emit` on a `node:events` EventEmitter value; bullmq `queue.add`; amqplib `publish` / `sendToQueue` | `emit patient.enrolled (in-process)` |
| `throws` | `throw new X(…)` and `next(new X(…))` | class name + HTTP status when resolvable through the class's `super(<literal>, …)` chain, e.g. `ConflictError (409)` |

Anything not matching is left untagged. The `line` is the call/throw line.

## 3. Endpoint context (`core/src/context/endpoint.ts`)

Input: `"<METHOD> <path>"`. Matching: exact `method + full_path` first; else a concrete path matches a pattern segment-by-segment (`:param` matches one segment). `ALL` routes match any method. No match → `TargetError` listing up to 5 routes with the closest paths. Several matches → `TargetError` listing them.

`EndpointContext` contains:

- `route`: method, full path, mount chain (`file:line` + prefix each), warnings.
- `chain`: ordered nodes `{phase, label, symbol | null, file, line, code}`, ending with the handler. Package middleware has no code.
- `errorHandlers`: same shape, `phase = error`.
- `callees`: per chain node, transitive repo callees up to `--depth` via one recursive store query per node (`getCallees`), with code bodies for direct callees as in `walk fn`.
- `sideEffects`: per symbol in the chain or its callees, from `side_effects`.
- `errorPaths`: every `throws` reached, with the node that throws it and the status; untyped `throw` / `next(err)` noted as "status decided by errorHandler".
- `unresolved`: every unresolved call reached (e.g. `bus.emit` → `dispatch`), same notes as `walk fn`.
- `registrations`: the source lines of every mount, middleware and route registration, adjacent lines merged into one block.
- `packages`, `files`, `omitted`, `warnings`: as in `FnContext`. (No separate types/values sections: the code blocks already carry them, and YAGNI.)
- `scopeRef` (`"<METHOD> <full_path>"` of the matched route) and `chainHash`.

Code is included within `maxContextTokens` using `estimateTokens`; each symbol's body is included once. Dropped bodies are listed in `omitted` (deeper callees first, then error handlers, then chain nodes last).

**Diagram** (`core/src/render/mermaid.ts`): a Mermaid `sequenceDiagram` from the context alone. Participants: `Client`, each chain node, each repo callee module (by file), `Postgres`, `Redis`, external hosts (`http_out`), `Events` (`queue`). Messages follow chain order then call order (by line); side effects become messages to their store; error paths become `alt` blocks returning the status to `Client`.

## 4. LLM and verifier

- **Schema:** the §8.2 zod schema, unchanged.
- **Prompt** (`core/src/llm/endpointPrompt.ts`): a system prompt for endpoints plus a renderer for `EndpointContext`. Stage names are fixed and ordered (request, middleware, validation, business logic, persistence, response); empty stages are omitted. Steps follow the chain's execution order; `code_ref` may point into any file in the context. One example request (method, path, headers, body) is traced through every stage; `state_after` shows `req`/`res`/local state. Error branches go in `risks`. `unresolved` must include every static unresolved note.
- **Generation:** `generateFnWalkthrough` is generalised to take a rendered prompt + system prompt (retry ≤ 2 on schema failure, unchanged).
- **Verifier:** `verifyFnWalkthrough(walkthrough, ctx: FnContext)` becomes `verifyWalkthrough(walkthrough, facts: VerifyFacts)` with `VerifyFacts = { files: Record<string, number>; vocabulary: Set<string>; packages: Set<string> }`. `FnContext` and `EndpointContext` each have a `verifyFacts()` builder. Existing fn behaviour and tests are unchanged.
- **Docs:** resolved per step from the cited file's directory, as in `walk fn`.

## 5. Persistence and staleness

- `ScopeKind` adds `'endpoint'`; `scopeRef` is the normalised `"<METHOD> <full_path>"` of the matched route.
- `SavedWalkthrough` gains `endpoint: EndpointOverview | null` (route, chain labels, error handlers, side effects, error paths, diagram source); rebuilt from the index on every run, like `FileOverview`.
- The single section stores `blocks: BlockRef[]` (every chain node, error handler, callee and registration block whose code was sent; the handler first) in addition to `block` (= `blocks[0]`), and `chainHash` (hash of the ordered chain labels + symbol keys).
- **Fresh** iff `chainHash` matches and every block's hash matches its symbol relocated by name (registration blocks have no symbol, so they are relocated by their exact text, nearest to where they were). Otherwise the section is regenerated whole. `walk list` reports per-step staleness as for fn/file, plus the changed blocks by name, `middleware chain changed` or `route removed`.
- **Reuse** when fresh: unchanged blocks that moved shift their steps and references, exactly like `walk fn`.
- `SAVED_VERSION` stays 2: `endpoint`, `blocks` and `chainHash` are optional fields, so fn/file saves are unaffected.

## 6. CLI

```
walk endpoint "<METHOD> <path>" [--no-llm] [--out md|json|terminal] [--depth <n>] [--refresh]
```

- Indexes first (no-op when unchanged), as `walk fn` does.
- `--no-llm`: prints route + mount chain, middleware chain, error handlers, side effects per node, error paths, unresolved, and the Mermaid source (`--out json` prints the context).
- Otherwise: reuse a fresh saved walkthrough unless `--refresh`; save to Postgres and `.walkthrough/walkthroughs/` (Markdown includes a ```` ```mermaid ```` block); terminal prints the chain summary then opens the stepper.
- Exit 1 with a clear message for no/ambiguous match, LLM failure, or all steps failing verification.

## 7. Error handling

- No `express` app found under `roots.backend`: `walk endpoint` says so and suggests checking `roots.backend`.
- Unresolvable handler args, non-literal paths and mount cycles are stored with notes and surfaced in output; never dropped silently.
- LLM request/output errors follow `walk fn` (no partial save).

## 8. Testing

- **Indexer (snippets):** router declarations; `use` with and without path; arrays of middleware; `.route('/x').get().post()`; middleware registered after a route is excluded; path-scoped `use`; factory middleware; package middleware; inline handlers become `route_handler`; non-literal path; arity-4 error handlers.
- **Stitching (pure, no DB):** nested mounts, prefix joining/normalisation, ordering across app → router → route, mount cycles.
- **Side effects (snippets):** each row of the §2 table, including SQL in a `const` and template text, knex, prisma, and an untyped `throw err`.
- **Store (real Postgres, throwaway schema):** migration, `router_calls` round-trip, stitching inside `applyIndexChanges`, incremental re-index after editing one router file, `getRoute`, `getMiddlewareChain`.
- **URL matching:** exact, `:param`, `ALL`, no match suggestions, ambiguity.
- **Mermaid:** snapshot for the fixture endpoint.
- **Verifier:** existing tests pass on `verifyWalkthrough`; new cases for cross-file `code_ref`s.
- **Acceptance (fixture):** `POST /api/patients/enroll` →
  - mount chain: `api/app.ts:10` `/api`, `api/routes/index.ts:6` `/patients`
  - chain: `express.json` (app) → `requireAuth` (router) → `rateLimit` (route) → `validate.validateBody` (route) → `enrollHandler`; error handler `errorHandler`
  - side effects: `requireAuth` redis `GET session:${token}`, throws `UnauthorizedError (401)`; `rateLimit` redis `INCR`/`EXPIRE`, throws `TooManyRequestsError (429)`; `validate.validateBody` throws `ValidationError (400)`; `findPatientByPhone` `db_read patients`; `insertPatient` `db_write patients`; `insertConsent` `db_write consents`; `enrollPatient` redis `SET patient:${patient.id}`, queue `emit patient.enrolled`, throws `ConflictError (409)`
  - unresolved includes `bus.emit`
  - `GET /api/patients/42` resolves to `GET /api/patients/:id` with chain `express.json` → `requireAuth` → `getPatientHandler`
  - with a recorded LLM response: verified steps in the fixed stage order; editing `insertConsent` marks the saved endpoint walkthrough stale.

## Out of scope

`walk component`, `walk trace`, `cross_edges`, embeddings, non-Express frameworks, runtime-registered routes (loops over route tables), `app.param`.
