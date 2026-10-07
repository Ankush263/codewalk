# Walkthrough: Code Comprehension Tool

> Spec for Claude Code. Read this fully before writing any code. Build iteratively in the phases below, with small targeted changes, and stop at each phase's acceptance criteria for review.

---

## 1. Problem

LLM-assisted coding makes it easy to merge code without understanding it. Over time this builds a codebase the author can't explain. Reading raw code is slow, and asking an LLM ad hoc gives unverified, ungrounded explanations.

## 2. Goal

A local tool that explains **any function, file, or whole feature in a monorepo, step by step**, with worked examples, references to real code locations, and links to official docs. The explanations must be **grounded in static analysis** (call graph, types, routes), not just LLM guesses, and **verifiable** (every claim cites a real `file:line`).

The user should finish a walkthrough able to explain the code to someone else.

## 3. Non-goals

- No git integration (no hooks, diffs, commits, PR review).
- No code generation or editing of the user's repo.
- No multi-language support in v1 (TypeScript/JavaScript only).
- No cloud service or accounts. Everything runs locally (including PostgreSQL, via Docker Compose) except the LLM API call.

## 4. Target environment

- **Repo shape:** a single **monorepo** containing both backend (Node.js/Express, TypeScript) and frontend (React, TypeScript).
- **Data layer seen in the repos:** PostgreSQL (raw SQL or query builder/ORM), Redis.
- **Tool stack:** TypeScript, Node.js 20+.
- **Tool's own storage:** PostgreSQL 16+ with the `pgvector` extension, run locally via the provided `docker-compose.yml`. Accessed through `pg` (node-postgres); migrations via `node-pg-migrate`.

## 5. User-facing commands (CLI)

```
walk init                                  # create .walkthrough/ config, connect to Postgres, run migrations, build the index
walk index [--watch]                       # (re)build the symbol graph in Postgres (incremental by file hash)
walk fn <file>#<symbolName>                # walkthrough of a function / method / code block
walk fn <file>:<startLine>-<endLine>       # walkthrough of an arbitrary line range
walk file <file>                           # walkthrough of a whole file
walk endpoint "<METHOD> <path>"            # backend feature: e.g. "POST /patients/enroll"
walk component <file>[#<ComponentName>]    # frontend feature: a React component
walk trace "<METHOD> <path>"               # full-stack: UI trigger -> API -> DB -> back to UI
walk serve                                 # open the local web UI for saved/generated walkthroughs
walk list                                  # list saved walkthroughs and their staleness
```

Common flags: `--out md|json|terminal` (default `terminal`), `--no-llm` (print only the static facts), `--depth <n>`, `--refresh` (ignore cache).

## 6. Walkthrough modes

### 6.1 Function / block (`walk fn`)
Steps follow **execution order** through the block. Each step contains:
1. The code snippet (highlighted lines, surrounding code dimmed).
2. Plain-English explanation of what it does and why.
3. **Worked example:** a concrete sample input traced through, showing relevant variable state after the step.
4. **References:** callers, callees, types used, each as `path:line`.
5. **Docs links** for library/framework calls (see 9.4).

### 6.2 File (`walk file`)
1. File's role in the system (who imports it, what it exports).
2. Map of exports and internal helpers.
3. Each function walked in **dependency order** (helpers first, entry points last), using the 6.1 format in condensed form.

### 6.3 Endpoint (`walk endpoint`)
1. Resolve the route, including `app.use('/prefix', router)` mounts, to the full path.
2. **Middleware chain in execution order** (auth, validation, rate limit, error handler).
3. Handler -> service -> data layer calls.
4. **Side effects tagged per node:** tables read/written, Redis keys, outbound HTTP, queue publishes, thrown errors.
5. Grouped into stages: request -> middleware -> validation -> business logic -> persistence -> response.
6. Worked example payload traced through the stages; "what can go wrong" paths (error branches).
7. Mermaid sequence diagram.

### 6.4 Component (`walk component`)
1. Props in, state owned (`useState`/`useReducer`), context read.
2. Render tree: child components, props passed down, conditional branches.
3. Effects and derived values: `useEffect` deps, `useMemo`, and **custom hooks expanded as sub-steps**.
4. Event handlers: per user action, what state changes and what calls fire.
5. Data fetching: method + URL for each API call (feeds the full-stack trace).

### 6.5 Full-stack trace (`walk trace`)
Stitch a component's API call to the matching endpoint, e.g.:

```
Button click -> handleSubmit -> useEnrollMutation -> POST /patients/enroll
  -> auth middleware -> validate -> enrollService -> INSERT patients -> 201
  -> onSuccess -> UI state update
```

Matching is by HTTP method + path pattern (`/patients/:id` <-> template literals like `` `/patients/${id}` ``). When ambiguous, ask the user to pin the match and persist the pin in config.

## 7. Architecture

