# Phase 3: `walk endpoint` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `walk endpoint "POST /api/patients/enroll"` explains one Express endpoint end to end: full path through `app.use` mounts, middleware chain in execution order, handler → service → data layer, side effects tagged per function, error paths, a Mermaid sequence diagram, and one verified LLM narrative tracing an example request through fixed stages.

**Architecture:** The indexer extracts two new per-file facts: Express registrations (`router_calls`) and side effects. After every index pass the store stitches all registrations into `routes` + `middleware` inside the same transaction, using a pure function (`core/src/routes/stitch.ts`). `buildEndpointContext` matches a `"<METHOD> <path>"` target to a route and gathers the chain, callees (one recursive query per node), side effects and code. The LLM explains it with the unchanged §8.2 schema and a generalized verifier. The result is saved as one section that records a hash for every block it explained plus a hash of the chain.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), ts-morph, `pg` + `node-pg-migrate`, zod, commander, Ink, vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-phase-3-walk-endpoint-design.md` (implements `CLAUDE.md` §6.3, §8.1, §8.1a, §9, §12 Phase 3).

## Global Constraints

- Node `>=24`, pnpm workspaces, vitest, tsup. TypeScript 7; `pnpm typecheck` must pass at the end.
- Nothing outside `core/src/store` writes SQL (CLAUDE.md §8.1a). `routes/stitch.ts` is pure TypeScript called by the store.
- Database tests use the real compose Postgres, each in its own `cw_test_<random>` schema that is dropped afterwards (CLAUDE.md §14). Never mock the DB.
- LLM calls are mocked in tests with a recorded/handcrafted response (CLAUDE.md §14).
- Docs URLs are never produced by the LLM (CLAUDE.md §8.4).
- Unresolved or uncertain facts are surfaced, never guessed silently (CLAUDE.md §8.1).
- Express only. No Phase 4+ features (components, traces, `cross_edges`).
- `SAVED_VERSION` stays `2`; new saved fields are optional.
- **Do not commit** (CLAUDE.md §15). Each task ends with a checkpoint instead of a commit.
- Run tests from the repo root with Postgres up (`pnpm db:up`). Baseline before starting: `pnpm test` → 20 files, 140 tests passing.

## Review Focus

1. **A concrete path for a parameterised route** (`walk endpoint "GET /api/patients/42"`) must resolve to `GET /api/patients/:id`, not "no match". Tested in Task 7 and Task 8.
2. **Editing a router file** (removing `rateLimit` from the route) must update the stored chain on the next index, and a saved endpoint walkthrough must show `middleware chain changed`. Tested in Task 6 (re-index) and Task 11 (chain hash).
3. **A typo in the route** (`/api/patient/enroll`) must exit 1 with the closest real routes listed, not crash. Tested in Task 7 and Task 12.
4. **A repo with no Express app indexed** (wrong `roots.backend`, frontend-only) must give a clear "No Express routes in the index" error. Tested in Task 8.
5. **Lines moving without code changing** (a comment added at the top of `enrollService.ts`) must reuse the saved endpoint walkthrough with shifted line numbers and no LLM call. Tested in Task 11.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/indexer/calls.ts` (modify) | `packageOf` / `moduleOf` / `declarationOf`; export `enclosingSymbol`; `RepoLookup.pathOf` |
| `core/src/indexer/__fixtures__/snippets.ts` (create) | In-memory ts-morph repos for indexer unit tests |
| `core/src/indexer/symbols.ts` (modify) | Inline route handlers → `route_handler` symbols; export `functionInitializer` |
| `core/src/indexer/routers.ts` (create) | Per-file Express registration facts |
| `core/src/indexer/sideEffects.ts` (create) | Per-file side-effect facts + `sqlEffects` |
| `core/src/indexer/extract.ts`, `index.ts` (modify) | Wire the new facts into extraction and call refreshes |
| `core/src/routes/stitch.ts` (create) | Pure: registrations → full routes + ordered middleware |
| `core/src/routes/match.ts` (create) | Parse `"<METHOD> <path>"`, match against route patterns, suggest close routes |
| `core/src/store/migrations/1792000000000_routes-and-side-effects.ts` (create) | `router_calls`, `route_warnings`, new `routes`/`middleware` columns |
| `core/src/store/types.ts`, `store.ts` (modify) | New fact/record types; persist facts; rebuild routes; `listRoutes`, `getMiddlewareChain`, `getSideEffects`, `getRouteWarnings` |
| `core/src/context/shared.ts` (create) | `SourceCache`, `Budget`, `estimateTokens`, `collectPackages` moved out of `fn.ts` |
| `core/src/context/endpoint.ts` (create) | `buildEndpointContext`, `chainHashOf`, `currentChainHash` |
| `core/src/render/mermaid.ts` (create) | `endpointDiagram(ctx)` |
| `core/src/verify/verify.ts` (modify) | `verifyWalkthrough(w, VerifyFacts)`, `vocabularyOf`, `endpointVerifyFacts` |
| `core/src/llm/generate.ts` (modify), `core/src/llm/endpointPrompt.ts` (create) | `generateWalkthrough`; endpoint system prompt + renderer |
| `core/src/llm/__fixtures__/enrollEndpoint.response.json` (create) | Handcrafted response for the fixture endpoint |
| `core/src/walkthrough/endpoint.ts` (create) | `explainEndpoint`, `endpointBlocks`, `generateEndpointSection`, `reuseEndpointSection`, `endpointOverviewOf` |
| `core/src/walkthrough/saved.ts`, `section.ts`, `staleness.ts`, `persist.ts` (modify) | `endpoint` scope, multi-block sections, chain staleness |
| `core/src/render/markdown.ts` (modify) | Endpoint Markdown with a mermaid block |
| `cli/src/commands/endpoint.ts` (create), `list.ts`, `index.ts`, `ui/format.ts`, `ui/output.ts` (modify) | `walk endpoint`; list/format support |

---

### Task 1: Package origin tracing + in-memory snippet harness

**Files:**
- Modify: `core/src/indexer/calls.ts`
- Modify: `core/src/indexer/extract.ts`
- Create: `core/src/indexer/__fixtures__/snippets.ts`
- Test: `core/src/indexer/origin.test.ts`

**Interfaces:**
- Produces:
  - `RepoLookup.pathOf(sourceFile: SourceFile): string`
  - `packageOf(expr: Node, repo: RepoLookup): string | null`: the module a value was created from (`'pg'`, `'ioredis'`, `'events'`, `'express'`, `'@prisma/client'`), or null for repo values, globals and unknowns.
  - `moduleOf(specifier: string): string`
  - `declarationOf(expr: Node): Node | undefined`
  - `enclosingSymbol(node: Node, byNode): RegisteredSymbol | null` (now exported)
  - `Extractor.repo: RepoLookup` (public)
  - `snippetProject(files: Record<string, string>): { project, extractor, facts(path), findCall(path, calleeText) }`

- [ ] **Step 1: Write the snippet harness**

Create `core/src/indexer/__fixtures__/snippets.ts`:

```ts
import { Project, SyntaxKind, ts, type CallExpression } from 'ts-morph';
import { Extractor, type ExtractedFacts } from '../extract.js';

// In-memory repos for indexer unit tests: no disk and no node_modules, so package imports stay
// unresolved, exactly like a repo whose dependencies aren't installed (the fixture is the same).

const ROOT = '/repo';

export function snippetProject(files: Record<string, string>) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
  });
  for (const [path, text] of Object.entries(files)) project.createSourceFile(`${ROOT}/${path}`, text);
  project.resolveSourceFileDependencies();
  const extractor = new Extractor(project, ROOT, new Set(Object.keys(files)));
  return {
    project,
    extractor,
    facts: (path: string): ExtractedFacts => extractor.extract(path),
    /** The first call in `path` whose callee is exactly `calleeText`, e.g. "pool.query". */
    findCall(path: string, calleeText: string): CallExpression {
      const call = project
        .getSourceFileOrThrow(`${ROOT}/${path}`)
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .find((c) => c.getExpression().getText() === calleeText);
      if (!call) throw new Error(`no call to ${calleeText} in ${path}`);
      return call;
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `core/src/indexer/origin.test.ts`:

```ts
import { Node } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';
import { moduleOf, packageOf } from './calls.js';

describe('moduleOf', () => {
  it('normalises import specifiers to module names', () => {
    expect(moduleOf('node:events')).toBe('events');
    expect(moduleOf('@prisma/client/runtime')).toBe('@prisma/client');
    expect(moduleOf('axios/lib/core')).toBe('axios');
    expect(moduleOf('pg')).toBe('pg');
  });
});

