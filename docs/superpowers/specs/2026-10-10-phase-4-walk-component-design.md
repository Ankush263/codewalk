# Phase 4: `walk component` Design

**Spec:** `CLAUDE.md` §6.4 (component mode), §8.1 (`components`, `api_calls`), §8.1a (store interface), §9 (staleness), §10 (`apiClientWrappers`), §12 Phase 4, §13 (prop drilling, unresolved edges).

**Goal:** `walk component web/components/EnrollForm.tsx#EnrollForm` explains one React component, grounded in static facts. It covers the props it receives, the state it owns and the context it reads. It covers the render tree (child components, the props passed to them, conditional branches) and effects and derived values, with custom hooks expanded as sub-steps. It also covers event handlers and every API call the component can trigger (method + URL pattern, and which handler or effect leads to it). One LLM narrative traces one example through fixed stages.

**Acceptance (CLAUDE.md §12):** a component with a custom hook and a mutation (`EnrollForm` → `useEnrollMutation` → `api.post`) produces correct stages and detects its API call `POST /api/patients/enroll`, triggered by `onSubmit` on `<form>` through `EnrollForm.handleSubmit` → `useEnrollMutation.mutate`.

## Decisions (approved)

1. **One narrative, one LLM call per component, fixed stages** (as `walk endpoint`): "Inputs and state" → "Render" → "Effects and derived values" → one "Hook: <name>" stage per expanded custom hook → "Event handlers" → "Data fetching". Empty stages are omitted. One example (concrete props plus one user interaction, or the mount when there is none) is traced through every stage.
2. **Hook-returned functions resolve through the return object.** `mutate` destructured from `useEnrollMutation()` already resolves through its type (`calls.ts` step 2) when the hook declares `function mutate` and returns `{ mutate }`. The gap is inline functions in the returned object (`return { mutate: (v) => … }`), which are not symbols today. They become `<hook>.<name>` symbols so the same resolution reaches them. Anything else stays unresolved, with a "likely X" note where the static facts support one (§3.5).
3. **Depth:** child components are shown **one level** (element, props passed, condition; signature only, no body), and the output says their internals are not expanded. Repo custom hooks are expanded recursively up to `--depth`. Package hooks (`useState`, `useQuery`, …) are labelled, never expanded.
4. **Detect only.** API calls are stored in `api_calls` (method, normalised `url_pattern`, raw `url_text`) and shown. Matching them to routes (`cross_edges`, pinning) stays in Phase 5.

## 1. Indexing

Two new per-file fact kinds, extracted with the others (incremental, refreshed with the same importer/caller rules, one transaction).

### 1.1 React facts (`components` table)

For every symbol of kind `component` or `hook` (`core/src/indexer/react.ts`). Only code owned by the symbol itself counts; code inside nested registered symbols (e.g. `EnrollForm.handleSubmit`) is excluded. Inline arrows that are not symbols (effect callbacks, `.map` callbacks) are included.

| fact | from | stored as |
|---|---|---|
| props | components: first parameter; hooks: every parameter. A destructuring pattern gives its property names, an identifier gives itself. | `props_type` (type annotation text of param 0, or NULL), `props` (names) |
| state | `useState` / `useReducer` from `react`, bound by `const [x, setX] = …` | `state_vars`: `{name, setter, hook, initial, line}` (`initial` = useState arg 0 / useReducer arg 1, one line, or NULL) |
| hooks | every call named `use[A-Z0-9]…` (also `React.useX`) | `hooks_used`: `{name, line, callee: SymbolKey \| null, package, bindings, callbacks}`. `callee` = repo hook; `bindings` = names it is destructured into; `callbacks` = function-valued properties of object-literal args, e.g. `{name: "onSuccess", line: 21}` |
| context | `useContext(X)` from `react` | `context_used`: `{context, line, bindings}` |
| effects / derived | `useEffect`, `useLayoutEffect`, `useInsertionEffect`, `useMemo`, `useCallback` from `react` | `effects`: `{hook, line, endLine, deps: string[] \| null, binding}` (`deps` NULL = no deps array) |
| render | JSX elements: every component element (tag starts uppercase or is dotted), plus intrinsic elements with an `on*` prop or a condition | `render`: `{element, kind: component\|element, line, depth, component: SymbolKey \| null, package, props: {name, value}[], condition}` |
| handlers | `on[A-Z]…` JSX attributes with an expression value | `handlers`: `{element, event, handler, line, endLine, target: SymbolKey \| null}` (`target` = the repo function named; NULL for inline arrows) |