```
Indexer (ts-morph)
  |- Backend index: routes, mounts, middleware, calls, SQL/ORM side effects
  |- Frontend index: components, props, hooks, context, handlers, API calls
        |
        v
Symbol graph (PostgreSQL + pgvector) + cross-stack edges (API call <-> route)
        |
        v
Context builder: selects the exact code + facts for a requested scope
        |
        v
LLM client: returns STRICT structured JSON (section 8.2)
        |
        v
Verifier: rejects steps citing nonexistent file:line; flags unsupported claims
        |
        v
Renderer: terminal stepper (Ink) | Markdown export | local web UI
```

**Core principle: facts first, LLM second.** Call graphs, types, routes, and side effects come from static analysis. The LLM only explains facts it is given and may not invent symbols, files, or lines.

## 8. Data model and contracts

### 8.1 PostgreSQL schema

One Postgres **schema per indexed repo** (e.g. `cw_<repo_slug>`), so several repos can share one database without collisions. Types below are shorthand: `id` = `BIGSERIAL PRIMARY KEY`, paths/names = `TEXT`, flexible payloads = `JSONB`, timestamps = `TIMESTAMPTZ`. Add indexes on all foreign keys and on `symbols(name)`, `routes(method, full_path)`, and `calls(caller_symbol_id)` / `calls(callee_symbol_id)`.

```
files(id, path, hash, language)
symbols(id, file_id, name, kind, start_line, end_line, exported, signature, embedding vector(768) NULL)
  -- kind: function | method | class | component | hook | route_handler | type
calls(caller_symbol_id, callee_symbol_id, call_line, resolved BOOLEAN)
imports(file_id, imported_path, imported_names, package_name, package_version)
routes(id, method, full_path, handler_symbol_id, mount_chain)
middleware(route_id, order_idx, symbol_id)
side_effects(symbol_id, kind, detail, line)
  -- kind: db_read | db_write | redis | http_out | queue | throws
components(symbol_id, props_type, state_vars, hooks_used, context_used)
api_calls(symbol_id, method, url_pattern, line)
cross_edges(api_call_id, route_id, confidence, pinned BOOLEAN)
walkthroughs(id, scope_kind, scope_ref, content_hash, content JSONB, created_at TIMESTAMPTZ)
```

Unresolved edges (dynamic dispatch, DI containers, unknown callbacks) are stored with `resolved = false` and surfaced to the user as "unresolved: likely X". **Never guess silently.**

### 8.1a Postgres usage notes

- **Call-graph traversal:** use `WITH RECURSIVE` CTEs with a depth limit and cycle guard (track visited `symbol_id`s in an array), e.g. all transitive callees of a handler up to `--depth`.
- **Semantic lookup:** `symbols.embedding` plus a `pgvector` index (HNSW) powers plain-language feature search ("how does consent capture work"). Embeddings are optional; generate them lazily and skip if no embedding provider is configured.
- **Incremental indexing:** compare `files.hash`; delete and re-insert only rows for changed files inside a single transaction. Use batched inserts (`unnest` arrays or `COPY`) instead of row-by-row inserts for large repos.
- **Staleness:** `walkthroughs.content_hash` is compared against current hashes of the referenced blocks.
- **Isolation:** all queries run with `search_path` set to the repo's schema.
- **Store interface:** nothing outside `core/src/store` may write SQL. Expose methods such as `getCallers(symbolId)`, `getCallees(symbolId, depth)`, `getRoute(method, path)`, `getMiddlewareChain(routeId)`, `findSymbolsByEmbedding(vec, k)`, `saveWalkthrough(...)`. This keeps the engine testable and the storage swappable.

### 8.2 LLM output contract (validate with zod)

```json
{
  "title": "string",
  "summary": "string",
  "stages": [
    {
      "name": "string",
      "steps": [
        {
          "id": "string",
          "code_ref": { "file": "string", "start": 0, "end": 0 },
          "explanation": "string",
          "example": { "input": "string", "state_after": "string" },
          "references": [{ "file": "string", "line": 0, "role": "caller|callee|type" }],
          "docs": [{ "package": "string", "symbol": "string" }],
          "concepts": ["string"],
          "risks": ["string"]
        }
      ]
    }
  ],
  "unresolved": ["string"]
}
```

Reject and retry (max 2) on schema failure.

### 8.3 Verifier rules
- Every `code_ref` and `references[]` entry must exist in the index and be within file line bounds.
- Every named symbol in an explanation must exist in the index (cheap string check against the symbols provided in context).
- Steps failing verification are dropped or re-requested; the output notes how many were dropped.