describe('packageOf', () => {
  const { extractor, findCall } = snippetProject({
    'db/pool.ts': "import { Pool } from 'pg';\nexport const pool = new Pool();",
    'db/redis.ts': "import Redis from 'ioredis';\nexport const redis = new Redis();",
    'svc.ts': [
      "import { pool } from './db/pool';",
      "import { redis } from './db/redis';",
      "import { EventEmitter } from 'node:events';",
      "import type { PoolClient } from 'pg';",
      'const bus = new EventEmitter();',
      'export async function run(client: PoolClient) {',
      '  const c = await pool.connect();',
      "  await c.query('x');",
      "  await client.query('y');",
      "  await redis.get('k');",
      "  bus.emit('e');",
      "  fetch('u');",
      '  local();',
      '}',
      'function local() {}',
    ].join('\n'),
  });
  const receiverOf = (text: string) => {
    const callee = findCall('svc.ts', text).getExpression();
    return Node.isPropertyAccessExpression(callee) ? callee.getExpression() : callee;
  };

  it('traces a value through variables, awaits, imports and parameter types to its module', () => {
    expect(packageOf(receiverOf('c.query'), extractor.repo)).toBe('pg');
    expect(packageOf(receiverOf('client.query'), extractor.repo)).toBe('pg');
    expect(packageOf(receiverOf('redis.get'), extractor.repo)).toBe('ioredis');
    expect(packageOf(receiverOf('bus.emit'), extractor.repo)).toBe('events');
  });

  it('returns null for globals and repo functions', () => {
    expect(packageOf(receiverOf('fetch'), extractor.repo)).toBeNull();
    expect(packageOf(receiverOf('local'), extractor.repo)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run core/src/indexer/origin.test.ts`
Expected: FAIL. `moduleOf` / `packageOf` are not exported, and `extractor.repo` is undefined.

- [ ] **Step 4: Implement origin tracing in `calls.ts`**

In `core/src/indexer/calls.ts`:

1. Extend `RepoLookup`:

```ts
export interface RepoLookup {
  /** True for files that are part of the index. */
  isRepoFile(sourceFile: SourceFile): boolean;
  /** Key of the registered symbol for a declaration or function node, if any. */
  keyFor(node: Node): SymbolKey | null;
  /** Repo-relative path of a repo file. */
  pathOf(sourceFile: SourceFile): string;
}
```

2. Replace `type Origin = 'package' | 'unknown';` with:

```ts
/** Origin of a value declared outside the repo without an import, e.g. globals like `fetch` or `JSON`. */
const GLOBAL_ORIGIN = '<global>';
```

3. In `resolveCallee`, change the last line to:

```ts
  // 3. Where the root identifier came from.
  return originOfExpression(expr, repo, 0) !== null ? external : unresolved;
```

4. Replace `originOfExpression` and `originOfDeclaration` with versions that return the import specifier (or `GLOBAL_ORIGIN`), or null when the origin is unknown or inside the repo. Everything not shown stays identical to today's code:

```ts
/** The import specifier a value comes from (or GLOBAL_ORIGIN); null for repo values and unknown origins. */
function originOfExpression(expr: Node, repo: RepoLookup, depth: number): string | null {
  if (depth > MAX_TRACE_DEPTH) return null;
  const root = rootIdentifier(expr);
  if (!root || !Node.isIdentifier(root)) return null;
  const decl = root.getSymbol()?.getDeclarations()[0];
  if (!decl) return null;
  if (!repo.isRepoFile(decl.getSourceFile())) return GLOBAL_ORIGIN;
  return originOfDeclaration(decl, repo, depth + 1);
}

function originOfDeclaration(decl: Node, repo: RepoLookup, depth: number): string | null {
  if (depth > MAX_TRACE_DEPTH) return null;

  if (Node.isImportSpecifier(decl) || Node.isImportClause(decl) || Node.isNamespaceImport(decl)) {
    const importDecl = decl.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    const target = importDecl?.getModuleSpecifierSourceFile();
    if (!target || !repo.isRepoFile(target)) {
      const spec = importDecl?.getModuleSpecifierValue() ?? '';
      return spec.startsWith('.') ? null : spec;
    }
    const nameNode = Node.isImportSpecifier(decl) ? decl.getNameNode() : Node.isImportClause(decl) ? decl.getDefaultImport() : decl.getNameNode();
    const sym = nameNode?.getSymbol();
    const aliased = sym?.isAlias() ? sym.getAliasedSymbol() : undefined;
    const targetDecl = aliased?.getDeclarations()[0];
    return targetDecl ? originOfDeclaration(targetDecl, repo, depth + 1) : null;
  }

  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    return init ? originOfExpression(init, repo, depth + 1) : null;
  }

  if (Node.isBindingElement(decl)) {
    const owner = decl.getFirstAncestor((a) => Node.isVariableDeclaration(a) || Node.isParameterDeclaration(a));
    return owner ? originOfDeclaration(owner, repo, depth + 1) : null;
  }

  if (Node.isParameterDeclaration(decl)) {
    const typeNode = decl.getTypeNode();
    if (typeNode && Node.isTypeReference(typeNode)) {
      const typeName = typeNode.getTypeName();
      const left = Node.isQualifiedName(typeName) ? leftmost(typeName) : typeName;
      return originOfExpression(left, repo, depth + 1);
    }
    // An untyped parameter of an inline callback takes its origin from the call it's passed to,
    // e.g. `rows.map((r) => r.x())` or `promise.then((data) => ...)`.
    const fn = decl.getParent();
    const call = fn?.getParent();
    if (!typeNode && call && Node.isCallExpression(call) && call.getArguments().some((a) => a === fn)) {
      return originOfExpression(call.getExpression(), repo, depth + 1);
    }
  }

  return null;
}
```

5. Add these exports (after `resolveCallee`):

```ts
/**
 * The module a value was created from, e.g. "pg" for `client` in `const client = await pool.connect()`
 * where `pool = new Pool()` imports Pool from "pg"; "events" for "node:events". Null for values
 * declared in the repo, globals, and anything whose origin can't be traced.
 */
export function packageOf(expr: Node, repo: RepoLookup): string | null {
  const origin = originOfExpression(expr, repo, 0);
  return origin === null || origin === '' || origin === GLOBAL_ORIGIN ? null : moduleOf(origin);
}

/** "node:events" -> "events", "@prisma/client/runtime" -> "@prisma/client", "axios/lib" -> "axios". */
export function moduleOf(specifier: string): string {
  const bare = specifier.replace(/^node:/, '');
  const parts = bare.split('/');
  return bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The declaration an expression names, following imports; for `a.b` the declaration of `b`. */
export function declarationOf(expr: Node): Node | undefined {
  return firstDeclaration(symbolOf(expr));
}
```

6. Export `enclosingSymbol`: change `function enclosingSymbol(` to `export function enclosingSymbol(`.

- [ ] **Step 5: Expose the lookup on `Extractor`**

In `core/src/indexer/extract.ts`, import `type RepoLookup` from `./calls.js`, add a public field, and use it in `extract`:

```ts
import { collectCalls, type RepoLookup } from './calls.js';
```

```ts
export class Extractor {
  private readonly registries = new Map<string, FileSymbols>();
  private readonly versions: PackageVersions;
  /** How facts refer to repo files and symbols; shared by every collector. */
  readonly repo: RepoLookup;

  constructor(
    private readonly project: Project,
    private readonly repoRoot: string,
    /** Repo-relative paths of every indexed file (not just the ones being extracted). */
    private readonly repoPaths: Set<string>,
  ) {
    this.versions = new PackageVersions(repoRoot);
    this.repo = {
      isRepoFile: (sf) => this.repoPaths.has(this.relPath(sf)),
      keyFor: (node) => this.keyFor(node),
      pathOf: (sf) => this.relPath(sf),
    };
  }

  extract(path: string): ExtractedFacts {
    const sourceFile = this.sourceFile(path);
    const registry = this.registry(sourceFile);
    return {
      symbols: registry.symbols.map(({ bodyOwner: _, ...fact }) => fact),
      calls: collectCalls(sourceFile, registry.byNode, this.repo),
      imports: this.imports(sourceFile),
    };
  }
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run core/src/indexer`
Expected: PASS for `origin.test.ts` and the existing `indexer.test.ts`. The call-resolution behaviour is unchanged.

- [ ] **Step 7: Checkpoint (don't commit)**

Run: `pnpm test`. Expected: all previous tests still pass, plus the new ones.

---

### Task 2: Inline route handlers become `route_handler` symbols

**Files:**
- Modify: `core/src/indexer/symbols.ts`
- Test: `core/src/indexer/symbols.test.ts` (create)

**Interfaces:**
- Consumes: `snippetProject` (Task 1).
- Produces:
  - Anonymous functions with 2-4 parameters passed to `.get/.post/.put/.patch/.delete/.options/.head/.all/.use` are registered with kind `route_handler`, named `<receiver>.<method>[ <path>]` (e.g. `patientsRouter.get /:id`, `app.use`; with `.route('/x').post(fn)` the name is `r.post /x`). They're qualified by an enclosing symbol like any nested function.
  - `functionInitializer` is now exported.

- [ ] **Step 1: Write the failing test**

Create `core/src/indexer/symbols.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';

describe('inline route handlers', () => {
  const { facts } = snippetProject({
    'api/r.ts': [
      "import { Router } from 'express';",
      'export const r = Router();',
      "r.get('/items/:id', (req, res) => {",
      '  res.json(load(req.params.id));',
      '});',
      "r.route('/x').post(async function (req, res, next) { next(); });",
      'r.use((req, res, next) => next());',
      "new Map<string, number>().get('k');",
      '[1, 2].map((a, b) => a + b);',
      'function load(id: string) { return id; }',
    ].join('\n'),
  });

  it('registers inline handlers of route registrations as route_handler symbols', () => {
    const handlers = facts('api/r.ts').symbols.filter((s) => s.kind === 'route_handler');
    expect(handlers.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ['r.get /items/:id', 3, 5],
      ['r.post /x', 6, 6],
      ['r.use', 7, 7],
    ]);
  });

  it('attributes calls inside an inline handler to it', () => {
    const calls = facts('api/r.ts').calls.filter((c) => c.caller.name === 'r.get /items/:id');
    expect(calls.map((c) => c.calleeText)).toEqual(['load', 'res.json']);
    expect(calls[0].callee).toMatchObject({ file: 'api/r.ts', name: 'load' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run core/src/indexer/symbols.test.ts`
Expected: FAIL. No `route_handler` symbols, and the calls have no enclosing symbol.

- [ ] **Step 3: Implement**

In `core/src/indexer/symbols.ts`:

1. Add `type CallExpression` and `type PropertyAccessExpression` to the ts-morph import.

2. Add next to `REACT_WRAPPERS`:

```ts
// Express-style registrations whose inline function arguments become `route_handler` symbols.
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use']);
```

3. In `visit`, immediately before the last line (`node.forEachChild((c) => visit(c, owner, objectOwner));`), insert:

```ts
    // `router.get('/x', (req, res) => ...)`: the inline handler is a symbol, so it can be cited,
    // called from, and tagged with side effects.
    if (Node.isCallExpression(node)) {
      const base = routeCallName(node);
      if (base) {
        visit(node.getExpression(), owner, objectOwner);
        for (const arg of node.getArguments()) {
          for (const item of Node.isArrayLiteralExpression(arg) ? arg.getElements() : [arg]) {
            const fn = unwrap(item);
            if (fn && isInlineHandler(fn)) {
              const sym: RegisteredSymbol = { ...functionSymbol(qualify(base), fn, fn, false, 'function'), kind: 'route_handler' };
              register(sym, fn);
              fn.forEachChild((c) => visit(c, sym, null));
            } else {
              visit(item, owner, objectOwner);
            }
          }
        }
        return;
      }
    }
```

4. Export `functionInitializer` (change `function functionInitializer(` to `export function functionInitializer(`).

5. Add at the end of the file:

```ts
/** "app.use", "patientsRouter.get /:id", "r.post /x" for `r.route('/x').post(...)`; null when not an Express-style registration. */
function routeCallName(call: CallExpression): string | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || !ROUTE_METHODS.has(callee.getName())) return null;
  let receiver: Node = callee.getExpression();
  let path: Node | undefined = call.getArguments()[0];
  while (Node.isCallExpression(receiver) && Node.isPropertyAccessExpression(receiver.getExpression())) {
    const inner = receiver.getExpression() as PropertyAccessExpression;
    if (inner.getName() === 'route') {
      path = receiver.getArguments()[0];
      receiver = inner.getExpression();
      break;
    }
    if (!ROUTE_METHODS.has(inner.getName())) break;
    receiver = inner.getExpression();
  }
  const literal = path && (Node.isStringLiteral(path) || Node.isNoSubstitutionTemplateLiteral(path)) ? ` ${path.getLiteralText()}` : '';
  return `${receiver.getText().replace(/\s+/g, '')}.${callee.getName()}${literal}`;
}

/** An anonymous function taking (req, res), (req, res, next) or (err, req, res, next). */
function isInlineHandler(node: Node): boolean {
  const anonymous = Node.isArrowFunction(node) || (Node.isFunctionExpression(node) && !node.getName());
  if (!anonymous) return false;
  const params = (node as { getParameters(): Node[] }).getParameters().length;
  return params >= 2 && params <= 4;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run core/src/indexer`
Expected: PASS. The fixture has no inline handlers, so the existing indexer tests are unchanged.

- [ ] **Step 5: Checkpoint (don't commit)**

---

### Task 3: Express registration facts (`router_calls`)

**Files:**
- Create: `core/src/indexer/routers.ts`
- Modify: `core/src/store/types.ts` (fact types only; store wiring is Task 6)
- Modify: `core/src/indexer/extract.ts`
- Test: `core/src/indexer/routers.test.ts`

**Interfaces:**
- Consumes: `packageOf`, `declarationOf`, `calleeText`, `RepoLookup` (Task 1); `functionInitializer`, `unwrap` (Task 2).
- Produces (in `store/types.ts`):

```ts
export type HandlerArg =
  | { kind: 'symbol'; key: SymbolKey; arity: number; text: string }
  | { kind: 'inline'; key: SymbolKey; arity: number; text: string }
  | { kind: 'factory'; factory: SymbolKey; key: SymbolKey | null; arity: number | null; text: string }
  | { kind: 'router'; receiverKey: string; text: string }
  | { kind: 'package'; package: string; text: string }
  | { kind: 'unresolved'; text: string };

export interface RouterCallFact { receiver: { key: string; kind: 'app' | 'router' } | null; receiverText: string; callKind: 'use' | 'route'; method: string | null; path: string | null; pathText: string | null; line: number; endLine: number; orderIdx: number; handlers: HandlerArg[] }
```

- `collectRouterCalls(sourceFile: SourceFile, repo: RepoLookup): RouterCallFact[]`
- `ExtractedFacts.routerCalls: RouterCallFact[]`

- [ ] **Step 1: Add the fact types**

Append to `core/src/store/types.ts` (after `ImportFact`):

```ts
/** One handler argument of an Express registration, classified by what it refers to. */
export type HandlerArg =
  /** A repo function passed by name, e.g. `requireAuth`. arity = parameter count (4 = error handler). */
  | { kind: 'symbol'; key: SymbolKey; arity: number; text: string }
  /** An inline function, registered as a `route_handler` symbol. */
  | { kind: 'inline'; key: SymbolKey; arity: number; text: string }
  /** A call to a repo function that returns the middleware, e.g. `validate(schema)`; key is the returned function when identifiable. */
  | { kind: 'factory'; factory: SymbolKey; key: SymbolKey | null; arity: number | null; text: string }
  /** Another app or router mounted here; receiverKey is "<file>#<variable>". */
  | { kind: 'router'; receiverKey: string; text: string }
  /** Middleware from a package, e.g. `express.json()`. */
  | { kind: 'package'; package: string; text: string }
  | { kind: 'unresolved'; text: string };

/** An Express registration: app.use / router.<verb> / router.route(p).<verb>. */
export interface RouterCallFact {
  /** The app or router registered on: "<file>#<variable>"; null for an Express value we can't place (e.g. a parameter). */
  receiver: { key: string; kind: 'app' | 'router' } | null;
  receiverText: string;
  callKind: 'use' | 'route';
  /** GET, POST, ..., ALL for routes; null for use. */
  method: string | null;
  /** The path literal; null when there is no path argument or it isn't a literal (see pathText). */
  path: string | null;
  /** Source text of a non-literal path argument. */
  pathText: string | null;
  line: number;
  endLine: number;
  /** Registration order within the file. */
  orderIdx: number;
  handlers: HandlerArg[];
}
```

- [ ] **Step 2: Write the failing test**

Create `core/src/indexer/routers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';

const { facts } = snippetProject({
  'api/app.ts': [
    "import express from 'express';",
    "import { api } from './routes';",
    "import { onError } from './errors';",
    'export const app = express();',
    'app.use(express.json());',
    "app.use('/api', api);",
    'app.use(onError);',
  ].join('\n'),
  'api/routes.ts': [
    "import { Router } from 'express';",
    "import { auth, validate, list } from './handlers';",
    'export const api = Router();',
    'api.use(auth);',
    "api.post('/items', [validate('item')], list);",
    "api.route('/items/:id').get(list).delete(auth, list);",
    "api.get('/inline', (req, res) => res.end());",
    "api.get('env');",
  ].join('\n'),
  'api/handlers.ts': [
    'export function auth(req: any, res: any, next: any) { next(); }',
    'export function validate(schema: string) {',
    '  return function check(req: any, res: any, next: any) { next(); };',
    '}',
    'export const list = (req: any, res: any) => res.end();',
  ].join('\n'),
  'api/errors.ts': 'export function onError(err: any, req: any, res: any, next: any) { res.end(); }',
  'api/plugin.ts': [
    "import type { Express } from 'express';",
    "import { list } from './handlers';",
    'export function register(app: Express) {',
    "  app.get('/plugin', list);",
    '}',
  ].join('\n'),
});

describe('collectRouterCalls', () => {
  it('records app registrations: package middleware, mounted routers and error handlers', () => {
    expect(facts('api/app.ts').routerCalls).toEqual([
      {
        receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null,
        path: null, pathText: null, line: 5, endLine: 5, orderIdx: 0,
        handlers: [{ kind: 'package', package: 'express', text: 'express.json()' }],
      },
      {
        receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null,
        path: '/api', pathText: null, line: 6, endLine: 6, orderIdx: 1,
        handlers: [{ kind: 'router', receiverKey: 'api/routes.ts#api', text: 'api' }],
      },
      {
        receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null,
        path: null, pathText: null, line: 7, endLine: 7, orderIdx: 2,
        handlers: [{ kind: 'symbol', key: { file: 'api/errors.ts', name: 'onError', startLine: 1 }, arity: 4, text: 'onError' }],
      },
    ]);
  });

  it('records routes with factories, arrays, .route() chains and inline handlers, and skips settings reads', () => {
    expect(facts('api/routes.ts').routerCalls).toMatchObject([
      { receiver: { key: 'api/routes.ts#api', kind: 'router' }, callKind: 'use', path: null, line: 4, orderIdx: 0,
        handlers: [{ kind: 'symbol', key: { file: 'api/handlers.ts', name: 'auth', startLine: 1 }, arity: 3 }] },
      { callKind: 'route', method: 'POST', path: '/items', line: 5, orderIdx: 1,
        handlers: [
          { kind: 'factory', factory: { file: 'api/handlers.ts', name: 'validate', startLine: 2 },
            key: { file: 'api/handlers.ts', name: 'validate.check', startLine: 3 }, arity: 3, text: "validate('item')" },
          { kind: 'symbol', key: { file: 'api/handlers.ts', name: 'list', startLine: 5 }, arity: 2 },
        ] },
      { method: 'GET', path: '/items/:id', line: 6, orderIdx: 2, handlers: [{ kind: 'symbol', text: 'list' }] },
      { method: 'DELETE', path: '/items/:id', line: 6, orderIdx: 3, handlers: [{ text: 'auth' }, { text: 'list' }] },
      { method: 'GET', path: '/inline', line: 7, orderIdx: 4,
        handlers: [{ kind: 'inline', key: { file: 'api/routes.ts', name: 'api.get /inline', startLine: 7 }, arity: 2 }] },
    ]);
  });

  it('keeps registrations on Express values it cannot place, with a null receiver', () => {
    expect(facts('api/plugin.ts').routerCalls).toMatchObject([
      { receiver: null, receiverText: 'app', callKind: 'route', method: 'GET', path: '/plugin', line: 4 },
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run core/src/indexer/routers.test.ts`
Expected: FAIL. `routerCalls` is undefined.

- [ ] **Step 4: Implement `routers.ts`**

Create `core/src/indexer/routers.ts`:

```ts
import { Node, SyntaxKind, type ArrowFunction, type FunctionDeclaration, type FunctionExpression, type SourceFile } from 'ts-morph';
import type { HandlerArg, RouterCallFact } from '../store/types.js';
import { calleeText, declarationOf, packageOf, type RepoLookup } from './calls.js';
import { functionInitializer, unwrap } from './symbols.js';

// Express registrations (CLAUDE.md §6.3): every app.use / router.<verb> / router.route(p).<verb>
// on an app or router, with its path and handler arguments classified. Facts stay per file; the
// store stitches mounts across files into full routes (routes/stitch.ts).

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const MAX_TEXT = 60;

type FunctionLike = FunctionDeclaration | FunctionExpression | ArrowFunction;

export function collectRouterCalls(sourceFile: SourceFile, repo: RepoLookup): RouterCallFact[] {
  const facts: Omit<RouterCallFact, 'orderIdx'>[] = [];
  // Chained calls share a start; the inner one (`.get`) was registered before the outer (`.delete`).
  const calls = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .sort((a, b) => a.getStart() - b.getStart() || a.getEnd() - b.getEnd());

  for (const call of calls) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const name = callee.getName();
    if (name !== 'use' && !VERBS.has(name)) continue;

    const base = routeBase(callee.getExpression());
    const receiver = routerOf(base.receiver, repo);
    if (receiver === undefined) continue; // not an Express app or router

    const args = call.getArguments();
    let pathArg: Node | undefined;
    let handlerArgs: Node[];
    if (base.path) {
      pathArg = base.path;
      handlerArgs = args;
    } else if (name !== 'use' || (args.length > 1 && isPathLike(args[0]))) {
      pathArg = args[0];
      handlerArgs = args.slice(1);
    } else {
      handlerArgs = args;
    }
    const handlers = handlerArgs
      .flatMap((a) => (Node.isArrayLiteralExpression(a) ? a.getElements() : [a]))
      .map((a) => classifyHandler(a, repo));
    if (handlers.length === 0) continue; // e.g. app.get('env'): a settings read, not a route

    const literal = pathArg ? pathLiteral(pathArg) : null;
    facts.push({
      receiver,
      receiverText: oneLine(base.receiver.getText()),
      callKind: name === 'use' ? 'use' : 'route',
      method: name === 'use' ? null : name.toUpperCase(),
      path: literal,
      pathText: pathArg && literal === null ? oneLine(pathArg.getText()) : null,
      line: call.getStartLineNumber(),
      endLine: call.getEndLineNumber(),
      handlers,
    });
  }
  return facts.map((f, orderIdx) => ({ ...f, orderIdx }));
}

/** For `r.route('/x').get(a).post(b)`: the router `r` and the path '/x'. Otherwise the receiver itself. */
function routeBase(receiver: Node): { receiver: Node; path?: Node } {
  let r = receiver;
  while (Node.isCallExpression(r)) {
    const inner = r.getExpression();
    if (!Node.isPropertyAccessExpression(inner)) break;
    if (inner.getName() === 'route') return { receiver: inner.getExpression(), path: r.getArguments()[0] };
    if (!VERBS.has(inner.getName())) break;
    r = inner.getExpression();
  }
  return { receiver: r };
}

/**
 * The app or router `expr` refers to; null for an Express value that isn't a router declared in the
 * repo (a parameter typed Express, a value returned from elsewhere); undefined for anything else.
 */
function routerOf(expr: Node, repo: RepoLookup): RouterCallFact['receiver'] | undefined {
  const decl = declarationOf(expr);
  if (decl && Node.isVariableDeclaration(decl) && repo.isRepoFile(decl.getSourceFile())) {
    const kind = routerKind(decl.getInitializer(), repo);
    if (kind) return { key: `${repo.pathOf(decl.getSourceFile())}#${decl.getName()}`, kind };
  }
  return packageOf(expr, repo) === 'express' ? null : undefined;
}

/** "app" for express(), "router" for Router() / express.Router(); null for anything else. */
function routerKind(init: Node | undefined, repo: RepoLookup): 'app' | 'router' | null {
  const call = unwrap(init);
  if (!call || !Node.isCallExpression(call)) return null;
  const callee = call.getExpression();
  if (packageOf(callee, repo) !== 'express') return null;
  return calleeText(callee).endsWith('Router') ? 'router' : 'app';
}

function classifyHandler(arg: Node, repo: RepoLookup): HandlerArg {
  const node = unwrap(arg) ?? arg;
  const text = oneLine(node.getText());

  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const key = repo.keyFor(node);
    return key ? { kind: 'inline', key, arity: node.getParameters().length, text } : { kind: 'unresolved', text };
  }

  if (Node.isCallExpression(node)) {
    const decl = declarationOf(node.getExpression());
    const fn = decl && repo.isRepoFile(decl.getSourceFile()) ? functionOf(decl) : undefined;
    const factory = fn && decl ? repo.keyFor(decl) : null;
    if (fn && factory) {
      const returned = returnedFunction(fn);
      return {
        kind: 'factory',
        factory,
        key: returned ? repo.keyFor(returned) : null,
        arity: returned ? returned.getParameters().length : null,
        text,
      };
    }
  } else {
    const decl = declarationOf(node);
    if (decl && repo.isRepoFile(decl.getSourceFile())) {
      if (Node.isVariableDeclaration(decl) && routerKind(decl.getInitializer(), repo)) {
        return { kind: 'router', receiverKey: `${repo.pathOf(decl.getSourceFile())}#${decl.getName()}`, text };
      }
      const fn = functionOf(decl);
      const key = fn ? repo.keyFor(decl) : null;
      if (fn && key) return { kind: 'symbol', key, arity: fn.getParameters().length, text };
    }
  }

  const pkg = packageOf(node, repo);
  return pkg ? { kind: 'package', package: pkg, text } : { kind: 'unresolved', text };
}

function functionOf(decl: Node): FunctionLike | undefined {
  if (Node.isFunctionDeclaration(decl)) return decl;
  if (Node.isVariableDeclaration(decl)) return functionInitializer(decl.getInitializer()) as FunctionLike | undefined;
  return undefined;
}

/** The single function a factory returns, e.g. `return function validateBody(...) {...}`. */
function returnedFunction(fn: FunctionLike): ArrowFunction | FunctionExpression | undefined {
  const body = fn.getBody();
  if (!body) return undefined;
  const candidates = Node.isBlock(body)
    ? body
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter((r) => r.getFirstAncestor((a) => Node.isFunctionDeclaration(a) || Node.isFunctionExpression(a) || Node.isArrowFunction(a) || Node.isMethodDeclaration(a)) === fn)
        .map((r) => unwrap(r.getExpression()))
    : [unwrap(body)];
  const fns = candidates.filter((c): c is ArrowFunction | FunctionExpression => !!c && (Node.isArrowFunction(c) || Node.isFunctionExpression(c)));
  return fns.length === 1 ? fns[0] : undefined;
}

function isPathLike(node: Node): boolean {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isTemplateExpression(node)) return true;
  const type = node.getType();
  return type.isString() || type.isStringLiteral();
}

function pathLiteral(node: Node): string | null {
  return Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) ? node.getLiteralText() : null;
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TEXT ? `${collapsed.slice(0, MAX_TEXT - 1)}…` : collapsed;
}
```

- [ ] **Step 5: Wire it into extraction**

In `core/src/indexer/extract.ts`:

```ts
import type { CallFact, ImportFact, RouterCallFact, SymbolFact, SymbolKey } from '../store/types.js';
import { collectRouterCalls } from './routers.js';
```

```ts
export interface ExtractedFacts {
  symbols: SymbolFact[];
  calls: CallFact[];
  imports: ImportFact[];
  routerCalls: RouterCallFact[];
}
```

and in `extract` add `routerCalls: collectRouterCalls(sourceFile, this.repo),` after `imports`.

In `core/src/store/types.ts`, add the optional field to `FileFacts` (the store persists it in Task 6):

```ts
  imports: ImportFact[];
  /** Express registrations in this file (Phase 3). */
  routerCalls?: RouterCallFact[];
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run core/src/indexer`
Expected: PASS. If the `.route().get().delete()` order is reversed, check the sort in `collectRouterCalls`: the inner call must come first.

- [ ] **Step 7: Checkpoint (don't commit)**

---

### Task 4: Side-effect facts

**Files:**
- Create: `core/src/indexer/sideEffects.ts`
- Modify: `core/src/store/types.ts`, `core/src/indexer/extract.ts`
- Test: `core/src/indexer/sideEffects.test.ts`

**Interfaces:**
- Consumes: `packageOf`, `declarationOf`, `calleeText`, `enclosingSymbol` (Task 1); `unwrap`.
- Produces:
  - `SideEffectKind`, `SideEffectFact { symbol: { name; startLine }; kind; detail; line }` in `store/types.ts`
  - `collectSideEffects(sourceFile, byNode, repo): SideEffectFact[]`
  - `sqlEffects(sql: string): { kind: 'db_read' | 'db_write'; detail: string }[]`
  - `ExtractedFacts.sideEffects`
  - Detail formats:
    - SQL: `SELECT <table>`, `INSERT <table>`, `UPDATE <table>`, `UPSERT <table>`, `DELETE <table>`
    - Redis: `<COMMAND> <key>`
    - HTTP: `<METHOD> <url>`
    - queue: `emit <event> (in-process)`, `add <job> (bullmq)`, `publish|sendToQueue <x> (amqp)`
    - throws: `<ErrorClass> (<status>)`, `<ErrorClass>`, `rethrows <name>`, `forwards <name>`

- [ ] **Step 1: Add the types**

In `core/src/store/types.ts`, after `CallFact`:

```ts
export type SideEffectKind = 'db_read' | 'db_write' | 'redis' | 'http_out' | 'queue' | 'throws';

/** Something a symbol does beyond computing a value, found statically (CLAUDE.md §6.3 item 4). */
export interface SideEffectFact {
  symbol: Pick<SymbolKey, 'name' | 'startLine'>;
  kind: SideEffectKind;
  /** e.g. "INSERT consents", "GET session:${token}", "ConflictError (409)". */
  detail: string;
  line: number;
}
```

and add `sideEffects?: SideEffectFact[];` to `FileFacts` after `routerCalls`.

- [ ] **Step 2: Write the failing test**

Create `core/src/indexer/sideEffects.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';
import { sqlEffects } from './sideEffects.js';

describe('sqlEffects', () => {
  it('reads tables from FROM/JOIN and writes from INSERT/UPDATE/DELETE', () => {
    expect(sqlEffects('SELECT * FROM unnest($1::int[]) AS x JOIN patients p ON true')).toEqual([{ kind: 'db_read', detail: 'SELECT patients' }]);
    expect(sqlEffects('UPDATE "public"."patients" SET a = 1 FROM consents WHERE x')).toEqual([
      { kind: 'db_write', detail: 'UPDATE public.patients' },
      { kind: 'db_read', detail: 'SELECT consents' },
    ]);
    expect(sqlEffects('INSERT INTO patients (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET id = $1')).toEqual([{ kind: 'db_write', detail: 'INSERT patients' }]);
  });

  it('ignores transaction control and empty text', () => {
    expect(sqlEffects('BEGIN')).toEqual([]);
    expect(sqlEffects('  commit')).toEqual([]);
    expect(sqlEffects('')).toEqual([]);
  });
});

describe('collectSideEffects', () => {
  const { facts } = snippetProject({
    'db.ts': "import { Pool } from 'pg';\nimport Redis from 'ioredis';\nexport const pool = new Pool();\nexport const redis = new Redis();",
    'errors.ts': [
      'export class HttpError extends Error {',
      '  constructor(public status: number, message: string) { super(message); }',
      '}',
      'export class Conflict extends HttpError {',
      '  constructor(message: string) { super(409, message); }',
      '}',
      'export class DuplicatePhone extends Conflict {}',
    ].join('\n'),
    'svc.ts': [
      "import { pool, redis } from './db';",
      "import { Conflict, DuplicatePhone } from './errors';",
      "import { EventEmitter } from 'node:events';",
      'const bus = new EventEmitter();',
      'const FIND = `SELECT * FROM patients p JOIN consents c ON c.patient_id = p.id WHERE p.id = $1`;',
      'export async function enroll(id: string, next: (err?: unknown) => void) {',
      '  await pool.query(FIND, [id]);',
      '  const client = await pool.connect();',
      "  await client.query('BEGIN');",
      '  await client.query(`INSERT INTO patients (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET id = $1`, [id]);',
      "  await client.query('DELETE FROM sessions WHERE id = $1', [id]);",
      "  await redis.set(`patient:${id}`, '1', 'EX', 60);",
      "  redis.on('error', () => {});",
      "  bus.emit('patient.enrolled', id);",
      "  await fetch(`https://sms.example.com/v1/${id}`, { method: 'post' });",
      "  if (!id) throw new Conflict('dup');",
      "  if (id === 'x') throw new DuplicatePhone('again');",
      "  try { await fetch('https://a.example.com'); } catch (err) { throw err; }",
      "  next(new Conflict('via next'));",
      '  next();',
      '}',
    ].join('\n'),
    'other.ts': [
      "import knex from 'knex';",
      "import axios from 'axios';",
      "import { PrismaClient } from '@prisma/client';",
      "import https from 'node:https';",
      "import { Queue } from 'bullmq';",
      "const db = knex({ client: 'pg' });",
      'const prisma = new PrismaClient();',
      "const emails = new Queue('emails');",
      'export async function sync() {',
      "  await db('orders').where({ id: 1 }).first();",
      "  await db.insert({ id: 1 }).into('audit');",
      '  await prisma.patient.findMany();',
      '  await prisma.patient.upsert({});',
      "  await axios.post('https://api.example.com/hooks', {});",
      "  https.get('https://status.example.com');",
      "  await emails.add('welcome', {});",
      '}',
    ].join('\n'),
  });
  const summary = (path: string) => facts(path).sideEffects.map((e) => `${e.line} ${e.kind} ${e.detail}`);

  it('tags pg SQL, Redis, events, fetch and thrown or forwarded errors with their HTTP status', () => {
    expect(summary('svc.ts')).toEqual([
      '7 db_read SELECT consents',
      '7 db_read SELECT patients',
      '10 db_write INSERT patients',
      '11 db_write DELETE sessions',
      '12 redis SET patient:${id}',
      '14 queue emit patient.enrolled (in-process)',
      '15 http_out POST https://sms.example.com/v1/${id}',
      '16 throws Conflict (409)',
      '17 throws DuplicatePhone (409)',
      '18 http_out GET https://a.example.com',
      '18 throws rethrows err',
      '19 throws Conflict (409)',
    ]);
    expect(new Set(facts('svc.ts').sideEffects.map((e) => `${e.symbol.name}:${e.symbol.startLine}`))).toEqual(new Set(['enroll:6']));
  });

  it('tags knex, prisma, axios, node https and bullmq', () => {
    expect(summary('other.ts')).toEqual([
      '10 db_read SELECT orders',
      '11 db_write INSERT audit',
      '12 db_read SELECT patient',
      '13 db_write UPSERT patient',
      '14 http_out POST https://api.example.com/hooks',
      '15 http_out GET https://status.example.com',
      '16 queue add welcome (bullmq)',
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run core/src/indexer/sideEffects.test.ts`
Expected: FAIL. The module `./sideEffects.js` doesn't exist.

- [ ] **Step 4: Implement `sideEffects.ts`**

Create `core/src/indexer/sideEffects.ts`:

```ts
import { Node, SyntaxKind, type CallExpression, type ClassDeclaration, type PropertyAccessExpression, type SourceFile } from 'ts-morph';
import type { SideEffectFact, SideEffectKind } from '../store/types.js';
import { calleeText, declarationOf, enclosingSymbol, packageOf, type RepoLookup } from './calls.js';
import { unwrap, type RegisteredSymbol } from './symbols.js';

// Side effects per symbol (CLAUDE.md §6.3 item 4), recognised by the module a receiver comes from:
// SQL through pg / knex / prisma, Redis commands, outbound HTTP, event and queue publishes, and
// errors thrown or passed to Express's `next`. Anything unrecognised is left untagged, not guessed.

interface Effect {
  kind: SideEffectKind;
  detail: string;
}

const REDIS_NOT_COMMANDS = new Set(['on', 'once', 'off', 'removeListener', 'connect', 'disconnect', 'quit', 'duplicate', 'pipeline', 'multi', 'exec', 'defineCommand']);
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);
const KNEX_READ = new Set(['select', 'first', 'pluck']);
const KNEX_WRITE: Record<string, string> = { insert: 'INSERT', update: 'UPDATE', del: 'DELETE', delete: 'DELETE' };
const PRISMA_OPS: Record<string, string> = {
  findUnique: 'SELECT', findUniqueOrThrow: 'SELECT', findFirst: 'SELECT', findFirstOrThrow: 'SELECT', findMany: 'SELECT',
  count: 'SELECT', aggregate: 'SELECT', groupBy: 'SELECT',
  create: 'INSERT', createMany: 'INSERT', update: 'UPDATE', updateMany: 'UPDATE', upsert: 'UPSERT', delete: 'DELETE', deleteMany: 'DELETE',
};
const SQL_TARGET = /\b(FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+("?[A-Za-z_][\w$]*"?(?:\."?[A-Za-z_][\w$]*"?)?)/gi;
const NOT_TABLES = new Set(['SET', 'SELECT', 'VALUES', 'LATERAL', 'ONLY', 'DEFAULT']);
const TRANSACTION = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION|SET)\b/i;
const MAX_TEXT = 80;

export function collectSideEffects(sourceFile: SourceFile, byNode: Map<unknown, RegisteredSymbol>, repo: RepoLookup): SideEffectFact[] {
  const facts = new Map<string, SideEffectFact>();
  const add = (node: Node, effect: Effect) => {
    const owner = enclosingSymbol(node, byNode);
    if (!owner) return;
    const line = node.getStartLineNumber();
    facts.set(`${owner.name}:${owner.startLine}:${effect.kind}:${effect.detail}:${line}`, {
      symbol: { name: owner.name, startLine: owner.startLine },
      ...effect,
      line,
    });
  };

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    for (const effect of callEffects(call, repo)) add(call, effect);
  }
  for (const statement of sourceFile.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
    add(statement, { kind: 'throws', detail: thrownDetail(statement.getExpression(), 'rethrows') });
  }
  return [...facts.values()].sort((a, b) => a.line - b.line || a.detail.localeCompare(b.detail));
}

/** Tables a SQL string reads and writes. Transaction control (BEGIN, COMMIT, ...) has none. */
export function sqlEffects(sql: string): { kind: 'db_read' | 'db_write'; detail: string }[] {
  if (!sql.trim() || TRANSACTION.test(sql)) return [];
  const out = new Map<string, { kind: 'db_read' | 'db_write'; detail: string }>();
  for (const m of sql.matchAll(SQL_TARGET)) {
    const keyword = m[1].toUpperCase().replace(/\s+/g, ' ');
    const table = m[2].replaceAll('"', '');
    if (NOT_TABLES.has(table.toUpperCase())) continue;
    const isRead = keyword === 'FROM' || keyword === 'JOIN';
    // `FROM unnest(...)`: a function, not a table.
    if (isRead && /^\s*\(/.test(sql.slice((m.index ?? 0) + m[0].length))) continue;
    const effect = isRead ? { kind: 'db_read' as const, detail: `SELECT ${table}` } : { kind: 'db_write' as const, detail: `${keyword.split(' ')[0]} ${table}` };
    out.set(`${effect.kind} ${effect.detail}`, effect);
  }
  return [...out.values()];
}

function callEffects(call: CallExpression, repo: RepoLookup): Effect[] {
  const callee = unwrap(call.getExpression()) ?? call.getExpression();
  const args = call.getArguments();

  if (Node.isIdentifier(callee)) {
    const name = callee.getText();
    if (name === 'next' && args[0] && isParameter(callee)) return [{ kind: 'throws', detail: thrownDetail(args[0], 'forwards') }];
    if (name === 'fetch' && !declaredInRepo(callee, repo)) return [http(optionMethod(args[1]) ?? 'GET', args[0])];
    const pkg = packageOf(callee, repo);
    if (pkg === 'axios' || pkg === 'got') return [http(optionMethod(args[1] ?? args[0]) ?? 'GET', args[0])];
    return [];
  }
  if (!Node.isPropertyAccessExpression(callee)) return [];

  const method = callee.getName();
  switch (packageOf(callee.getExpression(), repo)) {
    case 'pg':
      return method === 'query' ? sqlEffects(literalText(args[0]) ?? '') : [];
    case 'ioredis':
    case 'redis':
      return REDIS_NOT_COMMANDS.has(method) ? [] : [{ kind: 'redis', detail: `${method.toUpperCase()} ${argText(args[0])}`.trim() }];
    case 'axios':
    case 'got':
      return HTTP_VERBS.has(method) && method !== 'request' ? [http(method.toUpperCase(), args[0])] : [];
    case 'http':
    case 'https':
      if (method === 'get') return [http('GET', args[0])];
      return method === 'request' ? [http(optionMethod(args[1] ?? args[0]) ?? 'GET', args[0])] : [];
    case 'events':
      return method === 'emit' ? [{ kind: 'queue', detail: `emit ${argText(args[0])} (in-process)` }] : [];
    case 'bullmq':
      return method === 'add' ? [{ kind: 'queue', detail: `add ${argText(args[0])} (bullmq)` }] : [];
    case 'amqplib':
      return method === 'publish' || method === 'sendToQueue' ? [{ kind: 'queue', detail: `${method} ${argText(args[0])} (amqp)` }] : [];
    case 'knex':
      return knexEffects(call, method);
    case '@prisma/client':
      return prismaEffects(callee, method);
    default:
      return [];
  }
}

function http(method: string, url: Node | undefined): Effect {
  return { kind: 'http_out', detail: `${method} ${urlText(url)}`.trim() };
}

function knexEffects(call: CallExpression, method: string): Effect[] {
  const verb = KNEX_READ.has(method) ? 'SELECT' : KNEX_WRITE[method];
  if (!verb) return [];
  return [{ kind: verb === 'SELECT' ? 'db_read' : 'db_write', detail: `${verb} ${knexTable(call) ?? '?'}` }];
}

/** The table of a knex chain: `knex('t')...`, `.from('t')`, `.into('t')` or `.table('t')`, anywhere in the chain. */
function knexTable(call: CallExpression): string | null {
  let top: Node = call;
  while (Node.isPropertyAccessExpression(top.getParent()) && Node.isCallExpression(top.getParent()!.getParent())) {
    top = top.getParent()!.getParent()!;
  }
  for (let n: Node = top; Node.isCallExpression(n); ) {
    const callee = n.getExpression();
    if (Node.isIdentifier(callee)) return literalText(n.getArguments()[0]);
    if (!Node.isPropertyAccessExpression(callee)) return null;
    if (['from', 'into', 'table'].includes(callee.getName())) return literalText(n.getArguments()[0]);
    n = callee.getExpression();
  }
  return null;
}

function prismaEffects(callee: PropertyAccessExpression, method: string): Effect[] {
  const verb = PRISMA_OPS[method];
  const model = callee.getExpression();
  if (!verb || !Node.isPropertyAccessExpression(model)) return [];
  return [{ kind: verb === 'SELECT' ? 'db_read' : 'db_write', detail: `${verb} ${model.getName()}` }];
}

/** "ConflictError (409)" for `new ConflictError()`, "rethrows err" / "forwards err" for a passed-on value. */
function thrownDetail(expr: Node | undefined, passOn: 'rethrows' | 'forwards'): string {
  const n = unwrap(expr);
  if (n && Node.isNewExpression(n)) {
    const name = calleeText(n.getExpression());
    const decl = declarationOf(n.getExpression());
    const status = decl && Node.isClassDeclaration(decl) ? statusOfClass(decl, 0) : null;
    return status === null ? name : `${name} (${status})`;
  }
  return `${passOn} ${n ? oneLine(n.getText()) : 'error'}`;
}

/** The literal HTTP status a class passes to its base constructor, following `extends` when it has no constructor. */
function statusOfClass(cls: ClassDeclaration, depth: number): number | null {
  if (depth > 5) return null;
  const ctor = cls.getConstructors()[0];
  if (!ctor) {
    const base = cls.getBaseClass();
    return base ? statusOfClass(base, depth + 1) : null;
  }
  const superCall = ctor.getDescendantsOfKind(SyntaxKind.CallExpression).find((c) => c.getExpression().getKind() === SyntaxKind.SuperKeyword);
  const first = superCall?.getArguments()[0];
  if (!first || !Node.isNumericLiteral(first)) return null;
  const status = Number(first.getLiteralValue());
  return status >= 100 && status <= 599 ? status : null;
}

/** Text of a string/template literal, or of a const initialised with one (followed through imports). */
function literalText(node: Node | undefined, depth = 0): string | null {
  const n = unwrap(node);
  if (!n || depth > 3) return null;
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
  if (Node.isTemplateExpression(n)) return n.getText().slice(1, -1);
  if (Node.isIdentifier(n)) {
    const decl = declarationOf(n);
    if (decl && Node.isVariableDeclaration(decl)) return literalText(decl.getInitializer(), depth + 1);
  }
  return null;
}

function argText(node: Node | undefined): string {
  return literalText(node) ?? (node ? oneLine(node.getText()) : '');
}

/** URL of fetch/axios/http: the first argument, or its `url` property when it's an options object. */
function urlText(node: Node | undefined): string {
  const n = unwrap(node);
  if (n && Node.isObjectLiteralExpression(n)) return argText(propertyValue(n, 'url'));
  return argText(n);
}

/** The literal `method` of an options object, upper-cased. */
function optionMethod(node: Node | undefined): string | null {
  const n = unwrap(node);
  if (!n || !Node.isObjectLiteralExpression(n)) return null;
  return literalText(propertyValue(n, 'method'))?.toUpperCase() ?? null;
}

function propertyValue(obj: Node, name: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  const prop = obj.getProperty(name);
  return prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
}

function isParameter(id: Node): boolean {
  const decl = declarationOf(id);
  return !!decl && Node.isParameterDeclaration(decl);
}

function declaredInRepo(id: Node, repo: RepoLookup): boolean {
  const decl = declarationOf(id);
  return !!decl && repo.isRepoFile(decl.getSourceFile());
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TEXT ? `${collapsed.slice(0, MAX_TEXT - 1)}…` : collapsed;
}
```

- [ ] **Step 5: Wire it into extraction**

In `core/src/indexer/extract.ts`, import `collectSideEffects` and `type SideEffectFact`, add `sideEffects: SideEffectFact[]` to `ExtractedFacts`, and add `sideEffects: collectSideEffects(sourceFile, registry.byNode, this.repo),` to `extract`.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run core/src/indexer`
Expected: PASS. If `DuplicatePhone (409)` comes out as `DuplicatePhone`, check that `getBaseClass()` resolves in the in-memory project. If it doesn't, fall back to `cls.getExtends()?.getExpression()` + `declarationOf`.

- [ ] **Step 7: Checkpoint (don't commit)**

---

### Task 5: Stitching registrations into routes (pure)

**Files:**
- Create: `core/src/routes/stitch.ts`
- Modify: `core/src/store/types.ts`
- Test: `core/src/routes/stitch.test.ts`

**Interfaces:**
- Consumes: `HandlerArg`, `RouterCallFact` (Task 3).
- Produces (types in `store/types.ts`):

```ts
export type MiddlewarePhase = 'app' | 'router' | 'route' | 'error';
export interface RouterCallRecord extends RouterCallFact { file: string }
export interface MountFact { file: string; line: number; endLine: number; prefix: string }
```

- Produces (in `routes/stitch.ts`):
  - `stitchRoutes(calls: RouterCallRecord[]): StitchResult`
  - `StitchedRoute { method; fullPath; file; line; endLine; handler: HandlerArg; mountChain: MountFact[]; middleware: StitchedMiddleware[]; warnings: string[] }`
  - `StitchedMiddleware { phase; handler; file; line; endLine }`
  - `handlerKey(h): SymbolKey | null`, `handlerLabel(h): string`, `handlerNote(h, file, line): string | null`, `joinPath(prefix, path): string`

- [ ] **Step 1: Add the types**

Append to `core/src/store/types.ts`:

```ts
export type MiddlewarePhase = 'app' | 'router' | 'route' | 'error';

/** A RouterCallFact with the file it was found in, as stitching reads it back. */
export interface RouterCallRecord extends RouterCallFact {
  file: string;
}

/** One `use(prefix, router)` on the way from an app to a route. */
export interface MountFact {
  file: string;
  line: number;
  endLine: number;
  prefix: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `core/src/routes/stitch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { HandlerArg, RouterCallRecord } from '../store/types.js';
import { joinPath, stitchRoutes, type StitchedRoute } from './stitch.js';

const kindOf = (key: string) => (key.endsWith('#app') ? 'app' : 'router') as 'app' | 'router';
const base = (file: string, receiver: string, line: number) => ({
  file, receiver: { key: receiver, kind: kindOf(receiver) }, receiverText: receiver.split('#')[1], pathText: null, line, endLine: line, orderIdx: line,
});
const use = (file: string, receiver: string, line: number, path: string | null, ...handlers: HandlerArg[]): RouterCallRecord => ({
  ...base(file, receiver, line), callKind: 'use', method: null, path, handlers,
});
const route = (file: string, receiver: string, line: number, method: string, path: string, ...handlers: HandlerArg[]): RouterCallRecord => ({
  ...base(file, receiver, line), callKind: 'route', method, path, handlers,
});
const sym = (file: string, name: string, arity = 3): HandlerArg => ({ kind: 'symbol', key: { file, name, startLine: 1 }, arity, text: name });
const router = (receiverKey: string): HandlerArg => ({ kind: 'router', receiverKey, text: receiverKey.split('#')[1] });
const pkg = (text: string): HandlerArg => ({ kind: 'package', package: 'express', text });
const summary = (routes: StitchedRoute[]) =>
  routes.map((r) => `${r.method} ${r.fullPath} -> ${r.handler.text} | ${r.middleware.map((m) => `${m.phase}:${m.handler.text}`).join(' ')}`);

describe('joinPath', () => {
  it('joins and normalises prefixes', () => {
    expect(joinPath('/', '/')).toBe('/');
    expect(joinPath('/api', '/patients/')).toBe('/api/patients');
    expect(joinPath('/api/', 'x//y')).toBe('/api/x/y');
  });
});

describe('stitchRoutes', () => {
  it('resolves nested mounts and orders app, router, route and error middleware (fixture shape)', () => {
    const APP = 'api/app.ts#app';
    const API = 'api/routes/index.ts#apiRouter';
    const PAT = 'api/routes/patients.ts#patientsRouter';
    const { routes, warnings } = stitchRoutes([
      use('api/app.ts', APP, 9, null, pkg('express.json()')),
      use('api/app.ts', APP, 10, '/api', router(API)),
      use('api/app.ts', APP, 11, null, sym('api/middleware/errorHandler.ts', 'errorHandler', 4)),
      use('api/routes/index.ts', API, 6, '/patients', router(PAT)),
      use('api/routes/patients.ts', PAT, 11, null, sym('api/middleware/auth.ts', 'requireAuth')),
      route('api/routes/patients.ts', PAT, 13, 'POST', '/enroll', sym('api/middleware/rateLimit.ts', 'rateLimit'), sym('api/controllers/c.ts', 'enrollHandler')),
      route('api/routes/patients.ts', PAT, 14, 'GET', '/:id', sym('api/controllers/c.ts', 'getPatientHandler')),
    ]);
    expect(warnings).toEqual([]);
    expect(summary(routes)).toEqual([
      'POST /api/patients/enroll -> enrollHandler | app:express.json() router:requireAuth route:rateLimit error:errorHandler',
      'GET /api/patients/:id -> getPatientHandler | app:express.json() router:requireAuth error:errorHandler',
    ]);
    expect(routes[0].mountChain).toEqual([
      { file: 'api/app.ts', line: 10, endLine: 10, prefix: '/api' },
      { file: 'api/routes/index.ts', line: 6, endLine: 6, prefix: '/patients' },
    ]);
  });

  it('applies path-scoped middleware by segment and ignores middleware registered after the route', () => {
    const F = 'a.ts';
    const APP = 'a.ts#app';
    const { routes } = stitchRoutes([
      use(F, APP, 1, '/admin', sym(F, 'adminOnly')),
      use(F, APP, 2, null, sym(F, 'earlyErrors', 4)),
      route(F, APP, 3, 'GET', '/admin/users', sym(F, 'listUsers')),
      route(F, APP, 4, 'GET', '/health', sym(F, 'health')),
      route(F, APP, 5, 'GET', '/administrators', sym(F, 'admins')),
      use(F, APP, 6, null, sym(F, 'late')),
      use(F, APP, 7, null, sym(F, 'onError', 4)),
    ]);
    expect(summary(routes)).toEqual([
      'GET /admin/users -> listUsers | app:adminOnly error:onError',
      'GET /health -> health | error:onError',
      'GET /administrators -> admins | error:onError',
    ]);
  });

  it('reports mount loops, never-mounted routers and registrations it cannot place', () => {
    const plugin: RouterCallRecord = { ...route('p.ts', 'p.ts#x', 4, 'GET', '/plugin', sym('p.ts', 'h2')), receiver: null, receiverText: 'app' };
    const { routes, warnings } = stitchRoutes([
      use('a.ts', 'a.ts#app', 1, '/x', router('r1.ts#r1')),
      use('r1.ts', 'r1.ts#r1', 1, '/y', router('r2.ts#r2')),
      use('r2.ts', 'r2.ts#r2', 1, '/z', router('r1.ts#r1')),
      route('r2.ts', 'r2.ts#r2', 2, 'GET', '/', sym('r2.ts', 'h')),
      route('orphan.ts', 'orphan.ts#o', 1, 'GET', '/lost', sym('orphan.ts', 'lost')),
      plugin,
    ]);
    expect(summary(routes)).toEqual(['GET /x/y -> h | ']);
    expect(warnings).toEqual([
      "p.ts:4: `app.get(...)` registers on a value that isn't an app or router created in this repo with express() or Router(), so it can't be placed in the route tree",
      'r2.ts:1: `r1` is already mounted above this router; skipped to avoid a loop',
      'orphan.ts: router `o` has routes but is never mounted on an app',
    ]);
  });

  it('shows a non-literal path as * with a warning on the route', () => {
    const dynamic: RouterCallRecord = { ...route('a.ts', 'a.ts#app', 1, 'GET', 'x', sym('a.ts', 'h')), path: null, pathText: 'BASE + "/x"' };
    const { routes } = stitchRoutes([dynamic]);
    expect(routes[0].fullPath).toBe('/*');
    expect(routes[0].warnings).toEqual(['a.ts:1: path `BASE + "/x"` is not a string literal; shown as *']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run core/src/routes/stitch.test.ts`
Expected: FAIL. The module doesn't exist.

- [ ] **Step 4: Implement `stitch.ts`**

Create `core/src/routes/stitch.ts`:

```ts
import type { HandlerArg, MiddlewarePhase, MountFact, RouterCallRecord, SymbolKey } from '../store/types.js';

// Turns per-file Express registrations into full routes (CLAUDE.md §6.3 items 1-2). Pure: the store
// runs it over stored router facts inside the indexing transaction, never over source. Express rules:
// - an app's or router's middleware runs only for requests that reach it, in registration order;
// - middleware registered after a route (or mount) doesn't run before it;
// - on failure, error handlers (4 parameters) registered after the route run, innermost router first.

export interface StitchedMiddleware {
  phase: MiddlewarePhase;
  handler: HandlerArg;
  /** The registration call. */
  file: string;
  line: number;
  endLine: number;
}

export interface StitchedRoute {
  method: string;
  fullPath: string;
  file: string;
  line: number;
  endLine: number;
  handler: HandlerArg;
  mountChain: MountFact[];
  /** Execution order: app and router middleware, route middleware, then error handlers. */
  middleware: StitchedMiddleware[];
  warnings: string[];
}

export interface StitchResult {
  routes: StitchedRoute[];
  /** Registrations that couldn't be placed in the route tree. */
  warnings: string[];
}

interface Scoped {
  /** Full path prefix the middleware applies to. */
  scope: string;
  mw: StitchedMiddleware;
}

export function stitchRoutes(calls: RouterCallRecord[]): StitchResult {
  const warnings: string[] = [];
  const byReceiver = new Map<string, RouterCallRecord[]>();
  const kinds = new Map<string, 'app' | 'router'>();
  for (const call of calls) {
    if (!call.receiver) {
      warnings.push(
        `${call.file}:${call.line}: \`${call.receiverText}.${(call.method ?? 'use').toLowerCase()}(...)\` registers on a value that isn't an app or router created in this repo with express() or Router(), so it can't be placed in the route tree`,
      );
      continue;
    }
    kinds.set(call.receiver.key, call.receiver.kind);
    byReceiver.set(call.receiver.key, [...(byReceiver.get(call.receiver.key) ?? []), call]);
  }
  for (const list of byReceiver.values()) list.sort((a, b) => a.file.localeCompare(b.file) || a.orderIdx - b.orderIdx);

  const mounted = new Set(calls.flatMap((c) => c.handlers.flatMap((h) => (h.kind === 'router' ? [h.receiverKey] : []))));
  const roots = [...byReceiver.keys()].filter((k) => kinds.get(k) === 'app' && !mounted.has(k)).sort();
  const reached = new Set<string>();
  const routes: StitchedRoute[] = [];

  const walk = (key: string, prefix: string, mountChain: MountFact[], inherited: Scoped[], outerErrors: Scoped[], stack: string[]): void => {
    reached.add(key);
    const list = byReceiver.get(key) ?? [];
    const phase: MiddlewarePhase = kinds.get(key) === 'app' ? 'app' : 'router';
    const errorsAfter = (orderIdx: number): Scoped[] =>
      list
        .filter((c) => c.callKind === 'use' && c.orderIdx > orderIdx)
        .flatMap((c) => c.handlers.filter(isErrorHandler).map((h) => ({ scope: joinPath(prefix, pathOf(c)), mw: middlewareAt(c, 'error', h) })));
    const local: Scoped[] = [];

    for (const call of list) {
      if (call.callKind === 'use') {
        const scope = joinPath(prefix, pathOf(call));
        if (call.path === null && call.pathText !== null) {
          warnings.push(`${call.file}:${call.line}: mount path \`${call.pathText}\` is not a string literal; shown as *`);
        }
        const pending: Scoped[] = [];
        for (const h of call.handlers) {
          if (h.kind === 'router') {
            if (stack.includes(h.receiverKey)) {
              warnings.push(`${call.file}:${call.line}: \`${h.text}\` is already mounted above this router; skipped to avoid a loop`);
              continue;
            }
            const mount: MountFact = { file: call.file, line: call.line, endLine: call.endLine, prefix: pathOf(call) };
            walk(h.receiverKey, scope, [...mountChain, mount], [...inherited, ...local, ...pending], [...errorsAfter(call.orderIdx), ...outerErrors], [...stack, h.receiverKey]);
          } else if (!isErrorHandler(h)) {
            pending.push({ scope, mw: middlewareAt(call, phase, h) });
          }
        }
        local.push(...pending);
        continue;
      }

      const own = call.handlers.filter((h) => h.kind !== 'router');
      const handler = own.at(-1);
      if (!handler) continue;
      const fullPath = joinPath(prefix, pathOf(call));
      const applies = (s: Scoped) => hasPrefix(fullPath, s.scope);
      routes.push({
        method: call.method ?? 'ALL',
        fullPath,
        file: call.file,
        line: call.line,
        endLine: call.endLine,
        handler,
        mountChain,
        middleware: [
          ...[...inherited, ...local].filter(applies).map((s) => s.mw),
          ...own.slice(0, -1).map((h) => middlewareAt(call, 'route', h)),
          ...[...errorsAfter(call.orderIdx), ...outerErrors].filter(applies).map((s) => s.mw),
        ],
        warnings: call.path === null && call.pathText !== null ? [`${call.file}:${call.line}: path \`${call.pathText}\` is not a string literal; shown as *`] : [],
      });
    }
  };

  for (const root of roots) walk(root, '/', [], [], [], [root]);
  for (const [key, list] of byReceiver) {
    if (reached.has(key) || !list.some((c) => c.callKind === 'route')) continue;
    const at = key.lastIndexOf('#');
    warnings.push(`${key.slice(0, at)}: router \`${key.slice(at + 1)}\` has routes but is never mounted on an app`);
  }
  return { routes, warnings };
}

/** "/api" + "/patients/" -> "/api/patients"; always one leading slash, no trailing slash except "/". */
export function joinPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/** The symbol a handler runs, for joining to the symbols table: a factory runs the function it returns. */
export function handlerKey(h: HandlerArg): SymbolKey | null {
  if (h.kind === 'symbol' || h.kind === 'inline') return h.key;
  if (h.kind === 'factory') return h.key ?? h.factory;
  return null;
}

/** How a handler is shown: the symbol name, or the source text for packages and unresolved values. */
export function handlerLabel(h: HandlerArg): string {
  if (h.kind === 'symbol' || h.kind === 'inline') return h.key.name;
  if (h.kind === 'factory') return h.key?.name ?? h.text;
  return h.text;
}

export function handlerNote(h: HandlerArg, file: string, line: number): string | null {
  return h.kind === 'unresolved' ? `unresolved: likely ${h.text} (middleware registered at ${file}:${line})` : null;
}

function pathOf(call: RouterCallRecord): string {
  return call.path ?? (call.pathText !== null ? '*' : '/');
}

function hasPrefix(path: string, scope: string): boolean {
  return scope === '/' || path === scope || path.startsWith(`${scope}/`);
}

function isErrorHandler(h: HandlerArg): boolean {
  return 'arity' in h && h.arity === 4;
}

function middlewareAt(call: RouterCallRecord, phase: MiddlewarePhase, handler: HandlerArg): StitchedMiddleware {
  return { phase, handler, file: call.file, line: call.line, endLine: call.endLine };
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run core/src/routes`
Expected: PASS.

- [ ] **Step 6: Checkpoint (don't commit)**

---

### Task 6: Store: persist facts, rebuild routes, read API

**Files:**
- Create: `core/src/store/migrations/1792000000000_routes-and-side-effects.ts`
- Modify: `core/src/store/types.ts`, `core/src/store/store.ts`, `core/src/indexer/index.ts`
- Test: `core/src/store/store.test.ts` (add a describe block), `core/src/indexer/indexer.test.ts` (add tests)

**Interfaces:**
- Consumes: `stitchRoutes`, `handlerKey`, `handlerLabel`, `handlerNote` (Task 5); fact types (Tasks 3-5).
- Produces (types in `store/types.ts`):

```ts
export interface RouteRecord { id: number; method: string; fullPath: string; handler: SymbolRecord | null; handlerLabel: string; file: string; line: number; endLine: number; mountChain: MountFact[]; warnings: string[] }
export interface MiddlewareRecord { orderIdx: number; phase: MiddlewarePhase; label: string; symbol: SymbolRecord | null; file: string; line: number; endLine: number; unresolvedNote: string | null }
export interface SideEffectRecord { symbolId: number; kind: SideEffectKind; detail: string; line: number }
```

- Produces (`Store` methods):
  - `listRoutes(): Promise<RouteRecord[]>`
  - `getMiddlewareChain(routeId: number): Promise<MiddlewareRecord[]>` (ordered; error handlers last)
  - `getSideEffects(symbolIds: number[]): Promise<SideEffectRecord[]>`
  - `getRouteWarnings(): Promise<string[]>`
  - `IndexChanges.callRefreshes[]` gains optional `routerCalls` and `sideEffects`.

- [ ] **Step 1: Write the migration**

Create `core/src/store/migrations/1792000000000_routes-and-side-effects.ts`:

```ts
import type { MigrationBuilder } from 'node-pg-migrate';

// Phase 3 (walk endpoint): per-file Express registrations, and the columns routes/middleware need
// once they are stitched from them. Rows in routes/middleware are rebuilt on every index pass.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('router_calls', {
    id: { type: 'bigserial', primaryKey: true },
    file_id: { type: 'bigint', notNull: true, references: 'files', onDelete: 'CASCADE' },
    receiver_key: { type: 'text' }, // "<file>#<variable>"; NULL for Express values we can't place
    receiver_kind: { type: 'text', check: "receiver_kind IN ('app', 'router')" },
    receiver_text: { type: 'text', notNull: true },
    call_kind: { type: 'text', notNull: true, check: "call_kind IN ('use', 'route')" },
    method: { type: 'text' },
    path: { type: 'text' },
    path_text: { type: 'text' },
    line: { type: 'integer', notNull: true },
    end_line: { type: 'integer', notNull: true },
    order_idx: { type: 'integer', notNull: true },
    handlers: { type: 'jsonb', notNull: true },
  });
  pgm.createIndex('router_calls', 'file_id');
  pgm.createIndex('router_calls', 'receiver_key');

  pgm.addColumns('routes', {
    handler_label: { type: 'text', notNull: true, default: '' },
    file: { type: 'text', notNull: true, default: '' },
    line: { type: 'integer', notNull: true, default: 0 },
    end_line: { type: 'integer', notNull: true, default: 0 },
    warnings: { type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) },
  });

  pgm.addColumns('middleware', {
    phase: { type: 'text', notNull: true, default: 'route', check: "phase IN ('app', 'router', 'route', 'error')" },
    label: { type: 'text', notNull: true, default: '' },
    file: { type: 'text', notNull: true, default: '' },
    line: { type: 'integer', notNull: true, default: 0 },
    end_line: { type: 'integer', notNull: true, default: 0 },
    unresolved_note: { type: 'text' },
  });

  pgm.createTable('route_warnings', { message: { type: 'text', notNull: true } });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('route_warnings');
  pgm.dropColumns('middleware', ['phase', 'label', 'file', 'line', 'end_line', 'unresolved_note']);
  pgm.dropColumns('routes', ['handler_label', 'file', 'line', 'end_line', 'warnings']);
  pgm.dropTable('router_calls');
}
```

- [ ] **Step 2: Add the record types and widen `IndexChanges`**

In `core/src/store/types.ts`, change `IndexChanges.callRefreshes` to:

```ts
  /** Unchanged files whose outgoing facts are rebuilt (their symbols are kept). */
  callRefreshes?: { path: string; calls: CallFact[]; routerCalls?: RouterCallFact[]; sideEffects?: SideEffectFact[] }[];
```

and append:

```ts
export interface RouteRecord {
  id: number;
  method: string;
  fullPath: string;
  /** Null when the handler is a package function or couldn't be resolved. */
  handler: SymbolRecord | null;
  handlerLabel: string;
  /** The route registration call. */
  file: string;
  line: number;
  endLine: number;
  mountChain: MountFact[];
  warnings: string[];
}

export interface MiddlewareRecord {
  orderIdx: number;
  phase: MiddlewarePhase;
  label: string;
  /** Null for package middleware and unresolved values. */
  symbol: SymbolRecord | null;
  /** The registration call. */
  file: string;
  line: number;
  endLine: number;
  unresolvedNote: string | null;
}

export interface SideEffectRecord {
  symbolId: number;
  kind: SideEffectKind;
  detail: string;
  line: number;
}
```

- [ ] **Step 3: Write the failing store test**

Append to `core/src/store/store.test.ts`, reusing its `DATABASE_URL` and imports (add `type FileFacts` if it's not already imported):

```ts
describe('store: routes and side effects', () => {
  let store: Store;

  const appFile: FileFacts = {
    path: 'api/app.ts',
    hash: 'h-app',
    language: 'typescript',
    symbols: [{ name: 'createApp', kind: 'function', startLine: 3, endLine: 9, exported: true, signature: null }],
    calls: [],
    imports: [],
    routerCalls: [
      { receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null, path: null, pathText: null, line: 4, endLine: 4, orderIdx: 0,
        handlers: [{ kind: 'package', package: 'express', text: 'express.json()' }] },
      { receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null, path: null, pathText: null, line: 5, endLine: 5, orderIdx: 1,
        handlers: [{ kind: 'unresolved', text: 'middlewares[0]' }] },
      { receiver: { key: 'api/app.ts#app', kind: 'app' }, receiverText: 'app', callKind: 'use', method: null, path: '/api', pathText: null, line: 6, endLine: 6, orderIdx: 2,
        handlers: [{ kind: 'router', receiverKey: 'api/routes.ts#r', text: 'r' }] },
    ],
  };
  const routesFile: FileFacts = {
    path: 'api/routes.ts',
    hash: 'h-routes',
    language: 'typescript',
    symbols: [
      { name: 'auth', kind: 'function', startLine: 3, endLine: 5, exported: false, signature: null },
      { name: 'create', kind: 'function', startLine: 7, endLine: 12, exported: false, signature: null },
    ],
    calls: [],
    imports: [],
    routerCalls: [
      { receiver: { key: 'api/routes.ts#r', kind: 'router' }, receiverText: 'r', callKind: 'route', method: 'POST', path: '/items', pathText: null, line: 14, endLine: 15, orderIdx: 0,
        handlers: [
          { kind: 'symbol', key: { file: 'api/routes.ts', name: 'auth', startLine: 3 }, arity: 3, text: 'auth' },
          { kind: 'symbol', key: { file: 'api/routes.ts', name: 'create', startLine: 7 }, arity: 2, text: 'create' },
        ] },
    ],
    sideEffects: [{ symbol: { name: 'create', startLine: 7 }, kind: 'db_write', detail: 'INSERT items', line: 9 }],
  };

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_routes_${randomBytes(4).toString('hex')}` });
    await store.migrate();
    await store.applyIndexChanges({ files: [appFile, routesFile] });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('stitches stored registrations into full routes with resolved handlers', async () => {
    const routes = await store.listRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'POST',
      fullPath: '/api/items',
      handlerLabel: 'create',
      handler: { file: 'api/routes.ts', name: 'create', startLine: 7 },
      file: 'api/routes.ts',
      line: 14,
      endLine: 15,
      mountChain: [{ file: 'api/app.ts', line: 6, endLine: 6, prefix: '/api' }],
      warnings: [],
    });
  });

  it('returns the middleware chain in order with symbols, labels and unresolved notes', async () => {
    const [route] = await store.listRoutes();
    const chain = await store.getMiddlewareChain(route.id);
    expect(chain.map((m) => [m.orderIdx, m.phase, m.label, m.symbol?.name ?? null, m.unresolvedNote])).toEqual([
      [0, 'app', 'express.json()', null, null],
      [1, 'app', 'middlewares[0]', null, 'unresolved: likely middlewares[0] (middleware registered at api/app.ts:5)'],
      [2, 'route', 'auth', 'auth', null],
    ]);
  });

  it('stores side effects per symbol', async () => {
    const [create] = await store.findSymbol('api/routes.ts', 'create');
    expect(await store.getSideEffects([create.id])).toEqual([{ symbolId: create.id, kind: 'db_write', detail: 'INSERT items', line: 9 }]);
  });

  it('rebuilds routes after a refresh and records routers it cannot reach', async () => {
    await store.applyIndexChanges({ callRefreshes: [{ path: 'api/app.ts', calls: [], routerCalls: [], sideEffects: [] }] });
    expect(await store.listRoutes()).toEqual([]);
    expect(await store.getRouteWarnings()).toEqual(['api/routes.ts: router `r` has routes but is never mounted on an app']);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run core/src/store/store.test.ts`
Expected: FAIL. `listRoutes` is not a function.

- [ ] **Step 5: Implement the store changes**

In `core/src/store/store.ts`:

1. Imports:

```ts
import { handlerKey, handlerLabel, handlerNote, stitchRoutes } from '../routes/stitch.js';
import type {
  CallEdge, CalleeRecord, CallerRecord, FileRecord, ImporterRecord, ImportRecord, IndexChanges, IndexStats,
  MiddlewareRecord, RouteRecord, RouterCallRecord, SideEffectRecord, SymbolKind, SymbolRecord, WalkthroughRecord,
} from './types.js';
```

2. In `applyIndexChanges`, directly after the existing `DELETE FROM calls ...` statement, add the refresh deletes:

```ts
      const refreshPaths = callRefreshes.map((r) => r.path);
      await client.query(
        'DELETE FROM router_calls WHERE file_id IN (SELECT id FROM files WHERE path = ANY($1::text[]))',
        [refreshPaths],
      );
      await client.query(
        `DELETE FROM side_effects WHERE symbol_id IN (
           SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ANY($1::text[]))`,
        [refreshPaths],
      );
```

3. After the imports `INSERT`, before `COMMIT`, add:

```ts
      const factSources = [...files, ...callRefreshes];
      const routerCalls = factSources.flatMap((f) =>
        (f.routerCalls ?? []).map((r) => ({
          file: f.path, receiverKey: r.receiver?.key ?? null, receiverKind: r.receiver?.kind ?? null, receiverText: r.receiverText,
          callKind: r.callKind, method: r.method, path: r.path, pathText: r.pathText, line: r.line, endLine: r.endLine,
          orderIdx: r.orderIdx, handlers: r.handlers,
        })),
      );
      await client.query(
        `INSERT INTO router_calls (file_id, receiver_key, receiver_kind, receiver_text, call_kind, method, path, path_text,
                                   line, end_line, order_idx, handlers)
         SELECT f.id, x."receiverKey", x."receiverKind", x."receiverText", x."callKind", x.method, x.path, x."pathText",
                x.line, x."endLine", x."orderIdx", x.handlers
         FROM jsonb_to_recordset($1::jsonb) AS x(file text, "receiverKey" text, "receiverKind" text, "receiverText" text,
                                                 "callKind" text, method text, path text, "pathText" text, line int,
                                                 "endLine" int, "orderIdx" int, handlers jsonb)
         JOIN files f ON f.path = x.file`,
        [JSON.stringify(routerCalls)],
      );

      const sideEffects = factSources.flatMap((f) => (f.sideEffects ?? []).map((e) => ({ ...e, file: f.path })));
      const insertedEffects = await client.query(
        `INSERT INTO side_effects (symbol_id, kind, detail, line)
         SELECT s.id, x.kind, x.detail, x.line
         FROM jsonb_to_recordset($1::jsonb) AS x(file text, symbol jsonb, kind text, detail text, line int)
         JOIN files f ON f.path = x.file
         JOIN symbols s ON s.file_id = f.id AND s.name = x.symbol->>'name' AND s.start_line = (x.symbol->>'startLine')::int`,
        [JSON.stringify(sideEffects)],
      );
      assertCount('side_effects', insertedEffects.rowCount, sideEffects.length);

      await this.rebuildRoutes(client);
```

4. Add these methods to `Store` (after `getCallEdgesInFile`):

```ts
  /** Re-stitches routes and middleware from every stored registration (routes/stitch.ts). */
  private async rebuildRoutes(client: pg.PoolClient): Promise<void> {
    const { rows } = await client.query<RouterCallRow>(
      `SELECT f.path AS file, r.receiver_key, r.receiver_kind, r.receiver_text, r.call_kind, r.method, r.path, r.path_text,
              r.line, r.end_line, r.order_idx, r.handlers
       FROM router_calls r JOIN files f ON f.id = r.file_id
       ORDER BY f.path, r.order_idx`,
    );
    const { routes, warnings } = stitchRoutes(rows.map(toRouterCallRecord));

    await client.query('DELETE FROM routes'); // cascades to middleware
    await client.query('DELETE FROM route_warnings');
    await client.query('INSERT INTO route_warnings (message) SELECT unnest($1::text[])', [warnings]);
    if (routes.length === 0) return;

    const ids = (
      await client.query<{ id: string }>(`SELECT nextval(pg_get_serial_sequence('routes', 'id')) AS id FROM generate_series(1, $1)`, [routes.length])
    ).rows.map((r) => r.id);

    await client.query(
      `INSERT INTO routes (id, method, full_path, handler_symbol_id, handler_label, mount_chain, file, line, end_line, warnings)
       SELECT x.id, x.method, x."fullPath", s.id, x."handlerLabel", x."mountChain", x.file, x.line, x."endLine", x.warnings
       FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, method text, "fullPath" text, "handlerLabel" text, "mountChain" jsonb,
                                               file text, line int, "endLine" int, warnings jsonb, key jsonb)
       LEFT JOIN files kf ON kf.path = x.key->>'file'
       LEFT JOIN symbols s ON s.file_id = kf.id AND s.name = x.key->>'name' AND s.start_line = (x.key->>'startLine')::int`,
      [
        JSON.stringify(
          routes.map((r, i) => ({
            id: ids[i], method: r.method, fullPath: r.fullPath, handlerLabel: handlerLabel(r.handler), mountChain: r.mountChain,
            file: r.file, line: r.line, endLine: r.endLine, warnings: r.warnings, key: handlerKey(r.handler),
          })),
        ),
      ],
    );

    const middleware = routes.flatMap((r, i) =>
      r.middleware.map((m, orderIdx) => ({
        routeId: ids[i], orderIdx, phase: m.phase, label: handlerLabel(m.handler), file: m.file, line: m.line, endLine: m.endLine,
        note: handlerNote(m.handler, m.file, m.line), key: handlerKey(m.handler),
      })),
    );
    await client.query(
      `INSERT INTO middleware (route_id, order_idx, symbol_id, phase, label, file, line, end_line, unresolved_note)
       SELECT x."routeId", x."orderIdx", s.id, x.phase, x.label, x.file, x.line, x."endLine", x.note
       FROM jsonb_to_recordset($1::jsonb) AS x("routeId" bigint, "orderIdx" int, phase text, label text, file text, line int,
                                               "endLine" int, note text, key jsonb)
       LEFT JOIN files kf ON kf.path = x.key->>'file'
       LEFT JOIN symbols s ON s.file_id = kf.id AND s.name = x.key->>'name' AND s.start_line = (x.key->>'startLine')::int`,
      [JSON.stringify(middleware)],
    );
  }

  /** Every stitched route, with its handler symbol when it is a repo function. */
  async listRoutes(): Promise<RouteRecord[]> {
    const { rows } = await this.pool.query<RouteRow>(
      `SELECT r.id, r.method, r.full_path, r.handler_label, r.mount_chain, r.file, r.line, r.end_line, r.warnings, ${PREFIXED_SYMBOL}
       FROM routes r LEFT JOIN symbols s ON s.id = r.handler_symbol_id LEFT JOIN files sf ON sf.id = s.file_id
       ORDER BY r.full_path, r.method, r.id`,
    );
    return rows.map((r) => ({
      id: Number(r.id), method: r.method, fullPath: r.full_path, handler: optionalSymbol(r), handlerLabel: r.handler_label,
      file: r.file, line: r.line, endLine: r.end_line, mountChain: r.mount_chain, warnings: r.warnings,
    }));
  }

  /** A route's middleware in execution order; error handlers (phase "error") come last. */
  async getMiddlewareChain(routeId: number): Promise<MiddlewareRecord[]> {
    const { rows } = await this.pool.query<MiddlewareRow>(
      `SELECT m.order_idx, m.phase, m.label, m.file, m.line, m.end_line, m.unresolved_note, ${PREFIXED_SYMBOL}
       FROM middleware m LEFT JOIN symbols s ON s.id = m.symbol_id LEFT JOIN files sf ON sf.id = s.file_id
       WHERE m.route_id = $1 ORDER BY m.order_idx`,
      [routeId],
    );
    return rows.map((r) => ({
      orderIdx: r.order_idx, phase: r.phase, label: r.label, symbol: optionalSymbol(r), file: r.file, line: r.line,
      endLine: r.end_line, unresolvedNote: r.unresolved_note,
    }));
  }

  /** Side effects of the given symbols, by symbol then line. One query. */
  async getSideEffects(symbolIds: number[]): Promise<SideEffectRecord[]> {
    const { rows } = await this.pool.query<{ symbol_id: string; kind: SideEffectRecord['kind']; detail: string; line: number }>(
      'SELECT symbol_id, kind, detail, line FROM side_effects WHERE symbol_id = ANY($1::bigint[]) ORDER BY symbol_id, line, id',
      [symbolIds],
    );
    return rows.map((r) => ({ symbolId: Number(r.symbol_id), kind: r.kind, detail: r.detail, line: r.line }));
  }

  /** Registrations the last index pass couldn't place in the route tree. */
  async getRouteWarnings(): Promise<string[]> {
    const { rows } = await this.pool.query<{ message: string }>('SELECT message FROM route_warnings ORDER BY message');
    return rows.map((r) => r.message);
  }
```

5. Add these module-level helpers (next to `SELECT_SYMBOL` / `toSymbolRecord`):

```ts
const PREFIXED_SYMBOL = `s.id AS s_id, sf.path AS s_file, s.name AS s_name, s.kind AS s_kind, s.start_line AS s_start_line,
  s.end_line AS s_end_line, s.exported AS s_exported, s.signature AS s_signature`;

interface PrefixedSymbolRow {
  s_id: string | null;
  s_file: string | null;
  s_name: string | null;
  s_kind: SymbolKind | null;
  s_start_line: number | null;
  s_end_line: number | null;
  s_exported: boolean | null;
  s_signature: string | null;
}

interface RouteRow extends PrefixedSymbolRow {
  id: string;
  method: string;
  full_path: string;
  handler_label: string;
  mount_chain: RouteRecord['mountChain'];
  file: string;
  line: number;
  end_line: number;
  warnings: string[];
}

interface MiddlewareRow extends PrefixedSymbolRow {
  order_idx: number;
  phase: MiddlewareRecord['phase'];
  label: string;
  file: string;
  line: number;
  end_line: number;
  unresolved_note: string | null;
}

interface RouterCallRow {
  file: string;
  receiver_key: string | null;
  receiver_kind: 'app' | 'router' | null;
  receiver_text: string;
  call_kind: 'use' | 'route';
  method: string | null;
  path: string | null;
  path_text: string | null;
  line: number;
  end_line: number;
  order_idx: number;
  handlers: RouterCallRecord['handlers'];
}

function optionalSymbol(r: PrefixedSymbolRow): SymbolRecord | null {
  if (r.s_id === null) return null;
  return toSymbolRecord({
    id: r.s_id, file: r.s_file!, name: r.s_name!, kind: r.s_kind!, start_line: r.s_start_line!, end_line: r.s_end_line!,
    exported: r.s_exported!, signature: r.s_signature,
  });
}

function toRouterCallRecord(r: RouterCallRow): RouterCallRecord {
  return {
    file: r.file,
    receiver: r.receiver_key && r.receiver_kind ? { key: r.receiver_key, kind: r.receiver_kind } : null,
    receiverText: r.receiver_text, callKind: r.call_kind, method: r.method, path: r.path, pathText: r.path_text,
    line: r.line, endLine: r.end_line, orderIdx: r.order_idx, handlers: r.handlers,
  };
}
```

- [ ] **Step 6: Refresh router calls and side effects in the indexer**

In `core/src/indexer/index.ts`, replace the `callRefreshes` line with:

```ts
    const callRefreshes = refreshed.map((path) => {
      const { calls, routerCalls, sideEffects } = extractor.extract(path);
      return { path, calls, routerCalls, sideEffects };
    });
```

`fileFacts` already spreads `extractor.extract(...)`, so it carries `routerCalls` and `sideEffects`.

- [ ] **Step 7: Add the fixture index tests**

In `core/src/indexer/indexer.test.ts`, add right after `'indexes every source file on the first run'`:

```ts
  it('resolves Express mounts into full routes with ordered middleware', async () => {
    const routes = await store.listRoutes();
    expect(routes.map((r) => `${r.method} ${r.fullPath}`).sort()).toEqual(['GET /api/patients/:id', 'POST /api/patients/enroll']);
    const enroll = routes.find((r) => r.method === 'POST')!;
    expect(enroll).toMatchObject({
      handlerLabel: 'enrollHandler',
      handler: { file: 'api/controllers/patientsController.ts', name: 'enrollHandler' },
      file: 'api/routes/patients.ts',
      line: 13,
      mountChain: [
        { file: 'api/app.ts', line: 10, prefix: '/api' },
        { file: 'api/routes/index.ts', line: 6, prefix: '/patients' },
      ],
    });
    expect((await store.getMiddlewareChain(enroll.id)).map((m) => `${m.phase}:${m.label}`)).toEqual([
      'app:express.json()',
      'router:requireAuth',
      'route:rateLimit',
      'route:validate.validateBody',
      'error:errorHandler',
    ]);
  });

  it('tags side effects on the symbols that cause them', async () => {
    const effects = async (file: string, name: string) =>
      (await store.getSideEffects([(await symbol(file, name)).id])).map((e) => `${e.kind} ${e.detail}`);
    expect(await effects('api/middleware/auth.ts', 'requireAuth')).toEqual([
      'throws UnauthorizedError (401)',
      'redis GET session:${token}',
      'throws UnauthorizedError (401)',
    ]);
    expect(await effects('api/repositories/patientRepository.ts', 'insertConsent')).toEqual(['db_write INSERT consents']);
    expect(await effects('api/services/enrollService.ts', 'enrollPatient')).toEqual(expect.arrayContaining([
      'throws ConflictError (409)',
      'redis SET patient:${patient.id}',
      'queue emit patient.enrolled (in-process)',
      'throws rethrows err',
    ]));
  });
```

and at the end of the describe block (after the deletion test):

```ts
  it('rebuilds routes when a router file changes', async () => {
    const path = join(repo, 'api/routes/patients.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('rateLimit, ', ''));
    await indexRepo(repo, config, store);
    const enroll = (await store.listRoutes()).find((r) => r.fullPath === '/api/patients/enroll')!;
    expect((await store.getMiddlewareChain(enroll.id)).map((m) => m.label)).toEqual([
      'express.json()',
      'requireAuth',
      'validate.validateBody',
      'errorHandler',
    ]);
  });
```

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run core/src/store core/src/indexer`
Expected: PASS. If `requireAuth`'s effects come out in another order, `getSideEffects` sorts by line: lines 14, 17 and 19 of `auth.ts`.

- [ ] **Step 9: Checkpoint (don't commit)**

Run: `pnpm test`. Expected: everything passes.

---

### Task 7: Endpoint target parsing and route matching

**Files:**
- Create: `core/src/routes/match.ts`
- Test: `core/src/routes/match.test.ts`

**Interfaces:**
- Consumes: `TargetError` (`core/src/context/target.ts`).
- Produces:
  - `EndpointTarget { method: string; path: string }`
  - `parseEndpointTarget(arg: string): EndpointTarget`
  - `pathMatches(pattern: string, path: string): boolean`
  - `matchRoutes<R extends RouteLike>(routes: R[], target): R[]`
  - `closestRoutes<R>(routes, target, n = 5): R[]`
  - `RouteLike = { method: string; fullPath: string }`

- [ ] **Step 1: Write the failing test**

Create `core/src/routes/match.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TargetError } from '../context/target.js';
import { closestRoutes, matchRoutes, parseEndpointTarget, pathMatches } from './match.js';

const routes = [
  { method: 'POST', fullPath: '/api/patients/enroll' },
  { method: 'GET', fullPath: '/api/patients/:id' },
  { method: 'GET', fullPath: '/api/patients/search' },
  { method: 'ALL', fullPath: '/api/health' },
];
const show = (rs: typeof routes) => rs.map((r) => `${r.method} ${r.fullPath}`);

describe('parseEndpointTarget', () => {
  it('upper-cases the method and normalises the path', () => {
    expect(parseEndpointTarget('post /api/patients/enroll/')).toEqual({ method: 'POST', path: '/api/patients/enroll' });
    expect(parseEndpointTarget('GET /api/patients/42?full=1')).toEqual({ method: 'GET', path: '/api/patients/42' });
    expect(parseEndpointTarget('  get   //api//x ')).toEqual({ method: 'GET', path: '/api/x' });
  });

  it('rejects unknown methods and paths without a leading slash', () => {
    expect(() => parseEndpointTarget('FETCH /x')).toThrow(TargetError);
    expect(() => parseEndpointTarget('/x')).toThrow(TargetError);
    expect(() => parseEndpointTarget('GET api/x')).toThrow(TargetError);
  });
});

describe('matchRoutes', () => {
  it('matches a concrete path to a :param pattern', () => {
    expect(pathMatches('/api/patients/:id', '/api/patients/42')).toBe(true);
    expect(pathMatches('/api/patients/:id', '/api/patients')).toBe(false);
    expect(show(matchRoutes(routes, { method: 'GET', path: '/api/patients/42' }))).toEqual(['GET /api/patients/:id']);
  });

  it('prefers an exact path over a pattern, and ALL matches any method', () => {
    expect(show(matchRoutes(routes, { method: 'GET', path: '/api/patients/search' }))).toEqual(['GET /api/patients/search']);
    expect(show(matchRoutes(routes, { method: 'DELETE', path: '/api/health' }))).toEqual(['ALL /api/health']);
    expect(matchRoutes(routes, { method: 'PUT', path: '/api/patients/enroll' })).toEqual([]);
  });

  it('suggests the closest routes for a typo', () => {
    expect(show(closestRoutes(routes, { method: 'POST', path: '/api/patient/enroll' }, 2))[0]).toBe('POST /api/patients/enroll');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run core/src/routes/match.test.ts`
Expected: FAIL. The module doesn't exist.

- [ ] **Step 3: Implement `match.ts`**

Create `core/src/routes/match.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run core/src/routes`
Expected: PASS.

- [ ] **Step 5: Checkpoint (don't commit)**

---

### Task 8: Endpoint context

**Files:**
- Create: `core/src/context/shared.ts`
- Modify: `core/src/context/fn.ts` (use `shared.ts`; no behaviour change)
- Create: `core/src/context/endpoint.ts`
- Modify: `core/src/context/index.ts`, `core/src/index.ts`
- Test: `core/src/context/endpoint.test.ts`

**Interfaces:**
- Consumes:
  - `Store.listRoutes`, `getMiddlewareChain`, `getSideEffects`, `getRouteWarnings`, `getCallees`, `getImportsForFile` (Task 6)
  - `matchRoutes`, `closestRoutes`, `parseEndpointTarget`, `EndpointTarget` (Task 7)
  - `CalleeFact`, `CodeBlock`, `PackageFact`, `UnresolvedFact` (`context/fn.ts`)
- Produces:
  - `EndpointNode`, `EndpointSideEffect`, `ErrorPath`, `EndpointContext` (fields listed in Step 4)
  - `buildEndpointContext(store, repoRoot, target: EndpointTarget, options: { depth: number; maxContextTokens: number }): Promise<EndpointContext>`
  - `chainHashOf(route: RouteRecord, middleware: MiddlewareRecord[]): string`
  - `currentChainHash(store: Store, scopeRef: string): Promise<string | null>`
  - `context/shared.ts`: `SourceCache`, `Budget`, `estimateTokens`, `collectPackages`, `PROMPT_RESERVE_TOKENS`, `NON_CODE_KINDS`

- [ ] **Step 1: Move the shared helpers out of `fn.ts`**

Create `core/src/context/shared.ts`. Move these declarations from `core/src/context/fn.ts` into it unchanged (bodies identical), and export each one:
- `estimateTokens`
- `PROMPT_RESERVE_TOKENS`
- `NON_CODE_KINDS`
- `collectPackages`
- class `SourceCache`
- class `Budget`

```ts
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
  /* body moved verbatim from fn.ts */
}

export class SourceCache {
  /* body moved verbatim from fn.ts */
}

export class Budget {
  /* body moved verbatim from fn.ts */
}
```

In `fn.ts`:
- delete the moved declarations
- remove the now-unused `createHash`/`readFileSync`/`join` imports
- add `import { Budget, collectPackages, NON_CODE_KINDS, PROMPT_RESERVE_TOKENS, SourceCache } from './shared.js';`
- add `export { estimateTokens } from './shared.js';`, so existing importers of `estimateTokens` from `fn.js` keep working

Run: `pnpm vitest run core/src/context`
Expected: PASS (pure move).

- [ ] **Step 2: Write the failing test**

Create `core/src/context/endpoint.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { indexRepo } from '../indexer/index.js';
import { openStore, type Store } from '../store/index.js';
import { buildEndpointContext, currentChainHash, type EndpointContext } from './endpoint.js';
import { TargetError } from './target.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const OPTIONS = { depth: 3, maxContextTokens: 60000 };
const schema = (tag: string) => `cw_test_${tag}_${Math.random().toString(16).slice(2, 10)}`;

describe('buildEndpointContext on the fixture', () => {
  let store: Store;
  let ctx: EndpointContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: schema('ep') });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildEndpointContext(store, FIXTURE, { method: 'POST', path: '/api/patients/enroll' }, OPTIONS);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('resolves the nested-router endpoint to its full path, mounts and middleware order (Phase 3 acceptance)', () => {
    expect(ctx.scopeRef).toBe('POST /api/patients/enroll');
    expect(ctx.route.mounts.map((m) => `${m.prefix} ${m.file}:${m.line}`)).toEqual(['/api api/app.ts:10', '/patients api/routes/index.ts:6']);
    expect(ctx.chain.map((n) => `${n.phase}:${n.label}`)).toEqual([
      'app:express.json()',
      'router:requireAuth',
      'route:rateLimit',
      'route:validate.validateBody',
      'handler:enrollHandler',
    ]);
    expect(ctx.chain[0]).toMatchObject({ symbol: null, code: null, registeredAt: { file: 'api/app.ts', line: 9 } });
    expect(ctx.chain[1].code).toMatchObject({ file: 'api/middleware/auth.ts', start: 10, end: 24 });
    expect(ctx.errorHandlers.map((n) => n.label)).toEqual(['errorHandler']);
    expect(ctx.registrations.map((b) => `${b.file}:${b.start}-${b.end}`)).toEqual([
      'api/app.ts:9-11',
      'api/routes/index.ts:6-6',
      'api/routes/patients.ts:11-11',
      'api/routes/patients.ts:13-13',
    ]);
  });

  it('tags side effects on the node that causes them (Phase 3 acceptance)', () => {
    expect(ctx.sideEffects.map((e) => `${e.symbol.name}: ${e.kind} ${e.detail}`)).toEqual(expect.arrayContaining([
      'requireAuth: redis GET session:${token}',
      'rateLimit: redis INCR ratelimit:${req.ip}',
      'rateLimit: redis EXPIRE ratelimit:${req.ip}',
      'findPatientByPhone: db_read SELECT patients',
      'insertPatient: db_write INSERT patients',
      'insertConsent: db_write INSERT consents',
      'enrollPatient: redis SET patient:${patient.id}',
      'enrollPatient: queue emit patient.enrolled (in-process)',
    ]));
    expect(ctx.errorPaths.map((p) => `${p.symbol.name}: ${p.error} ${p.status}`)).toEqual(expect.arrayContaining([
      'requireAuth: UnauthorizedError 401',
      'rateLimit: TooManyRequestsError 429',
      'validate.validateBody: ValidationError 400',
      'enrollPatient: ConflictError 409',
      'enrollPatient: rethrows err null',
      'enrollHandler: forwards err null',
    ]));
    expect(ctx.unresolved.some((u) => u.note.includes('bus.emit'))).toBe(true);
  });

  it('includes the service and repository code and cites every file it uses', () => {
    const bodies = ctx.callees.filter((c) => c.code).map((c) => c.callee!.name);
    expect(bodies).toEqual(expect.arrayContaining(['enrollPatient', 'findPatientByPhone', 'insertPatient', 'insertConsent']));
    expect(ctx.files['api/repositories/patientRepository.ts']).toBe(50);
    expect(ctx.packages.map((p) => p.name)).toContain('express');
  });

  it('matches a concrete path to its parameterised route', async () => {
    const byId = await buildEndpointContext(store, FIXTURE, { method: 'GET', path: '/api/patients/42' }, OPTIONS);
    expect(byId.scopeRef).toBe('GET /api/patients/:id');
    expect(byId.chain.map((n) => n.label)).toEqual(['express.json()', 'requireAuth', 'getPatientHandler']);
  });

  it('suggests close routes when nothing matches', async () => {
    await expect(buildEndpointContext(store, FIXTURE, { method: 'POST', path: '/api/patient/enroll' }, OPTIONS)).rejects.toThrow(
      /No route matches POST \/api\/patient\/enroll\. Closest: POST \/api\/patients\/enroll/,
    );
  });

  it('exposes a chain hash that currentChainHash reproduces from the index', async () => {
    expect(await currentChainHash(store, ctx.scopeRef)).toBe(ctx.chainHash);
    expect(await currentChainHash(store, 'GET /nope')).toBeNull();
  });
});

describe('buildEndpointContext without routes', () => {
  it('explains that no Express routes are indexed', async () => {
    const store = await openStore({ url: DATABASE_URL, schema: schema('ep_empty') });
    try {
      await store.migrate();
      await expect(buildEndpointContext(store, FIXTURE, { method: 'GET', path: '/x' }, OPTIONS)).rejects.toThrow(TargetError);
      await expect(buildEndpointContext(store, FIXTURE, { method: 'GET', path: '/x' }, OPTIONS)).rejects.toThrow(/No Express routes in the index/);
    } finally {
      await store.dropSchema();
      await store.close();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run core/src/context/endpoint.test.ts`
Expected: FAIL. `./endpoint.js` doesn't exist.

- [ ] **Step 4: Implement `endpoint.ts`**

Create `core/src/context/endpoint.ts`:

```ts
import { createHash } from 'node:crypto';
import { closestRoutes, matchRoutes, parseEndpointTarget, type EndpointTarget } from '../routes/match.js';
import type { Store } from '../store/index.js';
import type { MiddlewarePhase, MiddlewareRecord, MountFact, RouteRecord, SideEffectKind, SymbolRecord } from '../store/types.js';
import type { CalleeFact, CodeBlock, PackageFact, UnresolvedFact } from './fn.js';
import { Budget, collectPackages, NON_CODE_KINDS, PROMPT_RESERVE_TOKENS, SourceCache } from './shared.js';
import { TargetError } from './target.js';

// Selects the code and static facts for `walk endpoint` (CLAUDE.md §6.3): the matched route and its
// mounts, the middleware chain in execution order, the handler, everything they call (to --depth),
// side effects per function and the error paths. The same object is the `--no-llm` output and the
// LLM's only input.

export interface EndpointNode {
  phase: MiddlewarePhase | 'handler';
  label: string;
  /** Null for package middleware (e.g. express.json()) and handlers that couldn't be resolved. */
  symbol: SymbolRecord | null;
  /** The registration call, e.g. `router.post(...)`. */
  registeredAt: { file: string; line: number; endLine: number };
  code: CodeBlock | null;
  note: string | null;
}

export interface EndpointSideEffect {
  symbol: Pick<SymbolRecord, 'id' | 'file' | 'name'>;
  kind: SideEffectKind;
  detail: string;
  line: number;
}

export interface ErrorPath {
  symbol: Pick<SymbolRecord, 'id' | 'file' | 'name'>;
  line: number;
  /** e.g. "ConflictError", "rethrows err", "forwards err". */
  error: string;
  /** The status the error class sets; null when the error handler decides. */
  status: number | null;
}

export interface EndpointContext {
  /** "<METHOD> <full path>" of the matched route; the saved walkthrough's scope. */
  scopeRef: string;
  route: { id: number; method: string; fullPath: string; mounts: MountFact[]; warnings: string[] };
  /** Mount, middleware and route registration lines, adjacent lines merged. */
  registrations: CodeBlock[];
  /** Middleware in execution order, then the handler. */
  chain: EndpointNode[];
  /** Error-handling middleware that runs when a node fails, in order. */
  errorHandlers: EndpointNode[];
  /** Calls made by the chain and error handlers, transitively to --depth; each body is included once. */
  callees: CalleeFact[];
  /** Database, Redis, HTTP and queue effects (thrown errors are in errorPaths). */
  sideEffects: EndpointSideEffect[];
  errorPaths: ErrorPath[];
  unresolved: UnresolvedFact[];
  packages: PackageFact[];
  /** Line count of every file the context cites; the verifier's bounds. */
  files: Record<string, number>;
  omitted: string[];
  warnings: string[];
  /** Hash of the resolved chain; a saved walkthrough is stale when it changes. */
  chainHash: string;
}

export interface EndpointContextOptions {
  depth: number;
  maxContextTokens: number;
}

const STATUS = /\s*\((\d{3})\)$/;

export async function buildEndpointContext(store: Store, repoRoot: string, target: EndpointTarget, options: EndpointContextOptions): Promise<EndpointContext> {
  const route = await findRoute(store, target);
  const middleware = await store.getMiddlewareChain(route.id);
  const source = new SourceCache(repoRoot);
  const budget = new Budget(options.maxContextTokens - PROMPT_RESERVE_TOKENS);
  const omitted: string[] = [];

  const registrations = mergeRanges([
    ...route.mountChain.map((m) => ({ file: m.file, start: m.line, end: m.endLine })),
    ...middleware.map((m) => ({ file: m.file, start: m.line, end: m.endLine })),
    { file: route.file, start: route.line, end: route.endLine },
  ]).map((r) => source.block(r.file, r.start, r.end));
  if (!registrations.every((b) => budget.take(b))) {
    throw new TargetError(`The registrations of ${route.method} ${route.fullPath} alone exceed llm.maxContextTokens (${options.maxContextTokens}).`);
  }

  // Each symbol's body is sent once, in priority order: chain, error handlers, then callees (shallowest first).
  const shown = new Set<number>();
  const body = (symbol: SymbolRecord, label: string): CodeBlock | null => {
    if (NON_CODE_KINDS.has(symbol.kind) || shown.has(symbol.id)) return null;
    shown.add(symbol.id);
    const block = source.block(symbol.file, symbol.startLine, symbol.endLine);
    if (budget.take(block)) return block;
    omitted.push(`body of ${label} (${symbol.file}:${symbol.startLine})`);
    return null;
  };

  const nodeOf = (m: MiddlewareRecord): EndpointNode => ({
    phase: m.phase, label: m.label, symbol: m.symbol, registeredAt: { file: m.file, line: m.line, endLine: m.endLine }, code: null, note: m.unresolvedNote,
  });
  const chain: EndpointNode[] = [
    ...middleware.filter((m) => m.phase !== 'error').map(nodeOf),
    {
      phase: 'handler',
      label: route.handlerLabel,
      symbol: route.handler,
      registeredAt: { file: route.file, line: route.line, endLine: route.endLine },
      code: null,
      note: route.handler ? null : `unresolved: handler \`${route.handlerLabel}\` of ${route.method} ${route.fullPath} is not a function in this repo (${route.file}:${route.line})`,
    },
  ];
  const errorHandlers = middleware.filter((m) => m.phase === 'error').map(nodeOf);
  for (const node of [...chain, ...errorHandlers]) if (node.symbol) node.code = body(node.symbol, node.label);

  const owners = uniqueById([...chain, ...errorHandlers].flatMap((n) => (n.symbol && !NON_CODE_KINDS.has(n.symbol.kind) ? [n.symbol] : [])));
  const callees: CalleeFact[] = (await collectCallees(store, owners, options.depth)).map((c) => ({ ...c, code: c.callee ? body(c.callee, c.callee.name) : null }));

  const symbols = uniqueById([...owners, ...callees.flatMap((c) => (c.callee ? [c.callee] : []))]);
  const rank = new Map(symbols.map((s, i) => [s.id, i]));
  const effects = (await store.getSideEffects(symbols.map((s) => s.id)))
    .sort((a, b) => rank.get(a.symbolId)! - rank.get(b.symbolId)! || a.line - b.line)
    .map((e) => {
      const s = symbols[rank.get(e.symbolId)!];
      return { symbol: { id: s.id, file: s.file, name: s.name }, kind: e.kind, detail: e.detail, line: e.line };
    });
  const errorPaths: ErrorPath[] = effects
    .filter((e) => e.kind === 'throws')
    .map((e) => {
      const m = STATUS.exec(e.detail);
      return { symbol: e.symbol, line: e.line, error: m ? e.detail.slice(0, m.index) : e.detail, status: m ? Number(m[1]) : null };
    });

  const unresolved: UnresolvedFact[] = [
    ...[...chain, ...errorHandlers].flatMap((n) => (n.note ? [{ calleeText: n.label, file: n.registeredAt.file, line: n.registeredAt.line, note: n.note }] : [])),
    ...callees
      .filter((c) => !c.resolved)
      .map((c) => ({
        calleeText: c.calleeText,
        file: c.caller.file,
        line: c.callLine,
        note: `unresolved: likely ${c.calleeText} (dynamic call in ${c.caller.name} at ${c.caller.file}:${c.callLine})`,
      })),
  ];

  const cited = [...registrations.map((b) => b.file), ...symbols.map((s) => s.file), ...callees.map((c) => c.caller.file)];
  const files = Object.fromEntries([...new Set(cited)].sort().map((f) => [f, source.lineCount(f)]));

  return {
    scopeRef: `${route.method} ${route.fullPath}`,
    route: { id: route.id, method: route.method, fullPath: route.fullPath, mounts: route.mountChain, warnings: route.warnings },
    registrations,
    chain,
    errorHandlers,
    callees,
    sideEffects: effects.filter((e) => e.kind !== 'throws'),
    errorPaths,
    unresolved,
    packages: await collectPackages(store, Object.keys(files)),
    files,
    omitted,
    warnings: [...route.warnings, ...(await store.getRouteWarnings())],
    chainHash: chainHashOf(route, middleware),
  };
}

/** Changes when the route's middleware, their order, or the functions they resolve to change. */
export function chainHashOf(route: RouteRecord, middleware: MiddlewareRecord[]): string {
  const entry = (phase: string, label: string, s: SymbolRecord | null) => `${phase} ${label} ${s ? `${s.file}#${s.name}` : '-'}`;
  const lines = [
    `${route.method} ${route.fullPath}`,
    ...middleware.map((m) => entry(m.phase, m.label, m.symbol)),
    entry('handler', route.handlerLabel, route.handler),
  ];
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The chain hash of the route a saved endpoint walkthrough explains; null when the route is gone. */
export async function currentChainHash(store: Store, scopeRef: string): Promise<string | null> {
  const target = parseEndpointTarget(scopeRef);
  const route = (await store.listRoutes()).find((r) => r.method === target.method && r.fullPath === target.path);
  return route ? chainHashOf(route, await store.getMiddlewareChain(route.id)) : null;
}

async function findRoute(store: Store, target: EndpointTarget): Promise<RouteRecord> {
  const routes = await store.listRoutes();
  if (routes.length === 0) {
    throw new TargetError(
      'No Express routes in the index. Check that roots.backend in .walkthrough/config.json contains the code that calls express() and mounts your routers.',
    );
  }
  const matches = matchRoutes(routes, target);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new TargetError(`${target.method} ${target.path} matches ${matches.length} routes: ${matches.map(describeRoute).join(', ')}. Name one exactly.`);
  }
  const near = closestRoutes(routes, target);
  throw new TargetError(`No route matches ${target.method} ${target.path}.${near.length ? ` Closest: ${near.map(describeRoute).join(', ')}` : ''}`);
}

function describeRoute(r: RouteRecord): string {
  return `${r.method} ${r.fullPath} (${r.file}:${r.line})`;
}

/**
 * Calls made by `owners`, transitively to `depth`, one recursive query per owner. A call between two
 * owners is left out (each is a chain node of its own); a call reached from several owners is kept once.
 */
async function collectCallees(store: Store, owners: SymbolRecord[], depth: number): Promise<Omit<CalleeFact, 'code'>[]> {
  const ownerIds = new Set(owners.map((o) => o.id));
  const names = new Map<number, Pick<SymbolRecord, 'id' | 'file' | 'name'>>(owners.map((o) => [o.id, o]));
  const rows = (await Promise.all(owners.map((o) => store.getCallees(o.id, depth)))).flat().sort((a, b) => a.depth - b.depth);
  const seen = new Set<string>();
  const kept: Omit<CalleeFact, 'code'>[] = [];
  for (const row of rows) {
    if (row.callee && ownerIds.has(row.callee.id)) continue;
    const key = `${row.callerId}:${row.callLine}:${row.calleeText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const caller = names.get(row.callerId);
    if (!caller) continue;
    if (row.callee) names.set(row.callee.id, row.callee);
    kept.push({
      depth: row.depth,
      caller: { id: caller.id, file: caller.file, name: caller.name },
      callee: row.callee,
      calleeText: row.calleeText,
      callLine: row.callLine,
      resolved: row.resolved,
    });
  }
  return kept;
}

function mergeRanges(ranges: { file: string; start: number; end: number }[]): { file: string; start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  const merged: { file: string; start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = merged.at(-1);
    if (last && last.file === r.file && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

function uniqueById<T extends { id: number }>(items: T[]): T[] {
  const seen = new Set<number>();
  return items.filter((i) => !seen.has(i.id) && (seen.add(i.id), true));
}
```

- [ ] **Step 5: Export it**

In `core/src/context/index.ts` add `export * from './endpoint.js';`. In `core/src/index.ts` add `export * from './routes/match.js';`.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run core/src/context`
Expected: PASS. If `enrollHandler: forwards err null` is missing, confirm that Task 4's `next(...)` handling sees `next` as a parameter in `patientsController.ts`.

- [ ] **Step 7: Checkpoint (don't commit)**

---

### Task 9: Mermaid sequence diagram

**Files:**
- Create: `core/src/render/mermaid.ts`
- Modify: `core/src/index.ts`
- Test: `core/src/render/mermaid.test.ts`

**Interfaces:**
- Consumes: `EndpointContext` (Task 8).
- Produces: `endpointDiagram(ctx: EndpointContext): string`, a Mermaid `sequenceDiagram`. Participants are `Client`, then `P1..Pn` in order of first appearance, aliased with the label.

- [ ] **Step 1: Write the failing test**

Create `core/src/render/mermaid.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildEndpointContext } from '../context/endpoint.js';
import { indexRepo } from '../indexer/index.js';
import { openStore, type Store } from '../store/index.js';
import { endpointDiagram } from './mermaid.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;

describe('endpointDiagram', () => {
  let store: Store;
  let diagram: string;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_mmd_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    const ctx = await buildEndpointContext(store, FIXTURE, { method: 'POST', path: '/api/patients/enroll' }, { depth: 3, maxContextTokens: 60000 });
    diagram = endpointDiagram(ctx);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('draws the chain in order from the client', () => {
    const lines = diagram.split('\n');
    expect(lines[0]).toBe('sequenceDiagram');
    expect(lines).toContain('  participant Client');
    expect(lines).toContain('  participant P1 as express.json()');
    expect(lines).toContain('  participant P5 as enrollHandler');
    expect(lines).toContain('  Client->>P1: POST /api/patients/enroll');
    expect(lines).toContain('  P1->>P2: next()');
    expect(lines).toContain('  P4->>P5: next()');
    expect(lines.at(-1)).toBe('  P5-->>Client: response');
  });

  it('draws calls into modules, side effects on stores, and error statuses back to the client', () => {
    expect(diagram).toMatch(/ {2}P2->>P\d+: GET session:\$\{token\}/);
    expect(diagram).toMatch(/ {2}P5->>P\d+: enrollPatient\(\)/);
    expect(diagram).toMatch(/->>P\d+: INSERT consents/);
    expect(diagram).toMatch(/ {2}alt ConflictError\n {4}P\d+-->>Client: 409\n {2}end/);
    expect(diagram).toMatch(/participant P\d+ as Postgres/);
    expect(diagram).toMatch(/participant P\d+ as Redis/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run core/src/render/mermaid.test.ts`
Expected: FAIL. `./mermaid.js` doesn't exist.

- [ ] **Step 3: Implement `mermaid.ts`**

Create `core/src/render/mermaid.ts`:

```ts
import { basename } from 'node:path';
import type { EndpointContext, EndpointSideEffect } from '../context/endpoint.js';

// The sequence diagram of one endpoint (CLAUDE.md §6.3 item 7), drawn from static facts only, never
// by the LLM: the chain in order, then each function's calls and side effects in line order. Errors
// with a known status become `alt` blocks answering the client.

const STORES: Partial<Record<EndpointSideEffect['kind'], string>> = { db_read: 'Postgres', db_write: 'Postgres', redis: 'Redis', queue: 'Events' };
const NO_CODE = new Set(['type', 'class']);

export function endpointDiagram(ctx: EndpointContext): string {
  const participants = ['  participant Client'];
  const messages: string[] = [];
  const ids = new Map<string, string>();
  const participant = (key: string, label: string): string => {
    let id = ids.get(key);
    if (!id) {
      id = `P${ids.size + 1}`;
      ids.set(key, id);
      participants.push(`  participant ${id} as ${text(label)}`);
    }
    return id;
  };

  const visit = (symbolId: number, from: string, path: Set<number>): void => {
    const events: { line: number; emit: () => void }[] = [
      ...ctx.sideEffects
        .filter((e) => e.symbol.id === symbolId)
        .map((e) => ({ line: e.line, emit: () => messages.push(`  ${from}->>${participant(storeKey(e), storeLabel(e))}: ${text(e.detail)}`) })),
      ...ctx.errorPaths
        .filter((p) => p.symbol.id === symbolId && p.status !== null)
        .map((p) => ({ line: p.line, emit: () => messages.push(`  alt ${text(p.error)}`, `    ${from}-->>Client: ${p.status}`, '  end') })),
      ...ctx.callees
        .filter((c) => c.caller.id === symbolId && c.callee && !NO_CODE.has(c.callee.kind))
        .map((c) => ({
          line: c.callLine,
          emit: () => {
            const callee = c.callee!;
            const to = participant(`file:${callee.file}`, basename(callee.file));
            messages.push(`  ${from}->>${to}: ${text(callee.name)}()`);
            if (!path.has(callee.id)) visit(callee.id, to, new Set([...path, callee.id]));
          },
        })),
    ];
    events.sort((a, b) => a.line - b.line);
    for (const e of events) e.emit();
  };

  const nodeIds = ctx.chain.map((n, i) => participant(`node:${i}`, n.label));
  ctx.chain.forEach((n, i) => {
    const from = i === 0 ? 'Client' : nodeIds[i - 1];
    messages.push(`  ${from}->>${nodeIds[i]}: ${i === 0 ? `${ctx.route.method} ${ctx.route.fullPath}` : 'next()'}`);
    if (n.symbol) visit(n.symbol.id, nodeIds[i], new Set([n.symbol.id]));
  });
  messages.push(`  ${nodeIds.at(-1)}-->>Client: response`);
  return ['sequenceDiagram', ...participants, ...messages].join('\n');
}

function storeKey(e: EndpointSideEffect): string {
  return e.kind === 'http_out' ? `http:${host(e.detail)}` : `store:${STORES[e.kind]}`;
}

function storeLabel(e: EndpointSideEffect): string {
  return e.kind === 'http_out' ? host(e.detail) : STORES[e.kind]!;
}

function host(detail: string): string {
  try {
    return new URL(detail.split(' ')[1] ?? '').host;
  } catch {
    return 'HTTP';
  }
}

/** Mermaid ends a statement at ";" and reads "#" as an entity; neither may appear in labels. */
function text(s: string): string {
  return s.replace(/[;#\n]/g, ' ').trim();
}
```

Add `export { endpointDiagram } from './render/mermaid.js';` to `core/src/index.ts`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run core/src/render`
Expected: PASS.

- [ ] **Step 5: Checkpoint (don't commit)**

---

### Task 10: Verifier, generation and prompt for endpoints

**Files:**
- Modify: `core/src/verify/verify.ts`, `core/src/llm/generate.ts`, `core/src/llm/prompt.ts`, `core/src/llm/index.ts`
- Create: `core/src/llm/endpointPrompt.ts`
- Create: `core/src/llm/__fixtures__/enrollEndpoint.response.json`
- Create: `core/src/walkthrough/endpoint.ts` (`explainEndpoint` only; the rest comes in Task 11)
- Test: `core/src/verify/verify.test.ts` (add a case), `core/src/walkthrough/endpoint.test.ts`

**Interfaces:**
- Consumes: `EndpointContext` (Task 8), `fence` (`llm/prompt.ts`), `DocsResolver`, `NoVerifiedStepsError`, `FnWalkthrough`.
- Produces:
  - `VerifyFacts { files: Record<string, number>; vocabulary: Set<string>; packages: Set<string> }`
  - `verifyWalkthrough(w: Walkthrough, facts: VerifyFacts): VerifyResult`. `verifyFnWalkthrough` keeps its signature and delegates.
  - `vocabularyOf(texts: Iterable<string | null | undefined>): Set<string>`
  - `endpointVerifyFacts(ctx: EndpointContext): VerifyFacts`
  - `generateWalkthrough(provider, request: { system: string; prompt: string }): Promise<GenerateResult>`. `generateFnWalkthrough` delegates.
  - `ENDPOINT_SYSTEM_PROMPT`, `renderEndpointPrompt(ctx): string`. The first prompt line is `# Endpoint: <METHOD> <path>`.
  - `explainEndpoint(provider, ctx, repoRoot): Promise<FnWalkthrough>`. `scope.symbol` is the route (`"POST /api/patients/enroll"`).
  - `describe` in `llm/prompt.ts` is exported.

- [ ] **Step 1: Write the failing verifier test**

Add to `core/src/verify/verify.test.ts` (import `verifyWalkthrough` and `vocabularyOf` from `./verify.js`):

```ts
describe('verifyWalkthrough with explicit facts', () => {
  const step = (id: string, file: string, explanation: string) => ({
    id, code_ref: { file, start: 1, end: 2 }, explanation, example: { input: 'x', state_after: 'y' },
    references: [], docs: [{ package: 'express', symbol: 'Router' }], concepts: [], risks: [],
  });

  it('accepts code_refs into any cited file and checks identifiers against the given vocabulary', () => {
    const facts = { files: { 'a.ts': 10, 'b.ts': 5 }, vocabulary: vocabularyOf(['const total = add(a, b)']), packages: new Set<string>() };
    const result = verifyWalkthrough(
      { title: 't', summary: 's', unresolved: [], stages: [{ name: 'S', steps: [step('s1', 'a.ts', 'Calls `add`.'), step('s2', 'b.ts', 'Uses `missing`.')] }] },
      facts,
    );
    expect(result.walkthrough.stages[0].steps.map((s) => s.id)).toEqual(['s1']);
    expect(result.dropped[0].reasons[0]).toContain('`missing`');
    expect(result.removedDocs).toEqual([{ stepId: 's1', package: 'express', symbol: 'Router' }]);
  });
});
```

Run: `pnpm vitest run core/src/verify`
Expected: FAIL. `verifyWalkthrough` is not exported.

- [ ] **Step 2: Generalise the verifier**

In `core/src/verify/verify.ts`:

```ts
import type { EndpointContext } from '../context/endpoint.js';
```

```ts
/** What a walkthrough may cite: files with their line counts, identifiers, and imported packages. */
export interface VerifyFacts {
  files: Record<string, number>;
  vocabulary: Set<string>;
  packages: Set<string>;
}

export function verifyFnWalkthrough(walkthrough: Walkthrough, ctx: FnContext): VerifyResult {
  return verifyWalkthrough(walkthrough, { files: ctx.files, vocabulary: buildVocabulary(ctx), packages: new Set(ctx.packages.map((p) => p.name)) });
}

export function verifyWalkthrough(walkthrough: Walkthrough, facts: VerifyFacts): VerifyResult {
  const dropped: DroppedStep[] = [];
  const removedDocs: VerifyResult['removedDocs'] = [];

  const stages = walkthrough.stages
    .map((stage) => ({
      ...stage,
      steps: stage.steps.flatMap((step): Step[] => {
        const reasons = checkStep(step, facts.files, facts.vocabulary);
        if (reasons.length > 0) {
          dropped.push({ stepId: step.id, reasons });
          return [];
        }
        const docs = step.docs.filter((d) => {
          if (facts.packages.has(d.package)) return true;
          removedDocs.push({ stepId: step.id, ...d });
          return false;
        });
        return [{ ...step, docs }];
      }),
    }))
    .filter((stage) => stage.steps.length > 0);

  return { walkthrough: { ...walkthrough, stages }, dropped, removedDocs };
}

/** Language words plus every identifier in `texts`. */
export function vocabularyOf(texts: Iterable<string | null | undefined>): Set<string> {
  const vocabulary = new Set(LANGUAGE_WORDS);
  for (const text of texts) if (text) for (const id of identifiers(text)) vocabulary.add(id);
  return vocabulary;
}

/** Everything an endpoint walkthrough may name or cite. */
export function endpointVerifyFacts(ctx: EndpointContext): VerifyFacts {
  const nodes = [...ctx.chain, ...ctx.errorHandlers];
  const symbols = [...nodes.flatMap((n) => (n.symbol ? [n.symbol] : [])), ...ctx.callees.flatMap((c) => (c.callee ? [c.callee] : []))];
  return {
    files: ctx.files,
    packages: new Set(ctx.packages.map((p) => p.name)),
    vocabulary: vocabularyOf([
      ...ctx.registrations.map((b) => b.lines.join('\n')),
      ...nodes.map((n) => n.code?.lines.join('\n')),
      ...ctx.callees.map((c) => c.code?.lines.join('\n')),
      ...nodes.map((n) => n.label),
      ...symbols.flatMap((s) => [s.name, s.signature]),
      ...ctx.callees.map((c) => c.calleeText),
      ...ctx.sideEffects.map((e) => e.detail),
      ...ctx.errorPaths.map((p) => p.error),
      ...ctx.packages.flatMap((p) => [p.name, ...p.importedNames]),
      ctx.route.fullPath,
    ]),
  };
}
```

(The old body of `verifyFnWalkthrough` moves into `verifyWalkthrough`; `checkStep`, `buildVocabulary`, `codeSpans`, `identifiers` are unchanged.)

Run: `pnpm vitest run core/src/verify`
Expected: PASS.

- [ ] **Step 3: Generalise generation**

In `core/src/llm/generate.ts`, replace `generateFnWalkthrough` with:

```ts
/** Asks for a walkthrough of `ctx`; a response that fails the §8.2 schema is re-requested up to twice. */
export async function generateFnWalkthrough(provider: LlmProvider, ctx: FnContext, options: FnPromptOptions = {}): Promise<GenerateResult> {
  return generateWalkthrough(provider, { system: FN_SYSTEM_PROMPT, prompt: renderFnPrompt(ctx, options) });
}

/** One walkthrough request: the response must match the §8.2 schema; invalid output is re-requested up to twice. */
export async function generateWalkthrough(provider: LlmProvider, request: { system: string; prompt: string }): Promise<GenerateResult> {
  const messages: LlmMessage[] = [{ role: 'user', content: request.prompt }];
  let lastProblem = '';

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const raw = await provider.generate({ system: request.system, messages });
    const problem = validate(raw);
    if (typeof problem !== 'string') return { walkthrough: problem, attempts: attempt };

    lastProblem = problem;
    messages.push(
      { role: 'assistant', content: raw },
      { role: 'user', content: `That response is not valid:\n${problem}\nReturn the complete corrected walkthrough as JSON.` },
    );
  }
  throw new LlmOutputError(`The model returned invalid output ${MAX_RETRIES + 1} times. Last problem:\n${lastProblem}`, MAX_RETRIES + 1);
}
```

In `core/src/llm/prompt.ts`, change `function describe(` to `export function describe(`.

- [ ] **Step 4: Write the endpoint prompt**

Create `core/src/llm/endpointPrompt.ts`:

```ts
import type { EndpointContext, EndpointNode } from '../context/endpoint.js';
import { describe, fence } from './prompt.js';

// Turns an EndpointContext into the prompt. Same contract as `walk fn` (CLAUDE.md §8.2): the model
// sees only these facts and cites only them; the verifier enforces it afterwards.

export const ENDPOINT_SYSTEM_PROMPT = `You explain how one HTTP endpoint of a TypeScript Express backend works, to a developer who must be able to explain it to someone else afterwards.

You are given facts from static analysis: the route and the routers it is mounted through, the middleware chain in execution order, the handler, the code they call, the side effects found in each function (database, Redis, outbound HTTP, events, thrown errors) and the error handlers. Explain only what these facts show.

Rules:
- Never invent files, line numbers, symbols or behaviour. If something is not in the facts, say it is unknown or put it in "unresolved".
- Use these stages, in this order, and leave out any with no steps: "Request", "Middleware", "Validation", "Business logic", "Persistence", "Response". "Request" is how the request reaches the chain (registrations, body parsing); "Validation" is code that checks the input; "Persistence" is code that reads or writes databases, caches or queues.
- Steps follow the order a request executes: middleware in chain order, then the handler and what it calls. Each step covers a contiguous group of lines in ONE file: "code_ref" is a file listed under "Files you may cite" and a start/end line inside code shown to you.
- "explanation": what the lines do and why, in plain English. Wrap every identifier and code expression in backticks, and only use identifiers that appear in the given code or facts.
- "example": invent ONE concrete, realistic request at the first step (method, path, the headers that matter, JSON body) and trace that same request through every step. "input" names the request in effect; "state_after" lists what changed: \`req\` fields, local variables, rows written, keys set, the response. Compute values carefully from the code; when a value depends on code you were not shown (a database, a package, an unresolved call), say what it is assumed to be.
- "references": only file:line locations given in the facts (registrations, function definitions, call sites), with role "caller", "callee" or "type". Use an empty list when none apply.
- "docs": only for calls into packages listed under "Packages". "package" is the package name exactly as listed and "symbol" is the API used (e.g. "express.json", "Router", "pool.query"). Never write URLs.
- "concepts": short names of general ideas a reader should know (e.g. "middleware chain", "database transaction").
- "risks": what can go wrong at this step and what the client then receives, using the "Error paths" and error handlers given (e.g. "Missing token: UnauthorizedError, 401 via errorHandler"). Empty list if none.
- Step ids are unique, e.g. "s1", "s2".
- "unresolved": copy every note listed under "Unresolved", plus anything else you could not determine.`;

export function renderEndpointPrompt(ctx: EndpointContext): string {
  const out: string[] = [];
  const { route } = ctx;
  out.push(`# Endpoint: ${route.method} ${route.fullPath}`);

  out.push('## Mounted through');
  if (route.mounts.length === 0) out.push('(registered directly on the app)');
  for (const m of route.mounts) out.push(`- \`${m.prefix}\` at ${m.file}:${m.line}`);

  out.push('## Registrations');
  for (const b of ctx.registrations) out.push(fence(b));

  out.push('## Middleware chain and handler, in execution order');
  ctx.chain.forEach((n, i) => pushNode(out, n, `${i + 1}.`));

  out.push('## Error handlers (run when a step above fails)');
  if (ctx.errorHandlers.length === 0) out.push("(none registered: Express answers with its default 500 handler)");
  for (const n of ctx.errorHandlers) pushNode(out, n, '-');

  out.push('## Called code');
  if (ctx.callees.length === 0) out.push('(none)');
  for (const c of ctx.callees) {
    const where = `${c.caller.name} at ${c.caller.file}:${c.callLine}`;
    if (c.callee) {
      out.push(`- [depth ${c.depth}] ${where} calls ${describe(c.callee)}`);
      if (c.code) out.push(fence(c.code));
    } else if (c.resolved) {
      out.push(`- [depth ${c.depth}] ${where} calls \`${c.calleeText}\` (package or built-in)`);
    } else {
      out.push(`- [depth ${c.depth}] ${where} calls \`${c.calleeText}\` (UNRESOLVED dynamic call)`);
    }
  }

  out.push('## Side effects');
  if (ctx.sideEffects.length === 0) out.push('(none found)');
  for (const e of ctx.sideEffects) out.push(`- ${e.symbol.name} (${e.symbol.file}:${e.line}): ${e.kind} ${e.detail}`);

  out.push('## Error paths');
  if (ctx.errorPaths.length === 0) out.push('(none found)');
  for (const p of ctx.errorPaths) {
    out.push(`- ${p.symbol.name} (${p.symbol.file}:${p.line}): ${p.error}${p.status !== null ? ` -> HTTP ${p.status}` : ' -> status decided by the error handler'}`);
  }

  out.push('## Packages (imported by the files above)');
  if (ctx.packages.length === 0) out.push('(none)');
  for (const p of ctx.packages) out.push(`- ${p.name}${p.version ? `@${p.version}` : ''} (from "${p.importedPath}"): ${p.importedNames.join(', ')}`);

  if (ctx.unresolved.length > 0) {
    out.push('## Unresolved');
    for (const u of ctx.unresolved) out.push(`- ${u.note}`);
  }
  if (ctx.omitted.length > 0) {
    out.push('## Left out to fit the context budget');
    for (const o of ctx.omitted) out.push(`- ${o}`);
  }

  out.push('## Files you may cite (with line counts)');
  for (const [file, lines] of Object.entries(ctx.files)) out.push(`- ${file}: ${lines} lines`);

  out.push(`Write the walkthrough of ${route.method} ${route.fullPath}.`);
  return out.join('\n\n');
}

function pushNode(out: string[], n: EndpointNode, bullet: string): void {
  const what = n.symbol ? describe(n.symbol) : '(package or unresolved: its code is not in the repo)';
  out.push(`${bullet} [${n.phase}] \`${n.label}\`, registered at ${n.registeredAt.file}:${n.registeredAt.line}: ${what}`);
  if (n.note) out.push(`note: ${n.note}`);
  if (n.code) out.push(fence(n.code));
}
```

Update `core/src/llm/index.ts`:

```ts
export { generateFnWalkthrough, generateWalkthrough, LlmOutputError, type GenerateResult, type LlmMessage, type LlmProvider } from './generate.js';
export { ENDPOINT_SYSTEM_PROMPT, renderEndpointPrompt } from './endpointPrompt.js';
```

- [ ] **Step 5: Write the handcrafted response**

Create `core/src/llm/__fixtures__/enrollEndpoint.response.json`:

```json
{
  "title": "How POST /api/patients/enroll works",
  "summary": "The request passes JSON body parsing, session auth, rate limiting and schema validation before enrollHandler enrolls the patient in one database transaction and answers 201.",
  "stages": [
    {
      "name": "Request",
      "steps": [
        {
          "id": "s1",
          "code_ref": { "file": "api/app.ts", "start": 9, "end": 10 },
          "explanation": "`express.json` parses the JSON body into `req.body`, then `app.use` hands every path under `/api` to `apiRouter`.",
          "example": {
            "input": "POST /api/patients/enroll, Authorization: Bearer tok_1, body {\"firstName\":\"Asha\",\"lastName\":\"Rao\",\"phone\":\"+91 98765-43210\",\"dateOfBirth\":\"1990-04-02\"}",
            "state_after": "req.body = { firstName: \"Asha\", lastName: \"Rao\", phone: \"+91 98765-43210\", dateOfBirth: \"1990-04-02\" }"
          },
          "references": [{ "file": "api/routes/index.ts", "line": 6, "role": "callee" }],
          "docs": [{ "package": "express", "symbol": "express.json" }],
          "concepts": ["middleware chain", "router mounting"],
          "risks": ["A malformed JSON body is rejected before any route code runs."]
        }
      ]
    },
    {
      "name": "Middleware",
      "steps": [
        {
          "id": "s2",
          "code_ref": { "file": "api/middleware/auth.ts", "start": 11, "end": 23 },
          "explanation": "`requireAuth` takes the bearer token from the `authorization` header, loads `session:${token}` with `redis.get` and stores the parsed `SessionUser` on `req.user`.",
          "example": { "input": "the same request", "state_after": "token = \"tok_1\"; req.user = { id: \"u_7\", role: \"staff\" } (session assumed to exist in Redis)" },
          "references": [{ "file": "api/routes/patients.ts", "line": 11, "role": "caller" }],
          "docs": [],
          "concepts": ["bearer token", "session store"],
          "risks": ["Missing token or expired session: UnauthorizedError, 401 via errorHandler"]
        },
        {
          "id": "s3",
          "code_ref": { "file": "api/middleware/rateLimit.ts", "start": 9, "end": 17 },
          "explanation": "`rateLimit` counts requests per client with `redis.incr` on `ratelimit:${req.ip}`, sets an expiry with `redis.expire` on the first hit, and passes `TooManyRequestsError` to `next` once the count is over the limit.",
          "example": { "input": "the same request from 10.0.0.5", "state_after": "key = \"ratelimit:10.0.0.5\"; count = 1; expiry set" },
          "references": [{ "file": "api/routes/patients.ts", "line": 13, "role": "caller" }],
          "docs": [],
          "concepts": ["fixed-window rate limiting"],
          "risks": ["Too many requests: TooManyRequestsError, 429 via errorHandler"]
        }
      ]
    },
    {
      "name": "Validation",
      "steps": [
        {
          "id": "s4",
          "code_ref": { "file": "api/middleware/validate.ts", "start": 7, "end": 13 },
          "explanation": "`validateBody` runs `schema.safeParse` on `req.body`; on failure it passes a `ValidationError` with the issue list to `next`, otherwise it replaces `req.body` with `result.data`.",
          "example": { "input": "the same body", "state_after": "result.success = true; req.body is the parsed EnrollInput" },
          "references": [{ "file": "api/routes/patients.ts", "line": 13, "role": "caller" }],
          "docs": [],
          "concepts": ["schema validation"],
          "risks": ["Invalid body: ValidationError, 400 with the issues list"]
        }
      ]
    },
    {
      "name": "Business logic",
      "steps": [
        {
          "id": "s5",
          "code_ref": { "file": "api/controllers/patientsController.ts", "start": 9, "end": 10 },
          "explanation": "`enrollHandler` reads `user` from the request and calls `enrollPatient` with `req.body` and `user.id`.",
          "example": { "input": "the same request", "state_after": "enrollPatient(body, \"u_7\") is awaited" },
          "references": [{ "file": "api/services/enrollService.ts", "line": 35, "role": "callee" }],
          "docs": [],
          "concepts": ["controller / service split"],
          "risks": ["Any error is passed to next(err) and answered by errorHandler."]
        },
        {
          "id": "s6",
          "code_ref": { "file": "api/services/enrollService.ts", "start": 36, "end": 45 },
          "explanation": "`enrollPatient` normalizes the phone with `normalizePhone`, rejects anyone under 18 using `calculateAge`, and throws `ConflictError` when `findPatientByPhone` finds an existing patient.",
          "example": { "input": "phone \"+91 98765-43210\", dateOfBirth \"1990-04-02\"", "state_after": "phone = \"9876543210\"; age = 36; existing = null (assumed)" },
          "references": [{ "file": "api/repositories/patientRepository.ts", "line": 19, "role": "callee" }],
          "docs": [],
          "concepts": ["input normalization"],
          "risks": ["Under 18 or phone already enrolled: ConflictError, 409 via errorHandler"]
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
          "example": { "input": "the normalized input", "state_after": "patients row inserted (id assumed \"p_42\"); consents row inserted; transaction committed" },
          "references": [
            { "file": "api/repositories/patientRepository.ts", "line": 35, "role": "callee" },
            { "file": "api/repositories/patientRepository.ts", "line": 45, "role": "callee" }
          ],
          "docs": [],
          "concepts": ["database transaction"],
          "risks": ["A failed insert rolls the transaction back and the error reaches errorHandler as a 500."]
        },
        {
          "id": "s8",
          "code_ref": { "file": "api/services/enrollService.ts", "start": 60, "end": 61 },
          "explanation": "After the commit it caches the patient under `patient:${patient.id}` with `redis.set` and emits `patient.enrolled` on `bus`.",
          "example": { "input": "patient p_42", "state_after": "Redis key patient:p_42 set; patient.enrolled emitted" },
          "references": [],
          "docs": [],
          "concepts": ["cache write-through", "in-process events"],
          "risks": []
        }
      ]
    },
    {
      "name": "Response",
      "steps": [
        {
          "id": "s9",
          "code_ref": { "file": "api/controllers/patientsController.ts", "start": 11, "end": 11 },
          "explanation": "`res.status` sets 201 and `res.json` sends the created patient back.",
          "example": { "input": "patient p_42", "state_after": "HTTP 201 with the patient JSON" },
          "references": [],
          "docs": [],
          "concepts": [],
          "risks": []
        }
      ]
    }
  ],
  "unresolved": ["Listeners of patient.enrolled are registered at runtime, so what runs after the emit is unknown statically."]
}
```

- [ ] **Step 6: Write the failing `explainEndpoint` test**

Create `core/src/walkthrough/endpoint.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildEndpointContext, type EndpointContext } from '../context/endpoint.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmMessage, LlmProvider } from '../llm/generate.js';
import { openStore, type Store } from '../store/index.js';
import { explainEndpoint } from './endpoint.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollEndpoint.response.json', import.meta.url), 'utf8');

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

describe('explainEndpoint on the fixture', () => {
  let store: Store;
  let ctx: EndpointContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_epw_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildEndpointContext(store, FIXTURE, { method: 'POST', path: '/api/patients/enroll' }, { depth: 3, maxContextTokens: 60000 });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('keeps every grounded step, in the fixed stage order, with docs links and static unresolved notes', async () => {
    const { provider, requests } = replay(RECORDED);
    const w = await explainEndpoint(provider, ctx, FIXTURE);
    expect(w.verification.dropped).toEqual([]);
    expect(w.verification.keptSteps).toBe(9);
    expect(w.stages.map((s) => s.name)).toEqual(['Request', 'Middleware', 'Validation', 'Business logic', 'Persistence', 'Response']);
    expect(w.scope).toMatchObject({ file: 'api/controllers/patientsController.ts', start: 7, end: 15, symbol: 'POST /api/patients/enroll' });
    expect(w.stages[0].steps[0].docLinks[0]).toMatchObject({ package: 'express', symbol: 'express.json' });
    expect(w.unresolved.some((u) => u.includes('bus.emit'))).toBe(true);

    const prompt = requests[0][0].content;
    expect(prompt.split('\n')[0]).toBe('# Endpoint: POST /api/patients/enroll');
    expect(prompt).toContain('2. [router] `requireAuth`, registered at api/routes/patients.ts:11');
    expect(prompt).toContain('insertConsent (api/repositories/patientRepository.ts:46): db_write INSERT consents');
  });

  it('drops a step that cites a file outside the context', async () => {
    const bad = JSON.parse(RECORDED);
    bad.stages[0].steps[0].code_ref.file = 'web/apiClient.ts';
    const { provider } = replay(JSON.stringify(bad));
    const w = await explainEndpoint(provider, ctx, FIXTURE);
    expect(w.verification.dropped.map((d) => d.stepId)).toEqual(['s1']);
  });
});
```

`insertConsent`'s `client.query` call starts on line 46 of `patientRepository.ts`: line 45 is the function header and line 46 is `await client.query(`.

Run: `pnpm vitest run core/src/walkthrough/endpoint.test.ts`
Expected: FAIL. `./endpoint.js` doesn't exist.

- [ ] **Step 7: Implement `explainEndpoint`**

Create `core/src/walkthrough/endpoint.ts`:

```ts
import { dirname, join } from 'node:path';
import type { EndpointContext } from '../context/endpoint.js';
import { DocsResolver } from '../docs/resolve.js';
import { ENDPOINT_SYSTEM_PROMPT, renderEndpointPrompt } from '../llm/endpointPrompt.js';
import { generateWalkthrough, type LlmProvider } from '../llm/generate.js';
import { endpointVerifyFacts, verifyWalkthrough } from '../verify/verify.js';
import { NoVerifiedStepsError, type FnWalkthrough } from './fn.js';

// `walk endpoint` after the facts are gathered: LLM -> verifier -> docs links (CLAUDE.md §6.3, §8.3).

export async function explainEndpoint(provider: LlmProvider, ctx: EndpointContext, repoRoot: string): Promise<FnWalkthrough> {
  const { walkthrough, attempts } = await generateWalkthrough(provider, { system: ENDPOINT_SYSTEM_PROMPT, prompt: renderEndpointPrompt(ctx) });
  const verified = verifyWalkthrough(walkthrough, endpointVerifyFacts(ctx));
  const keptSteps = verified.walkthrough.stages.reduce((n, s) => n + s.steps.length, 0);
  if (keptSteps === 0) throw new NoVerifiedStepsError(verified.dropped);

  const packages = new Map(ctx.packages.map((p) => [p.name, p]));
  const resolvers = new Map<string, DocsResolver>();
  // Each step's docs resolve from its own file's directory (nearest package.json / node_modules).
  const docsFor = (file: string) => {
    const dir = dirname(join(repoRoot, file));
    if (!resolvers.has(dir)) resolvers.set(dir, new DocsResolver(repoRoot, dir));
    return resolvers.get(dir)!;
  };
  const unresolved = [...new Set([...ctx.unresolved.map((u) => u.note), ...verified.walkthrough.unresolved])];
  const handler = ctx.chain.at(-1)!;

  return {
    scope: {
      file: handler.symbol?.file ?? handler.registeredAt.file,
      start: handler.symbol?.startLine ?? handler.registeredAt.line,
      end: handler.symbol?.endLine ?? handler.registeredAt.endLine,
      symbol: ctx.scopeRef,
    },
    title: verified.walkthrough.title,
    summary: verified.walkthrough.summary,
    stages: verified.walkthrough.stages.map((stage) => ({
      name: stage.name,
      steps: stage.steps.map((step) => ({ ...step, docLinks: step.docs.map((d) => docsFor(step.code_ref.file).resolve(d, packages.get(d.package)!)) })),
    })),
    unresolved,
    verification: { attempts, keptSteps, dropped: verified.dropped, removedDocs: verified.removedDocs },
  };
}
```

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run core/src/walkthrough/endpoint.test.ts core/src/verify core/src/walkthrough/fn.test.ts`
Expected: PASS. If a step of the handcrafted response is dropped, the drop reason names the problem (an identifier missing from the context, or a line out of range). Fix the **fixture's wording or line numbers** so they match the real code. Never loosen the verifier.

- [ ] **Step 9: Checkpoint (don't commit)**

---

### Task 11: Sections, staleness, persistence and Markdown for endpoints

**Files:**
- Modify: `core/src/walkthrough/saved.ts`, `section.ts`, `staleness.ts`, `endpoint.ts`, `index.ts`
- Modify: `core/src/render/markdown.ts`
- Test: `core/src/walkthrough/endpointSection.test.ts`

**Interfaces:**
- Consumes: `explainEndpoint` (Task 10), `EndpointContext`, `endpointDiagram` (Task 9).
- Produces:
  - `ScopeKind = 'fn' | 'file' | 'endpoint'`
  - `Section.blocks?: BlockRef[]`, `Section.chainHash?: string`
  - `SavedWalkthrough.endpoint?: EndpointOverview`
  - `EndpointOverview { method; path; mounts; chain; errorHandlers; sideEffects; errorPaths; warnings; diagram }`
  - `endpointNotes(o: EndpointOverview): string[]`
  - `recordSection(walkthrough, block, citedFiles, repoRoot, { model, depth }): Section` (section.ts; `generateSection` uses it)
  - exported `findLine` and `droppedNote` from `section.ts`
  - `endpointBlocks(ctx): BlockRef[]`
  - `generateEndpointSection(provider, ctx, repoRoot, { model, depth }): Promise<Section>`
  - `reuseEndpointSection(prev, current: { blocks: BlockRef[]; chainHash: string }, files: SourceFiles, depth: number): Section | null`
  - `endpointOverviewOf(ctx): EndpointOverview`
  - `checkWalkthrough(saved, source, chains?: (scopeRef: string) => string | null | undefined)`
  - `WalkthroughStatus.chainChanged`, `WalkthroughStatus.routeRemoved`, `SectionStatus.changedBlocks?: string[]`

- [ ] **Step 1: Write the failing test**

Create `core/src/walkthrough/endpointSection.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type WalkConfig } from '../config.js';
import { buildEndpointContext } from '../context/endpoint.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmProvider } from '../llm/generate.js';
import { renderMarkdown } from '../render/markdown.js';
import { openStore, type Store } from '../store/index.js';
import { endpointBlocks, endpointOverviewOf, generateEndpointSection, reuseEndpointSection } from './endpoint.js';
import { SAVED_VERSION, sourceFiles, type SavedWalkthrough, type Section } from './saved.js';
import { checkWalkthrough, filesOf, loadCurrentSource } from './staleness.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollEndpoint.response.json', import.meta.url), 'utf8');
const TARGET = { method: 'POST', path: '/api/patients/enroll' };
const OPTIONS = { depth: 3, maxContextTokens: 60000 };
const recorded: LlmProvider = { generate: async () => RECORDED };

describe('endpoint sections', () => {
  let repo: string;
  let config: WalkConfig;
  let store: Store;
  let section: Section;
  let saved: SavedWalkthrough;

  const context = async () => {
    await indexRepo(repo, config, store);
    return buildEndpointContext(store, repo, TARGET, OPTIONS);
  };
  const edit = (file: string, from: string, to: string) => {
    const path = join(repo, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-epsec-'));
    cpSync(FIXTURE, repo, { recursive: true });
    config = loadConfig(repo);
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_epsec_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    const ctx = await context();
    section = await generateEndpointSection(recorded, ctx, repo, { model: 'test-model', depth: 3 });
    saved = { version: SAVED_VERSION, scopeKind: 'endpoint', scopeRef: ctx.scopeRef, overview: null, endpoint: endpointOverviewOf(ctx), sections: [section] };
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('records every explained block, handler first, and the chain hash', async () => {
    const ctx = await context();
    expect(section.block.symbol).toBe('enrollHandler');
    expect(section.blocks![0]).toEqual(section.block);
    expect(section.blocks!.map((b) => b.symbol)).toEqual(expect.arrayContaining(['requireAuth', 'validate.validateBody', 'enrollPatient', 'insertConsent', null]));
    expect(section.chainHash).toBe(ctx.chainHash);
  });

  it('renders Markdown with the route notes and the sequence diagram', () => {
    const md = renderMarkdown(saved, (f) => readFileSync(join(repo, f), 'utf8').split('\n'));
    expect(md).toContain('# How POST /api/patients/enroll works');
    expect(md).toContain('- Middleware chain: express.json() [app] → requireAuth [router] → rateLimit [route] → validate.validateBody [route] → enrollHandler [handler]');
    expect(md).toContain('```mermaid\nsequenceDiagram');
    expect(md).toContain('### Step 1 · `api/app.ts:9-10`');
  });

  it('is fresh and reused unchanged while the code is unchanged', async () => {
    const ctx = await context();
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    expect(checkWalkthrough(saved, source, () => ctx.chainHash).fresh).toBe(true);
    const reused = reuseEndpointSection(section, { blocks: endpointBlocks(ctx), chainHash: ctx.chainHash }, sourceFiles(repo), 3);
    expect(reused?.walkthrough.stages).toEqual(section.walkthrough.stages);
  });

  it('reuses with shifted lines when only line positions change (no LLM call)', async () => {
    edit('api/services/enrollService.ts', 'import { pool }', '// one\n// two\nimport { pool }');
    const ctx = await context();
    const reused = reuseEndpointSection(section, { blocks: endpointBlocks(ctx), chainHash: ctx.chainHash }, sourceFiles(repo), 3);
    expect(reused).not.toBeNull();
    const s6 = reused!.walkthrough.stages.flatMap((s) => s.steps).find((s) => s.id === 's6')!;
    expect(s6.code_ref).toEqual({ file: 'api/services/enrollService.ts', start: 38, end: 47 });
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    expect(checkWalkthrough(saved, source, () => ctx.chainHash)).toMatchObject({ fresh: true, staleSteps: 0 });
  });

  it('goes stale, naming the changed block, when a callee body changes', async () => {
    edit('api/repositories/patientRepository.ts', 'VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())');
    const ctx = await context();
    expect(reuseEndpointSection(section, { blocks: endpointBlocks(ctx), chainHash: ctx.chainHash }, sourceFiles(repo), 3)).toBeNull();
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    const status = checkWalkthrough(saved, source, () => ctx.chainHash);
    expect(status.fresh).toBe(false);
    expect(status.sections[0].changedBlocks).toEqual(['insertConsent']);
    expect(status.staleSteps).toBe(0);
  });

  it('reports a changed chain and a removed route', async () => {
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    expect(checkWalkthrough(saved, source, () => 'other')).toMatchObject({ fresh: false, chainChanged: true, routeRemoved: false });
    expect(checkWalkthrough(saved, source, () => null)).toMatchObject({ fresh: false, routeRemoved: true });
  });
});
```

Steps s1-s9 cite lines in blocks that are all part of the context: `app.ts:9-11` (a merged registration block), `requireAuth`, `rateLimit`, `validate.validateBody`, `enrollHandler`, and `enrollPatient`'s body.

Run: `pnpm vitest run core/src/walkthrough/endpointSection.test.ts`
Expected: FAIL. `generateEndpointSection` is not exported.

- [ ] **Step 2: Extend `saved.ts`**

In `core/src/walkthrough/saved.ts`:

```ts
export type ScopeKind = 'fn' | 'file' | 'endpoint';
```

Add to `Section`:

```ts
  /** Endpoint sections: every code block sent to the LLM, `block` (the handler) first. */
  blocks?: BlockRef[];
  /** Endpoint sections: chainHashOf the route when generated. */
  chainHash?: string;
```

Add the overview type, and the field on `SavedWalkthrough`:

```ts
/** An endpoint's route facts (CLAUDE.md §6.3), from the index alone; rebuilt on every run. */
export interface EndpointOverview {
  method: string;
  path: string;
  mounts: { file: string; line: number; prefix: string }[];
  chain: { phase: string; label: string; at: string }[];
  errorHandlers: { phase: string; label: string; at: string }[];
  sideEffects: { symbol: string; kind: string; detail: string; at: string }[];
  errorPaths: { symbol: string; error: string; status: number | null; at: string }[];
  warnings: string[];
  /** Mermaid sequenceDiagram source. */
  diagram: string;
}
```

```ts
export interface SavedWalkthrough {
  version: typeof SAVED_VERSION;
  scopeKind: ScopeKind;
  /** "file#symbol" or "file:start-end" for fn, "file" for file, "METHOD /path" for endpoint. */
  scopeRef: string;
  overview: FileOverview | null;
  /** Endpoint walkthroughs only. */
  endpoint?: EndpointOverview;
  sections: Section[];
}
```

Update `contentHashOf` so endpoint sections hash every block:

```ts
export function contentHashOf(sections: Section[]): string {
  const keys = sections.flatMap((s) => (s.blocks ?? [s.block]).map((b) => `${b.file}#${b.symbol ?? `${b.start}-${b.end}`}:${b.hash}`));
  return createHash('sha256').update(keys.join('\n')).digest('hex');
}
```

In `flattenWalkthrough`, change the first line to `if (saved.scopeKind !== 'file') return saved.sections[0].walkthrough;`.

Add after `overviewNotes`:

```ts
/** The endpoint overview as plain lines, shared by the terminal, the stepper and Markdown. */
export function endpointNotes(o: EndpointOverview): string[] {
  return [
    `Route: ${o.method} ${o.path}`,
    `Mounted via: ${o.mounts.map((m) => `${m.prefix} (${m.file}:${m.line})`).join(' → ') || 'directly on the app'}`,
    `Middleware chain: ${o.chain.map((n) => `${n.label} [${n.phase}]`).join(' → ')}`,
    `Error handlers: ${o.errorHandlers.map((n) => `${n.label} (${n.at})`).join(', ') || 'none (Express default)'}`,
    ...o.sideEffects.map((e) => `Side effect: ${e.kind} ${e.detail} in ${e.symbol} (${e.at})`),
    ...o.errorPaths.map((p) => `Can fail: ${p.error}${p.status !== null ? ` → ${p.status}` : ''} in ${p.symbol} (${p.at})`),
    ...o.warnings.map((w) => `Warning: ${w}`),
  ];
}
```

- [ ] **Step 3: Factor section bookkeeping in `section.ts`**

In `core/src/walkthrough/section.ts`, split `generateSection` into explain + record, and export the helpers that reuse needs:

```ts
export async function generateSection(
  provider: LlmProvider,
  ctx: FnContext,
  repoRoot: string,
  options: { symbol: string | null; model: string; depth: number; condensed?: boolean },
): Promise<Section> {
  const walkthrough = await explainFn(provider, ctx, repoRoot, { condensed: options.condensed });
  const { target } = ctx;
  const block = { file: target.file, symbol: options.symbol, start: target.start, end: target.end, hash: hashLines(target.code.lines) };
  return recordSection(walkthrough, block, Object.keys(ctx.files), repoRoot, options);
}

/** A section for an explained walkthrough: hashes of its block, its steps' lines and the files it cites. */
export function recordSection(
  walkthrough: FnWalkthrough,
  block: BlockRef,
  citedFiles: string[],
  repoRoot: string,
  options: { model: string; depth: number },
): Section {
  const files = sourceFiles(repoRoot);
  const lines = (file: string) => files.lines(file) ?? [];
  const steps = walkthrough.stages.flatMap((s) => s.steps);
  const refLines: Record<string, string> = {};
  for (const r of steps.flatMap((s) => s.references)) {
    const text = lines(r.file)[r.line - 1];
    if (text !== undefined) refLines[`${r.file}:${r.line}`] = text;
  }
  return {
    block,
    stepHashes: Object.fromEntries(steps.map((s) => [s.id, hashLines(lines(s.code_ref.file).slice(s.code_ref.start - 1, s.code_ref.end))])),
    fileHashes: Object.fromEntries(citedFiles.map((f) => [f, files.hash(f) ?? ''])),
    refLines,
    generatedAt: new Date().toISOString(),
    model: options.model,
    depth: options.depth,
    walkthrough,
  };
}
```

Add `import type { FnWalkthrough } from './fn.js';` and import `BlockRef` from `./saved.js`. In `reuseSection`, replace the inline note construction with `droppedNote(dropped)`. Then export the note helper and `findLine` (change `function findLine` to `export function findLine`):

```ts
/** The note added when reuse drops references whose code changed. */
export function droppedNote(dropped: string[]): string[] {
  return dropped.length
    ? [`${dropped.length} reference${dropped.length === 1 ? '' : 's'} dropped because the code ${dropped.length === 1 ? 'it' : 'they'} pointed to changed: ${dropped.join(', ')}`]
    : [];
}
```

Run: `pnpm vitest run core/src/walkthrough`
Expected: the existing section/file tests still pass (no behaviour change). The new test still fails.

- [ ] **Step 4: Add the endpoint section functions**

Append to `core/src/walkthrough/endpoint.ts` (adding imports: `type CodeBlock` from `../context/fn.js`, `endpointDiagram` from `../render/mermaid.js`, `type Reference` from `../llm/schema.js`, `droppedNote`, `findLine`, `recordSection` from `./section.js`, `hashLines`, `type BlockRef`, `type EndpointOverview`, `type Section`, `type SourceFiles` from `./saved.js`, and `type EndpointNode` from `../context/endpoint.js`):

```ts
/** The blocks an endpoint walkthrough explains: the handler first, then chain, error handlers, callees, registrations. */
export function endpointBlocks(ctx: EndpointContext): BlockRef[] {
  const blocks = new Map<string, BlockRef>();
  const add = (symbol: string | null, code: CodeBlock | null) => {
    if (!code) return;
    const key = `${code.file}:${code.start}-${code.end}`;
    if (!blocks.has(key)) blocks.set(key, { file: code.file, symbol, start: code.start, end: code.end, hash: hashLines(code.lines) });
  };
  const handler = ctx.chain.at(-1)!;
  add(handler.symbol?.name ?? null, handler.code);
  for (const n of [...ctx.chain, ...ctx.errorHandlers]) add(n.symbol?.name ?? null, n.code);
  for (const c of ctx.callees) add(c.callee?.name ?? null, c.code);
  // Registration lines aren't a symbol: they are pinned to their range.
  for (const r of ctx.registrations) add(null, r);
  return [...blocks.values()];
}

export async function generateEndpointSection(
  provider: LlmProvider,
  ctx: EndpointContext,
  repoRoot: string,
  options: { model: string; depth: number },
): Promise<Section> {
  const walkthrough = await explainEndpoint(provider, ctx, repoRoot);
  const blocks = endpointBlocks(ctx);
  return { ...recordSection(walkthrough, blocks[0], Object.keys(ctx.files), repoRoot, options), blocks, chainHash: ctx.chainHash };
}

/**
 * The saved endpoint section moved to where its blocks are now, or null when it must be regenerated:
 * the chain or --depth changed, a block was added, removed or edited, or a step cites code outside every
 * block. Steps and references move with their block; other references follow reuseSection's rules.
 */
export function reuseEndpointSection(prev: Section, current: { blocks: BlockRef[]; chainHash: string }, files: SourceFiles, depth: number): Section | null {
  if (!prev.blocks || prev.depth !== depth || prev.chainHash !== current.chainHash || prev.blocks.length !== current.blocks.length) return null;
  const moved: { from: BlockRef; to: BlockRef }[] = [];
  for (const from of prev.blocks) {
    const to = current.blocks.find((c) => c.file === from.file && c.symbol === from.symbol && c.hash === from.hash && (from.symbol !== null || c.start === from.start));
    if (!to) return null;
    moved.push({ from, to });
  }
  const ownerOf = (file: string, start: number, end: number) => moved.find(({ from }) => from.file === file && start >= from.start && end <= from.end);
  const w = prev.walkthrough;
  if (w.stages.some((s) => s.steps.some((st) => !ownerOf(st.code_ref.file, st.code_ref.start, st.code_ref.end)))) return null;

  const dropped: string[] = [];
  const refLines: Record<string, string> = {};
  const relocate = (r: Reference): Reference[] => {
    const owner = ownerOf(r.file, r.line, r.line);
    const text = prev.refLines[`${r.file}:${r.line}`];
    const line = owner
      ? r.line + owner.to.start - owner.from.start
      : files.hash(r.file) === prev.fileHashes[r.file]
        ? r.line
        : findLine(files.lines(r.file), text, r.line);
    if (line === null) {
      dropped.push(`${r.file}:${r.line}`);
      return [];
    }
    if (text !== undefined) refLines[`${r.file}:${line}`] = text;
    return [{ ...r, line }];
  };

  const stages = w.stages.map((stage) => ({
    ...stage,
    steps: stage.steps.map((step) => {
      const owner = ownerOf(step.code_ref.file, step.code_ref.start, step.code_ref.end)!;
      const delta = owner.to.start - owner.from.start;
      return { ...step, code_ref: { ...step.code_ref, start: step.code_ref.start + delta, end: step.code_ref.end + delta }, references: step.references.flatMap(relocate) };
    }),
  }));
  const head = moved[0];
  const headDelta = head.to.start - head.from.start;
  return {
    ...prev,
    block: head.to,
    blocks: moved.map((m) => m.to),
    fileHashes: Object.fromEntries(Object.keys(prev.fileHashes).map((f) => [f, files.hash(f) ?? ''])),
    refLines,
    walkthrough: {
      ...w,
      scope: { ...w.scope, start: w.scope.start + headDelta, end: w.scope.end + headDelta },
      stages,
      unresolved: [...w.unresolved, ...droppedNote(dropped)],
    },
  };
}

export function endpointOverviewOf(ctx: EndpointContext): EndpointOverview {
  const at = (n: EndpointNode) => (n.symbol ? `${n.symbol.file}:${n.symbol.startLine}` : `${n.registeredAt.file}:${n.registeredAt.line}`);
  const node = (n: EndpointNode) => ({ phase: n.phase, label: n.label, at: at(n) });
  return {
    method: ctx.route.method,
    path: ctx.route.fullPath,
    mounts: ctx.route.mounts.map((m) => ({ file: m.file, line: m.line, prefix: m.prefix })),
    chain: ctx.chain.map(node),
    errorHandlers: ctx.errorHandlers.map(node),
    sideEffects: ctx.sideEffects.map((e) => ({ symbol: e.symbol.name, kind: e.kind, detail: e.detail, at: `${e.symbol.file}:${e.line}` })),
    errorPaths: ctx.errorPaths.map((p) => ({ symbol: p.symbol.name, error: p.error, status: p.status, at: `${p.symbol.file}:${p.line}` })),
    warnings: ctx.warnings,
    diagram: endpointDiagram(ctx),
  };
}
```

- [ ] **Step 5: Multi-block staleness in `staleness.ts`**

In `core/src/walkthrough/staleness.ts`:

1. Extend the status types:

```ts
export interface SectionStatus {
  symbol: string | null;
  file: string;
  state: SectionState;
  current: { start: number; end: number } | null;
  steps: StepStatus[];
  /** Endpoint sections: blocks whose code changed or is gone, by symbol (or file:line for registrations). */
  changedBlocks?: string[];
}
```

and add to `WalkthroughStatus`:

```ts
  /** Endpoint walkthroughs only: the route's middleware chain resolves differently now. */
  chainChanged: boolean;
  /** Endpoint walkthroughs only: the route is no longer in the index. */
  routeRemoved: boolean;
```

2. At the top of `checkSection`, add `if (section.blocks) return checkBlocks(section, section.blocks, source);`, then add:

```ts
/** An endpoint section: fresh when every block is unchanged; each step is judged within the block that holds it. */
function checkBlocks(section: Section, blocks: BlockRef[], source: CurrentSource): SectionStatus {
  const steps = section.walkthrough.stages.flatMap((s) => s.steps);
  const located = blocks.map((b) => {
    const file = source(b.file);
    const at = file && locateBlock(b, file);
    const same = Boolean(file && at && hashLines(file.lines.slice(at.start - 1, at.end)) === b.hash);
    return { b, file, at, same };
  });
  const base = { symbol: section.block.symbol, file: section.block.file };
  const changedBlocks = located.filter((l) => !l.same).map((l) => l.b.symbol ?? `${l.b.file}:${l.b.start}`);
  const head = located[0];
  if (!head?.file || !head.at) {
    return { ...base, state: 'missing', current: null, steps: steps.map((s) => stepAt(s, false, s.code_ref.start)), changedBlocks };
  }
  const status = steps.map((s) => {
    const owner = located.find(({ b }) => b.file === s.code_ref.file && s.code_ref.start >= b.start && s.code_ref.end <= b.end);
    if (!owner?.file || !owner.at) return stepAt(s, false, s.code_ref.start);
    const expected = s.code_ref.start + owner.at.start - owner.b.start;
    return owner.same ? stepAt(s, true, expected) : findStep(s, section.stepHashes[s.id], owner.file.lines, owner.at, expected);
  });
  const fresh = changedBlocks.length === 0 && status.every((s) => s.fresh);
  return { ...base, state: fresh ? 'fresh' : 'changed', current: head.at, steps: status, changedBlocks };
}
```

3. Give `checkWalkthrough` a chain lookup:

```ts
/**
 * `chains` gives the current chain hash of an endpoint scope (null: route gone). Without it, endpoint
 * walkthroughs are judged by their code alone.
 */
export function checkWalkthrough(saved: SavedWalkthrough, source: CurrentSource, chains?: (scopeRef: string) => string | null | undefined): WalkthroughStatus {
  const sections = saved.sections.map((s) => checkSection(s, source));
  let uncovered: string[] = [];
  let fileRemoved = false;
  if (saved.scopeKind === 'file') {
    const file = source(saved.scopeRef);
    const covered = new Set(saved.sections.map((s) => s.block.symbol));
    uncovered = file ? walkableSymbols(file.symbols).map((s) => s.name).filter((name) => !covered.has(name)) : [];
    fileRemoved = file === null;
  }
  const chain = saved.scopeKind === 'endpoint' && chains ? chains(saved.scopeRef) : undefined;
  const routeRemoved = chain === null;
  const chainChanged = typeof chain === 'string' && chain !== saved.sections[0]?.chainHash;
  const steps = sections.flatMap((s) => s.steps);
  return {
    fresh: sections.every((s) => s.state === 'fresh') && uncovered.length === 0 && !fileRemoved && !chainChanged && !routeRemoved,
    sections,
    uncovered,
    fileRemoved,
    chainChanged,
    routeRemoved,
    staleSteps: steps.filter((s) => !s.fresh).length,
    totalSteps: steps.length,
  };
}
```

4. Include every block's file in `filesOf`:

```ts
export function filesOf(saved: SavedWalkthrough): string[] {
  return [...new Set([...saved.sections.flatMap((s) => (s.blocks ?? [s.block]).map((b) => b.file)), ...(saved.scopeKind === 'file' ? [saved.scopeRef] : [])])];
}
```

Import `type BlockRef` and `type Section` from `./saved.js` if they aren't already imported.

- [ ] **Step 6: Endpoint Markdown**

In `core/src/render/markdown.ts`, import `endpointNotes`, and replace the `if (saved.scopeKind === 'fn') { ... } else { ... }` block with:

```ts
  if (saved.scopeKind === 'fn') {
    const w = saved.sections[0].walkthrough;
    out.push(`# ${w.title}`, '', `\`${location(w)}\``, '', w.summary);
    renderStages(out, w, 2, codeLines);
  } else if (saved.scopeKind === 'endpoint') {
    const w = saved.sections[0].walkthrough;
    const e = saved.endpoint!;
    out.push(`# ${w.title}`, '', `\`${e.method} ${e.path}\``, '', w.summary, '', '## Route', '', ...endpointNotes(e).map((n) => `- ${n}`));
    out.push('', '## Sequence', '', '```mermaid', e.diagram, '```');
    renderStages(out, w, 2, codeLines);
  } else {
    /* unchanged file branch */
  }
```

- [ ] **Step 7: Export**

In `core/src/walkthrough/index.ts` add:

```ts
export { endpointBlocks, endpointOverviewOf, explainEndpoint, generateEndpointSection, reuseEndpointSection } from './endpoint.js';
```

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run core/src/walkthrough core/src/render`
Expected: PASS. The existing fn/file staleness tests are unaffected, because their sections have no `blocks`.

- [ ] **Step 9: Checkpoint (don't commit)**

Run: `pnpm test`. Expected: everything passes.

---

### Task 12: CLI `walk endpoint`, `walk list` and formatters

**Files:**
- Create: `cli/src/commands/endpoint.ts`
- Modify: `cli/src/index.ts`, `cli/src/commands/list.ts`, `cli/src/ui/format.ts`, `cli/src/ui/output.ts`, `cli/src/ui/format.test.ts`
- Test: `cli/src/commands/endpoint.test.ts`

**Interfaces:**
- Consumes: everything exported in Tasks 7-11 through `@codewalk/core`.
- Produces:
  - `runEndpoint(cwd, targetArg, options: EndpointOptions, io, deps?): Promise<number>`
  - `EndpointOptions { llm; depth; out; refresh }`
  - `formatEndpointFacts(ctx): string`

- [ ] **Step 1: Write the failing test**

Create `cli/src/commands/endpoint.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, openStore, type LlmProvider } from '@codewalk/core';
import { runEndpoint, type EndpointOptions } from './endpoint.js';
import { runList } from './list.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../../../core/src/llm/__fixtures__/enrollEndpoint.response.json', import.meta.url), 'utf8');
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
const opts = (o: Partial<EndpointOptions> = {}): EndpointOptions => ({ llm: true, depth: 3, out: 'terminal', refresh: false, ...o });

describe('walk endpoint', () => {
  let repo: string;
  let schema: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-endpoint-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_epcli_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  });

  afterAll(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('--no-llm prints the route, chain, side effects, error paths and diagram (Phase 3 acceptance)', async () => {
    const { io, out } = captureIO();
    expect(await runEndpoint(repo, TARGET, opts({ llm: false }), io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('endpoint POST /api/patients/enroll');
    expect(text).toContain('/api  api/app.ts:10');
    expect(text).toContain('/patients  api/routes/index.ts:6');
    expect(text).toContain('1. express.json() [app]  api/app.ts:9');
    expect(text).toContain('2. requireAuth [router]  api/middleware/auth.ts:10');
    expect(text).toContain('4. validate.validateBody [route]  api/middleware/validate.ts:6');
    expect(text).toContain('5. enrollHandler [handler]  api/controllers/patientsController.ts:7');
    expect(text).toContain('db_write INSERT consents  (insertConsent api/repositories/patientRepository.ts:46)');
    expect(text).toContain('ConflictError → 409');
    expect(text).toContain('sequenceDiagram');
  });

  it('reports unknown routes with the closest matches', async () => {
    const { io, err } = captureIO();
    expect(await runEndpoint(repo, 'POST /api/patient/enroll', opts({ llm: false }), io)).toBe(1);
    expect(err.join('\n')).toMatch(/No route matches POST \/api\/patient\/enroll\. Closest: POST \/api\/patients\/enroll/);
  });

  it('explains, saves, and reuses the saved walkthrough while the code is unchanged', async () => {
    const first = captureIO();
    expect(await runEndpoint(repo, TARGET, opts(), first.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(first.out.join('\n')).toContain('How POST /api/patients/enroll works');
    expect(first.err.join('\n')).toContain('Saved .walkthrough/walkthroughs/endpoint--');

    const second = captureIO();
    expect(await runEndpoint(repo, TARGET, opts({ out: 'md' }), second.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(second.err.join('\n')).toContain('Code unchanged');
    expect(second.out.join('\n')).toContain('```mermaid');
  });

  it('walk list marks the endpoint stale after a callee changes, and the next run regenerates', async () => {
    const path = join(repo, 'api/repositories/patientRepository.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('VALUES ($1, $2, now())', 'VALUES ($1, $2, NOW())'));

    const list = captureIO();
    expect(await runList(repo, { out: 'terminal' }, list.io)).toBe(0);
    expect(list.out.join('\n')).toMatch(/stale {2}endpoint {2}POST \/api\/patients\/enroll .*changed: insertConsent/);

    expect(await runEndpoint(repo, TARGET, opts(), captureIO().io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(2);
  });
});
```

Run: `pnpm vitest run cli/src/commands/endpoint.test.ts`
Expected: FAIL. `./endpoint.js` doesn't exist.

- [ ] **Step 2: Implement the command**

Create `cli/src/commands/endpoint.ts`:

```ts
import {
  AnthropicProvider,
  buildEndpointContext,
  endpointBlocks,
  endpointOverviewOf,
  generateEndpointSection,
  indexRepo,
  loadSavedWalkthrough,
  parseEndpointTarget,
  persistWalkthrough,
  reuseEndpointSection,
  SAVED_VERSION,
  sourceFiles,
  type LlmProvider,
  type SavedWalkthrough,
} from '@codewalk/core';
import { formatEndpointFacts } from '../ui/format.js';
import { printWalkthrough, type OutFormat } from '../ui/output.js';
import { connectStore, loadRepo, reportError, type IO } from './shared.js';

export interface EndpointOptions {
  /** False with --no-llm: print only the static facts. */
  llm: boolean;
  depth: number;
  out: OutFormat;
  /** Ignore the saved walkthrough and regenerate (--refresh). */
  refresh: boolean;
}

export interface EndpointDeps {
  /** Overrides the configured Anthropic provider (tests use recorded responses). */
  provider?: LlmProvider;
  /** Use the Ink stepper; defaults to true when stdin and stdout are terminals. */
  interactive?: boolean;
}

/** `walk endpoint "<METHOD> <path>"`. Returns an exit code. */
export async function runEndpoint(cwd: string, targetArg: string, options: EndpointOptions, io: IO, deps: EndpointDeps = {}): Promise<number> {
  let target;
  try {
    target = parseEndpointTarget(targetArg);
  } catch (err) {
    return reportError(err, io);
  }

  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;

  let saved: SavedWalkthrough;
  try {
    // Facts first: bring the index (and the stitched routes) up to date.
    await store.migrate();
    await indexRepo(repo.repoRoot, repo.config, store);

    const ctx = await buildEndpointContext(store, repo.repoRoot, target, {
      depth: options.depth,
      maxContextTokens: repo.config.llm.maxContextTokens,
    });
    for (const warning of ctx.warnings) io.error(`! ${warning}`);

    if (!options.llm) {
      io.log(options.out === 'json' ? JSON.stringify(ctx, null, 2) : formatEndpointFacts(ctx));
      return 0;
    }

    // Cached by the content of every explained block and the chain (CLAUDE.md §9).
    const previous = options.refresh ? null : await loadSavedWalkthrough(store, 'endpoint', ctx.scopeRef);
    const current = { blocks: endpointBlocks(ctx), chainHash: ctx.chainHash };
    let section = previous && reuseEndpointSection(previous.sections[0], current, sourceFiles(repo.repoRoot), options.depth);
    if (section) {
      io.error(`Code unchanged since ${section.generatedAt}: showing the saved walkthrough (--refresh to regenerate).`);
    } else {
      io.error(`Explaining ${ctx.scopeRef} with ${repo.config.llm.model}…`);
      const provider = deps.provider ?? new AnthropicProvider(repo.config.llm.model);
      section = await generateEndpointSection(provider, ctx, repo.repoRoot, { model: repo.config.llm.model, depth: options.depth });
    }
    saved = { version: SAVED_VERSION, scopeKind: 'endpoint', scopeRef: ctx.scopeRef, overview: null, endpoint: endpointOverviewOf(ctx), sections: [section] };
    const paths = await persistWalkthrough(store, repo.repoRoot, saved);
    io.error(`Saved ${paths.markdown}`);
  } catch (err) {
    return reportError(err, io);
  } finally {
    await store.close();
  }

  await printWalkthrough(saved, options.out, repo.repoRoot, io, deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  return 0;
}
```

- [ ] **Step 3: Formatters and output**

In `cli/src/ui/format.ts`:

1. Add `EndpointContext`, `EndpointNode` to the type import, and import the value `endpointDiagram` from `@codewalk/core`.

2. Add:

```ts
export function formatEndpointFacts(ctx: EndpointContext): string {
  const out = [`endpoint ${ctx.route.method} ${ctx.route.fullPath}`];
  section(out, 'Mounted through', ctx.route.mounts.map((m) => `${m.prefix}  ${m.file}:${m.line}`));
  section(out, 'Middleware chain', ctx.chain.map((n, i) => `${i + 1}. ${n.label} [${n.phase}]  ${nodeAt(n)}`));
  section(out, 'Error handlers', ctx.errorHandlers.map((n) => `${n.label}  ${nodeAt(n)}`));
  section(out, 'Side effects', ctx.sideEffects.map((e) => `${e.kind} ${e.detail}  (${e.symbol.name} ${e.symbol.file}:${e.line})`));
  section(out, 'Error paths', ctx.errorPaths.map((p) => `${p.error}${p.status !== null ? ` → ${p.status}` : ''}  (${p.symbol.name} ${p.symbol.file}:${p.line})`));
  section(
    out,
    'Calls',
    ctx.callees.map((c) => {
      const target = c.callee ? `${c.callee.name}  ${c.callee.file}:${c.callee.startLine}` : `${c.calleeText}  ${c.resolved ? '(package / built-in)' : '(unresolved)'}`;
      return `${'  '.repeat(c.depth - 1)}${c.caller.name} → ${target}`;
    }),
  );
  section(out, 'Unresolved', ctx.unresolved.map((u) => u.note));
  section(out, 'Omitted (context budget)', ctx.omitted);
  section(out, 'Warnings', ctx.warnings);
  section(out, 'Sequence diagram (Mermaid)', endpointDiagram(ctx).split('\n'));
  return out.join('\n');
}

function nodeAt(n: EndpointNode): string {
  return n.symbol ? `${n.symbol.file}:${n.symbol.startLine}` : `${n.registeredAt.file}:${n.registeredAt.line}`;
}
```

3. In `formatList`, size the kind column to its widest value (fn/file rows look exactly as before):

```ts
  const kindWidth = Math.max(...rows.map((r) => r.scopeKind.length));
```

and use `r.scopeKind.padEnd(kindWidth)` in place of `r.scopeKind.padEnd(4)`.

4. In `staleDetail`, name the changed blocks and report the chain:

```ts
function staleDetail(s: WalkthroughStatus): string {
  const label = (x: WalkthroughStatus['sections'][number]) => x.symbol ?? `${x.file} lines`;
  const changed = s.sections.filter((x) => x.state === 'changed').flatMap((x) => (x.changedBlocks?.length ? x.changedBlocks : [label(x)]));
  const removed = s.sections.filter((x) => x.state === 'missing').map(label);
  const parts = [`${s.staleSteps}/${s.totalSteps} steps stale`];
  if (s.fileRemoved) parts.push('file removed');
  if (s.routeRemoved) parts.push('route removed');
  if (s.chainChanged) parts.push('middleware chain changed');
  if (changed.length) parts.push(`changed: ${changed.join(', ')}`);
  if (removed.length) parts.push(`removed: ${removed.join(', ')}`);
  if (s.uncovered.length) parts.push(`not covered: ${s.uncovered.join(', ')}`);
  return parts.join(' · ');
}
```

In `cli/src/ui/format.test.ts`, add `chainChanged: false, routeRemoved: false,` to the default status object in `row()`.

In `cli/src/ui/output.ts`, import `endpointNotes`, and:

```ts
  const notes = saved.overview ? overviewNotes(saved.overview) : saved.endpoint ? endpointNotes(saved.endpoint) : [];
  if (out === 'json') {
    io.log(JSON.stringify({ ...walkthrough, overview: saved.overview, endpoint: saved.endpoint ?? null }, null, 2));
```

- [ ] **Step 4: `walk list` checks endpoint chains**

In `cli/src/commands/list.ts`, import `currentChainHash` from `@codewalk/core`, and replace the `rows = entries.map(...)` statement with:

```ts
    const chains = new Map<string, string | null>();
    for (const { saved } of entries) {
      if (saved.scopeKind === 'endpoint') chains.set(saved.scopeRef, await currentChainHash(store, saved.scopeRef));
    }
    rows = entries.map(({ saved, savedAt }) => ({
      scopeKind: saved.scopeKind,
      scopeRef: saved.scopeRef,
      savedAt,
      status: checkWalkthrough(saved, source, (ref) => chains.get(ref)),
    }));
```

Update the empty-list message in `formatList` to: `'No saved walkthroughs yet. Run `walk fn`, `walk file` or `walk endpoint` to create one.'`.

- [ ] **Step 5: Register the command**

In `cli/src/index.ts`, import `runEndpoint` and `type EndpointOptions` from `./commands/endpoint.js`, and add after the `file` command:

```ts
program
  .command('endpoint')
  .description('walkthrough of a backend endpoint: mounts, middleware chain, handler, side effects')
  .argument('<route>', 'e.g. "POST /api/patients/enroll" (a concrete path like "GET /api/patients/42" also works)')
  .option('--no-llm', 'print only the static facts')
  .option('--depth <n>', 'how many levels of calls below the handler and middleware to include', parseDepth, 3)
  .option('--refresh', 'ignore the saved walkthrough and regenerate', false)
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json', 'md']).default('terminal'))
  .action(async (route: string, opts: EndpointOptions) => {
    process.exitCode = await runEndpoint(process.cwd(), route, opts, io);
  });
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run cli`
Expected: PASS.

- [ ] **Step 7: Full verification**

Run: `pnpm test`
Expected: all test files pass (the 20 baseline files plus the new ones).

Run: `pnpm typecheck`
Expected: no errors. Fix any type error at its source; don't use `any` or casts to silence it.

Run the acceptance check by hand on a scratch copy of the fixture:

```bash
rm -rf /tmp/cw-p3 && cp -R fixture /tmp/cw-p3 && cd /tmp/cw-p3 && pnpm --dir ~/dev/projects/codewalk --filter @codewalk/core build && node ~/dev/projects/codewalk/cli/dist/index.js endpoint "POST /api/patients/enroll" --no-llm
```

(Build the CLI first with `pnpm build` from the repo root if `cli/dist` is missing.)
Expected output:
- the mounts `/api  api/app.ts:10` and `/patients  api/routes/index.ts:6`
- the chain `express.json()` → `requireAuth` → `rateLimit` → `validate.validateBody` → `enrollHandler`
- `errorHandler` as the error handler
- the tagged side effects, and a Mermaid diagram

- [ ] **Step 8: Stop for review (don't commit)**

Report to the user: the test counts, the `--no-llm` output for `POST /api/patients/enroll`, and anything that deviated from this plan. Wait for review before Phase 4.