`condition` joins, outermost first, every `a && <X/>` (→ `a`), `c ? <X/> : …` (→ `c` / `!(c)`) and `if (c) return <X/>` (→ `c` / `!(c)`) between the element and the symbol's body. `depth` counts enclosing JSX elements.

### 1.2 API calls (`api_calls` table)

Per call, attributed to the enclosing symbol (`core/src/indexer/apiCalls.ts`):

- `apiClientWrappers` from config: callee text (generics stripped) equals `name` → `method` from config, URL = argument `urlArgIndex`.
- `fetch(url, { method })` (global, not a repo function): method from a literal `method` option, default `GET`.
- axios (`axios.get|post|…(url)`, `axios(url, { method })`, `axios({ url, method })`).

The URL must be a string or template literal, or a `const` initialised with one (followed through imports). A call with any other URL, such as `fetch(url)` inside the client wrapper itself, is generic plumbing and is **not** recorded. A non-literal `method` option is stored as `UNKNOWN`.

`url_pattern`: template substitutions become `:name`, where the name is the identifier or the last property name (`${patient.id}` → `:id`), otherwise `:param`. A leading substitution before the first `/` (a base URL such as `${API_URL}/patients`) is dropped. A scheme and host are dropped. The query string and hash are dropped. The result is normalised like route paths (`normalizePath`). `url_text` keeps the source text.

### 1.3 Config changes re-extract

`apiClientWrappers` changes what is extracted from unchanged files. `walk index` stores a hash of the extraction settings in `index_settings`. When the hash differs, every file hash is cleared (as the Phase 3 migration did), so the next pass re-extracts everything.

### 1.4 Migration

- `components` gains `props JSONB`, `effects JSONB`, `render JSONB`, `handlers JSONB` (all `NOT NULL DEFAULT '[]'`).
- `api_calls` gains `url_text TEXT NOT NULL DEFAULT ''`.
- New table `index_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`.
- `UPDATE files SET hash = ''` (files indexed before this have no React facts).

Store additions: `getReactFacts(symbolIds)`, `getApiCalls(symbolIds)`, `getSymbolsByKeys(keys)`, `getIndexSetting(key)`, `resetIndexForSetting(key, value)`.

## 2. Target

`walk component <file>[#<ComponentName>]`. Without a name, the file's only component is used. If the file has several, the command fails and lists them. If it has none, the command fails and suggests `walk file`. A name that is a hook or function fails and suggests `walk fn`. A `file:start-end` range fails and suggests `walk fn`.

## 3. Component context (`core/src/context/component.ts`)

`ComponentContext`:

- `component`: the symbol, its React facts, its code, and `inner` symbols (its handlers).
- `hooks`: repo hooks reached from the component through `hooks_used.callee`, breadth first, depth ≤ `--depth`, each once. Each has `depth`, `usedBy`, `calledAt`, facts, code and `inner` (functions it returns).
- `children`: every component element in the render tree: element, repo symbol (signature only) or package, line, props passed, condition.
- `callees`: calls made by the component, the expanded hooks and their inner symbols, transitively to `--depth`. Calls between those owners are left out (each is explained as part of its owner). Bodies of direct repo callees are included, as in `walk fn`.
- `types`, `values`: declarations used by the component and hook ranges (as `walk fn`).
- `apiCalls`: `api_calls` rows of every owner and reached callee, each with **triggers**. A trigger is a handler binding or an effect (`useEffect`/`useLayoutEffect`/`useInsertionEffect`) from which the call is reachable over call edges, with the function path, e.g. `onSubmit on <form>` → `[EnrollForm.handleSubmit, useEnrollMutation.mutate]`. Handler targets start from their symbol. Inline handlers and effects start from the calls their owner makes inside their line range. A call made directly inside an effect's range is reached with the path `[owner]`.
- `unresolved`: unresolved calls, with "likely" notes:
  - a hook calls a name that a caller passes as a function-valued property of an object-literal argument → `unresolved: likely the \`onSuccess\` callback EnrollForm passes to useEnrollMutation (web/components/EnrollForm.tsx:21)`;
  - a component calls one of its own props → `unresolved: likely the \`onEnrolled\` prop, supplied by whoever renders EnrollForm (call at …)`;
  - a hook calls one of its own parameters → `unresolved: likely the \`x\` argument of useX (call at …)`;
  - otherwise the generic `walk fn` note.