### 8.4 Docs links
Docs URLs are **never generated by the LLM**. The LLM returns `{package, symbol}`; the tool resolves the URL from package metadata (`homepage`/`repository` in the installed package's `package.json`, version from the lockfile) and a small curated map for common packages (express, react, pg, ioredis, zod, etc.). Unknown packages get a link to the package's npm page.

## 9. Caching and staleness

- Each walkthrough is saved to `.walkthrough/walkthroughs/` as Markdown + JSON.
- Keyed by a **content hash of the code blocks it references**. When any referenced block changes, mark the walkthrough **stale**; regenerate only the affected steps.
- `walk list` shows fresh vs stale.

## 10. Configuration (`.walkthrough/config.json`)

```json
{
  "roots": { "backend": "apps/api", "frontend": "apps/web" },
  "apiClientWrappers": [{ "name": "api.post", "method": "POST", "urlArgIndex": 0 }],
  "database": { "url": "postgres://codewalk:codewalk@localhost:5432/codewalk", "schema": "cw_my_repo" },
  "ignore": ["**/node_modules/**", "**/dist/**", "**/*.test.ts"],
  "collapseHelpers": ["logger", "lodash"],
  "pinnedEdges": [],
  "llm": { "provider": "anthropic", "model": "<configurable>", "maxContextTokens": 60000 }
}
```

`apiClientWrappers` is required so custom API clients (not just `fetch`/`axios`) are recognized as API calls.

## 11. Repo layout

Flat layout: packages live at the top level (no `packages/` folder).

```
codewalk/
  core/          # indexer, symbol graph, context builder, verifier
                 #   src/store/  -> all Postgres access + migrations (only place SQL lives)
                 #   src/llm/    -> provider client, prompts, zod schemas
  cli/           # commander-based CLI + Ink terminal stepper
  web/           # local web UI (React + Vite), served by `walk serve`
  fixture/       # small sample monorepo (Express + React) used for tests; parsed only, not a workspace package
  docker-compose.yml   # Postgres 16 + pgvector for local development
```

Use `pnpm` workspaces, `vitest` for tests, `tsup` for builds, `pg` + `node-pg-migrate` for the database.

## 12. Build phases

Stop at the end of each phase for review. Prefer small, targeted commits to the existing code over rewrites.

### Phase 1: Foundations + `walk fn`
- Workspace scaffolding, config loading, `walk init`.
- `docker-compose.yml` (Postgres 16 + pgvector), migrations for the 8.1 schema, and the `store` module with the interface from 8.1a. `walk init` creates the per-repo schema and runs migrations, with a clear error if Postgres is unreachable.
- ts-morph indexer: files, symbols, calls, imports (incremental, transactional writes).
- Context builder for a single function (code + callers + callees + types).
- LLM client with the 8.2 schema and the verifier.
- Ink stepper rendering steps with prev/next.
- **Accept when:** `walk fn <file>#<name>` on the fixture repo produces verified steps with at least one correct worked example, and `--no-llm` prints the static facts.

### Phase 2: `walk file` + persistence
- Dependency-ordered file walkthrough, Markdown export, `.walkthrough/` storage, content-hash staleness, `walk list`.
- **Accept when:** editing one function marks only the affected walkthrough steps stale.

### Phase 3: `walk endpoint`
- Express route + `app.use` mount resolution, middleware chain ordering, side-effect tagging (SQL strings / query builder / Redis / HTTP / throws), Mermaid sequence diagram.
- **Accept when:** a nested-router endpoint in the fixture resolves to the correct full path with the correct middleware order and tagged side effects.

### Phase 4: `walk component`
- Props/state/context extraction, render tree, custom hook expansion, handler analysis, API call detection with `apiClientWrappers`.
- **Accept when:** a component with a custom hook and a mutation produces correct stages and detects its API call.

### Phase 5: `walk trace` (cross-stack)
- URL pattern matching, `cross_edges`, manual pinning, combined diagram.
- **Accept when:** a click-to-database trace renders end to end on the fixture repo.

### Phase 6: Web UI + polish
- `walk serve`: code on the left, explanation on the right, diagram, drill-down Q&A on any step (answer grounded in the same index facts).
- Optional "predict first, then reveal" mode on each step.

## 13. Known hard problems (handle explicitly)

- **Dynamic dispatch / DI / event emitters:** mark edges unresolved; allow `pinnedEdges` in config.
- **Prop drilling and context across many layers:** cap depth, say so in the output.
- **Feature sprawl:** `--depth` limit, `collapseHelpers`, and a "stop at module" option.
- **Hallucinated explanations:** the verifier (8.3) is mandatory, not optional.
- **Cost/latency:** cache by content hash; send only the needed code, never the whole repo.
- **Postgres setup friction:** `walk init` must detect a missing or unreachable database and print the exact `docker compose up -d` command to fix it.
- **Large-repo indexing speed:** batch writes, index incrementally by file hash, and avoid N+1 queries in context building (fetch callers/callees with one recursive query).

## 14. Testing

- `fixture/` contains a small monorepo with: nested Express routers + middleware, a service layer hitting Postgres/Redis, a React component with a custom hook and API mutation, and a few deliberately dynamic call sites (to test unresolved edges).
- Unit-test the indexer, route resolver, URL matcher, and verifier with vitest. LLM calls are mocked in tests via recorded fixtures.
- **Database tests:** run against a real Postgres (the compose service or `testcontainers`), never a mock. Each test file creates its own throwaway schema (e.g. `cw_test_<random>`), runs migrations, and drops the schema afterward so tests can run in parallel.

## 15. Working agreements for Claude Code

- Work phase by phase. Before each phase, restate the plan briefly and list the files you'll touch.
- Make iterative, targeted changes to existing code, not wholesale rewrites.
- Keep outputs concise and structured.
- Don't add features outside the current phase. If something seems needed, note it and ask.
- Ask clarifying questions when a requirement is ambiguous rather than guessing.
- Don't commit any code.