- `limits`: hooks beyond `--depth`, and one line per repo child component ("internals not expanded; run `walk component <file>#<Name>`").
- `packages`, `files`, `omitted`, `warnings` (as `FnContext`).
- `scopeRef` = `<file>#<Name>`; `structureHash` = hash of the expanded hooks, children, handler bindings and API calls (changes even when no explained block changed, e.g. a depth-2 callee starts calling an API).

Budget priority: component code (must fit, else `TargetError`), then hooks (shallowest first), then types, values, then direct callees.

## 4. LLM and verifier

- **Schema:** §8.2 zod schema, unchanged.
- **Prompt** (`core/src/llm/componentPrompt.ts`): stages fixed as in Decision 1. "Hook: <name>" stages follow expansion order. `code_ref` may cite any file in the context. "Data fetching" must name the method and URL pattern of each API call and the trigger that leads to it. `unresolved` must copy every static note.
- **Verifier:** `componentVerifyFacts(ctx): VerifyFacts`, fed to the existing `verifyWalkthrough`.

## 5. Persistence and staleness

- `ScopeKind` adds `'component'`; `scopeRef` = `<file>#<Name>`.
- `SavedWalkthrough.component?: ComponentOverview` (props, state, context, hooks, children, handlers, effects, API calls with triggers, limits, warnings), rebuilt on every run. `componentNotes(o)` renders it for terminal, stepper and Markdown.
- One section with `blocks` (component first, then hooks, direct callees, types) and `chainHash` = `structureHash`. `reuseEndpointSection` is renamed `reuseMultiBlockSection` and used by both endpoint and component.
- `checkWalkthrough` applies the `chains` callback to component walkthroughs too. `walk list` computes the current structure hash with `currentStructureHash(store, repoRoot, scopeRef, depth)` and shows `structure changed` / `component removed`.
- `SAVED_VERSION` stays 2 (new field optional).

## 6. CLI

```
walk component <file>[#<ComponentName>] [--no-llm] [--out md|json|terminal] [--depth <n>] [--refresh]
```

Default `--depth 2`. Indexes first. `--no-llm` prints props, state, context, hooks (expanded ones marked), render tree, handlers, effects, API calls with triggers, calls, unresolved, limits; `--out json` prints the context. Otherwise it behaves like `walk endpoint`: it reuses a fresh saved walkthrough, saves to Postgres plus Markdown/JSON, and shows the stepper. Exit 1 on target errors, LLM failure, or all steps dropped.

## 7. Testing

- **Snippets:** hook return-object functions become symbols and `mutate` resolves; every row of the §1.1 table; every §1.2 rule (wrapper, fetch, axios, template → `:param`, base URL dropped, non-literal URL skipped, query dropped, `UNKNOWN` method).
- **Store (real Postgres):** migration; round-trip of React facts and API calls; refresh rewrites them; `getSymbolsByKeys`; changing `apiClientWrappers` re-extracts unchanged files.
- **Context (fixture):** EnrollForm acceptance facts; PatientSummary's effect-triggered `GET /api/patients/:id`; `--depth 1` limit notes; target errors.
- **LLM (recorded response):** stages in fixed order, all steps verified, a bad `code_ref` dropped.
- **Staleness:** editing `useEnrollMutation.mutate` marks the component walkthrough stale; adding a line above `EnrollForm` reuses it with shifted lines.
- **CLI:** `--no-llm` acceptance output, explain + save + reuse, `walk list` stale after a hook edit, unknown component error.

## Out of scope

Matching API calls to routes, `cross_edges`, pins, combined diagrams (Phase 5); class components; expanding child components; Redux/Zustand stores; React Query cache semantics beyond labelling the hook; `walk serve`.
