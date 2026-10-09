# Phase 2: `walk file` + Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `walk file` (dependency-ordered, per-function walkthroughs of a whole file), save every walkthrough to Postgres + `.walkthrough/walkthroughs/` as JSON and Markdown, judge staleness by content hash down to individual steps, and add `walk list`.

**Architecture:** A saved walkthrough is a list of **sections**, one per explained code block: `walk fn` saves one section, `walk file` saves one per top-level function (in helpers-first order). Each section stores a position-independent hash of its block and of every step's lines. Staleness relocates the block by symbol name, compares hashes, and searches for each step's exact lines, so editing one function marks only that function's changed steps stale. Unchanged sections are reused (line numbers shifted) and only changed sections go back to the LLM.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), ts-morph (already indexed), `pg` + `node-pg-migrate`, zod, commander, Ink, vitest.

**Spec:** `CLAUDE.md` §6.2 (file mode), §8.1 (`walkthroughs` table), §8.1a (store interface, staleness), §9 (caching and staleness), §12 Phase 2.

## Design decisions (confirm in review)

1. **One LLM call per function.** `walk file` runs the existing `walk fn` pipeline per function with a "condensed" prompt instruction. Each function's result is cached as its own section, which is what makes "regenerate only the affected parts" possible.
2. **Staleness is per step; regeneration is per section.** A step stays fresh when its exact lines still appear in its function. A changed function is regenerated whole: its worked example threads one input through every step, so a single step can't be regenerated on its own.
3. **Only the explained code counts.** A walkthrough goes stale when the code it explains changes. It doesn't go stale when a callee in another file changes. When a section is reused, references into files that changed since generation are dropped rather than shown at a possibly wrong line.
4. **Postgres is the source of truth.** The `walkthroughs` table backs caching and `walk list`. `.walkthrough/walkthroughs/<slug>.json` and `.md` mirror it on every save, for reading and sharing.
5. **`walk fn` caches too.** It reuses the saved walkthrough when the code is unchanged. `--refresh` forces regeneration.
6. **File overview is static facts only.** Role (importers), export map, helpers and walk order come from the index with no LLM summary.

## Global Constraints

- Node `>=24` (root `package.json` `engines`), pnpm workspaces, vitest, tsup. TypeScript 7 builds `.d.ts` with `tsc --emitDeclarationOnly`.
- Nothing outside `core/src/store` writes SQL (§8.1a).
- Database tests run against the real compose Postgres, each in its own `cw_test_<random>` schema that is dropped afterwards (§14). Never mock the DB.
- LLM calls are mocked in tests (recorded fixtures or the line stub from Task 3) (§14).
- Docs URLs are never produced by the LLM (§8.4). Unchanged by this phase.
- Unresolved or uncertain facts are surfaced, never guessed silently (§8.1).
- **Do not commit** (CLAUDE.md §15). Where a skill template says "Commit", stop and leave changes in the working tree.
- Don't add Phase 3+ features (routes, side effects, components). If something seems needed, note it and ask.
- Baseline before starting: `pnpm test` → 10 files, 77 tests passing (Postgres up via `pnpm db:up`).

## Review Focus

1. **Editing a function above another one** shifts the lower function's lines. The lower function must stay *fresh*, be reused without an LLM call, and show its steps at the *new* line numbers. Tested in Task 3 (`reuseSection`), Task 4 (staleness), Task 5 (`explainFile`) and Task 9 (acceptance).
2. **A saved walkthrough whose file was deleted or whose function was renamed** must show as stale (`removed: …`) in `walk list` without crashing. Tested in Task 4.
3. **The LLM failing partway through a multi-function file** (rate limit, auth) must keep the finished sections, save them, report what was skipped and exit 1. The next run must generate only the missing functions. Tested in Task 5.
4. **A file with no functions** (types only, e.g. `fixture/web/types.ts`) must print its overview, make no LLM call and exit 0. Tested in Tasks 5 and 8.
5. **Functions that call each other** (mutual recursion) must still get a terminating order, with the cycle noted. Tested in Task 2.

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `core/src/store/migrations/1791900000000_walkthroughs-unique-scope.ts` | create | one saved walkthrough per `(scope_kind, scope_ref)` |
| `core/src/store/types.ts` | modify | `ImporterRecord`, `CallEdge`, `WalkthroughRecord` |
| `core/src/store/store.ts` | modify | `getImportersOf`, `getCallEdgesInFile`, `saveWalkthrough`, `getWalkthrough`, `listWalkthroughs` |
| `core/src/context/order.ts` | create | `walkableSymbols`, `dependencyOrder` (pure) |
| `core/src/context/target.ts` | modify | `parseFileTarget` |
| `core/src/context/file.ts` | create | `buildFileContext` (static facts for `walk file`) |
| `core/src/context/index.ts` | modify | exports |
| `core/src/llm/prompt.ts`, `generate.ts` | modify | `condensed` prompt option |
| `core/src/llm/stub.ts` | create | `createLineStubProvider` (deterministic offline provider for tests) |
| `core/src/llm/index.ts` | modify | exports |
| `core/src/walkthrough/fn.ts` | modify | pass prompt options through `explainFn` |
| `core/src/walkthrough/saved.ts` | create | saved-walkthrough types, hashing, `flattenWalkthrough`, `overviewNotes`, `fnScopeRef` |
| `core/src/walkthrough/section.ts` | create | `generateSection`, `reuseSection` |
| `core/src/walkthrough/staleness.ts` | create | `locateBlock`, `checkSection`, `checkWalkthrough`, `loadCurrentSource`, `filesOf` |
| `core/src/walkthrough/file.ts` | create | `explainFile` (per-function generate/reuse loop) |
| `core/src/walkthrough/persist.ts` | create | `persistWalkthrough`, `loadSavedWalkthrough`, `listSavedWalkthroughs`, `codeReader` |
| `core/src/walkthrough/index.ts` | create | exports |
| `core/src/walkthrough/__fixtures__/sections.ts` | create | test helpers to build sections from text |
| `core/src/render/markdown.ts` | create | `renderMarkdown` |
| `core/src/index.ts` | modify | exports |
| `cli/src/commands/shared.ts` | modify | `reportError` (moved from `fn.ts`) |
| `cli/src/commands/fn.ts` | modify | cache/reuse, save, `--out md`, `--refresh` |
| `cli/src/commands/file.ts` | create | `walk file` |
| `cli/src/commands/list.ts` | create | `walk list` |
| `cli/src/ui/format.ts` | modify | `notes` in `formatWalkthrough`, `formatFileFacts`, `formatList` |
| `cli/src/ui/Stepper.tsx` | modify | optional overview `notes` |
| `cli/src/index.ts` | modify | register `file`, `list`, new `fn` flags |
| tests | create/modify | listed per task |

---

### Task 1: Store support for saved walkthroughs and file-level facts

**Files:**
- Create: `core/src/store/migrations/1791900000000_walkthroughs-unique-scope.ts`
- Modify: `core/src/store/types.ts` (append), `core/src/store/store.ts` (new methods inside `class Store`, new constant below `SELECT_SYMBOL`)
- Test: `core/src/store/store.test.ts` (append inside the existing `describe('store')`)

**Interfaces:**
- Consumes: existing `Store`, the `walkthroughs`, `imports` and `calls` tables.
- Produces:
  - `Store.getImportersOf(file: string): Promise<ImporterRecord[]>`
  - `Store.getCallEdgesInFile(file: string): Promise<CallEdge[]>`
  - `Store.saveWalkthrough(w: { scopeKind: string; scopeRef: string; contentHash: string; content: unknown }): Promise<void>` (upsert)
  - `Store.getWalkthrough(scopeKind: string, scopeRef: string): Promise<WalkthroughRecord | null>`
  - `Store.listWalkthroughs(): Promise<WalkthroughRecord[]>` (ordered by kind, ref)
  - `interface ImporterRecord { file: string; importedNames: string[] }`
  - `interface CallEdge { callerId: number; calleeId: number }`
  - `interface WalkthroughRecord { scopeKind: string; scopeRef: string; contentHash: string; content: unknown; createdAt: Date }`

- [ ] **Step 1: Write the failing tests**

Append inside `describe('store', () => { ... })` in `core/src/store/store.test.ts`, after the last `it`:

```ts
  it('lists the files importing a file, with the names they import', async () => {
    expect(await store.getImportersOf('api/service.ts')).toEqual([{ file: 'api/controller.ts', importedNames: ['enroll'] }]);
    expect(await store.getImportersOf('api/controller.ts')).toEqual([]);
  });

  it('returns resolved call edges within one file only', async () => {
    const names = new Map((await store.getSymbolsInFile('api/service.ts')).map((s) => [s.id, s.name]));
    const edges = (await store.getCallEdgesInFile('api/service.ts')).map((e) => `${names.get(e.callerId)}->${names.get(e.calleeId)}`);
    expect(edges.sort()).toEqual(['enroll->normalize', 'ping->pong', 'pong->ping']);
    // handle -> enroll crosses files, so the controller has no in-file edges.
    expect(await store.getCallEdgesInFile('api/controller.ts')).toEqual([]);
  });

  it('saves one walkthrough per scope and replaces it on re-save', async () => {
    expect(await store.getWalkthrough('fn', 'api/service.ts#enroll')).toBeNull();

    await store.saveWalkthrough({ scopeKind: 'fn', scopeRef: 'api/service.ts#enroll', contentHash: 'h1', content: { v: 1 } });
    await store.saveWalkthrough({ scopeKind: 'fn', scopeRef: 'api/service.ts#enroll', contentHash: 'h2', content: { v: 2 } });
    await store.saveWalkthrough({ scopeKind: 'file', scopeRef: 'api/service.ts', contentHash: 'h3', content: { v: 3 } });

    const saved = await store.getWalkthrough('fn', 'api/service.ts#enroll');
    expect(saved).toMatchObject({ scopeKind: 'fn', scopeRef: 'api/service.ts#enroll', contentHash: 'h2', content: { v: 2 } });
    expect(saved!.createdAt).toBeInstanceOf(Date);
    expect((await store.listWalkthroughs()).map((w) => `${w.scopeKind} ${w.scopeRef}`)).toEqual(['file api/service.ts', 'fn api/service.ts#enroll']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run core/src/store/store.test.ts`
Expected: FAIL with `store.getImportersOf is not a function` (and the same for the other new methods).

- [ ] **Step 3: Add the migration**

Create `core/src/store/migrations/1791900000000_walkthroughs-unique-scope.ts`:

```ts
import type { MigrationBuilder } from 'node-pg-migrate';

// One saved walkthrough per scope: `walk fn` and `walk file` upsert on (scope_kind, scope_ref).

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('walkthroughs', ['scope_kind', 'scope_ref']);
  pgm.createIndex('walkthroughs', ['scope_kind', 'scope_ref'], { unique: true });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('walkthroughs', ['scope_kind', 'scope_ref'], { unique: true });
  pgm.createIndex('walkthroughs', ['scope_kind', 'scope_ref']);
}
```

- [ ] **Step 4: Add the types**

Append to `core/src/store/types.ts`:

```ts
export interface ImporterRecord {
  /** Repo-relative file containing the import. */
  file: string;
  importedNames: string[];
}

/** A resolved call between two symbols. */
export interface CallEdge {
  callerId: number;
  calleeId: number;
}

export interface WalkthroughRecord {
  scopeKind: string;
  scopeRef: string;
  contentHash: string;
  /** The saved walkthrough as JSON; its shape belongs to core/src/walkthrough. */
  content: unknown;
  /** When it was last saved. */
  createdAt: Date;
}
```

- [ ] **Step 5: Add the store methods**

In `core/src/store/store.ts`, add `CallEdge`, `ImporterRecord` and `WalkthroughRecord` to the `import type { ... } from './types.js'` list. Add these methods inside `class Store`, after `getCallees`:

```ts
  /** Files importing `file`, with the names each imports. Feeds a file walkthrough's "who uses it". */
  async getImportersOf(file: string): Promise<ImporterRecord[]> {
    const { rows } = await this.pool.query<ImporterRecord>(
      `SELECT f.path AS file, i.imported_names AS "importedNames"
       FROM imports i JOIN files f ON f.id = i.file_id
       WHERE i.resolved_path = $1
       ORDER BY f.path, i.id`,
      [file],
    );
    return rows;
  }

  /** Resolved calls whose caller and callee both live in `file`, in one query for the whole file. */
  async getCallEdgesInFile(file: string): Promise<CallEdge[]> {
    const { rows } = await this.pool.query<{ caller_symbol_id: string; callee_symbol_id: string }>(
      `SELECT DISTINCT c.caller_symbol_id, c.callee_symbol_id
       FROM calls c
       JOIN symbols caller ON caller.id = c.caller_symbol_id
       JOIN symbols callee ON callee.id = c.callee_symbol_id
       JOIN files f ON f.id = caller.file_id
       WHERE f.path = $1 AND callee.file_id = caller.file_id
       ORDER BY 1, 2`,
      [file],
    );
    return rows.map((r) => ({ callerId: Number(r.caller_symbol_id), calleeId: Number(r.callee_symbol_id) }));
  }

  /** Inserts or replaces the saved walkthrough of one scope. */
  async saveWalkthrough(w: { scopeKind: string; scopeRef: string; contentHash: string; content: unknown }): Promise<void> {
    await this.pool.query(
      `INSERT INTO walkthroughs (scope_kind, scope_ref, content_hash, content)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (scope_kind, scope_ref)
       DO UPDATE SET content_hash = EXCLUDED.content_hash, content = EXCLUDED.content, created_at = now()`,
      [w.scopeKind, w.scopeRef, w.contentHash, JSON.stringify(w.content)],
    );
  }

  async getWalkthrough(scopeKind: string, scopeRef: string): Promise<WalkthroughRecord | null> {
    const { rows } = await this.pool.query<WalkthroughRecord>(
      `${SELECT_WALKTHROUGH} WHERE scope_kind = $1 AND scope_ref = $2`,
      [scopeKind, scopeRef],
    );
    return rows[0] ?? null;
  }

  async listWalkthroughs(): Promise<WalkthroughRecord[]> {
    const { rows } = await this.pool.query<WalkthroughRecord>(`${SELECT_WALKTHROUGH} ORDER BY scope_kind, scope_ref`);
    return rows;
  }
```

Below the existing `SELECT_SYMBOL` constant add:

```ts
const SELECT_WALKTHROUGH = `SELECT scope_kind AS "scopeKind", scope_ref AS "scopeRef", content_hash AS "contentHash",
  content, created_at AS "createdAt" FROM walkthroughs`;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run core/src/store/store.test.ts`
Expected: PASS (all existing store tests plus the three new ones).

---

### Task 2: Dependency order of a file's functions

**Files:**
- Create: `core/src/context/order.ts`
- Test: `core/src/context/order.test.ts`

**Interfaces:**
- Consumes: `SymbolRecord`, `CallEdge` (Task 1) from `core/src/store/types.ts`.
- Produces:
  - `walkableSymbols<T extends Pick<SymbolRecord, 'kind' | 'startLine' | 'endLine'>>(symbols: T[]): T[]`. Returns code symbols not nested in another code symbol, in source order. Types and classes are excluded, but class methods are kept.
  - `dependencyOrder<T extends Pick<SymbolRecord, 'id' | 'name' | 'startLine' | 'endLine'>>(walkable: T[], all: Pick<SymbolRecord, 'id' | 'startLine' | 'endLine'>[], edges: CallEdge[]): { order: T[]; cycleBreaks: string[] }`

- [ ] **Step 1: Write the failing tests**

Create `core/src/context/order.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SymbolKind } from '../store/types.js';
import { dependencyOrder, walkableSymbols } from './order.js';

let nextId = 1;
const sym = (name: string, startLine: number, endLine: number, kind: SymbolKind = 'function') => ({
  id: nextId++,
  name,
  kind,
  startLine,
  endLine,
});
const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe('walkableSymbols', () => {
  it('keeps top-level code symbols and class methods, skips types, classes and nested functions', () => {
    const symbols = [
      sym('Props', 1, 3, 'type'),
      sym('EnrollForm', 5, 20, 'component'),
      sym('EnrollForm.handleSubmit', 8, 12),
      sym('Repo', 22, 30, 'class'),
      sym('Repo.find', 23, 25, 'method'),
      sym('helper', 32, 34),
    ];
    expect(names(walkableSymbols(symbols))).toEqual(['EnrollForm', 'Repo.find', 'helper']);
  });
});

describe('dependencyOrder', () => {
  it('puts helpers before the functions that call them, even when declared below', () => {
    const main = sym('main', 1, 5);
    const helper = sym('helper', 7, 9);
    const { order, cycleBreaks } = dependencyOrder([main, helper], [main, helper], [{ callerId: main.id, calleeId: helper.id }]);
    expect(names(order)).toEqual(['helper', 'main']);
    expect(cycleBreaks).toEqual([]);
  });

  it('attributes calls made by nested functions to their walkable parent', () => {
    const form = sym('EnrollForm', 1, 20, 'component');
    const handler = sym('EnrollForm.handleSubmit', 5, 10);
    const submit = sym('submitHelper', 22, 25);
    const { order } = dependencyOrder([form, submit], [form, handler, submit], [{ callerId: handler.id, calleeId: submit.id }]);
    expect(names(order)).toEqual(['submitHelper', 'EnrollForm']);
  });

  it('keeps source order for unrelated functions', () => {
    const a = sym('a', 1, 2);
    const b = sym('b', 4, 5);
    expect(names(dependencyOrder([b, a], [a, b], []).order)).toEqual(['a', 'b']);
  });

  it('terminates on mutual recursion and notes where the cycle was broken', () => {
    const entry = sym('entry', 1, 3);
    const ping = sym('ping', 5, 7);
    const pong = sym('pong', 9, 11);
    const edges = [
      { callerId: entry.id, calleeId: ping.id },
      { callerId: ping.id, calleeId: pong.id },
      { callerId: pong.id, calleeId: ping.id },
    ];
    const { order, cycleBreaks } = dependencyOrder([entry, ping, pong], [entry, ping, pong], edges);
    expect(names(order)).toEqual(['ping', 'pong', 'entry']);
    expect(cycleBreaks).toEqual(['ping calls pong, which calls it back; walked in source order']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run core/src/context/order.test.ts`
Expected: FAIL with `Failed to load url ./order.js` (module does not exist).

- [ ] **Step 3: Implement**

Create `core/src/context/order.ts`:

```ts
import type { CallEdge, SymbolRecord } from '../store/types.js';

// The order `walk file` explains a file's functions in (CLAUDE.md §6.2): helpers first, entry
// points last. Pure functions over the index facts, so they are tested without a database.

type Span = Pick<SymbolRecord, 'kind' | 'startLine' | 'endLine'>;

const NOT_WALKED = new Set(['type', 'class']);

/**
 * The functions a file walkthrough explains: code symbols that aren't nested inside another code
 * symbol (nested ones, like a component's handlers, are covered by their parent), in source order.
 */
export function walkableSymbols<T extends Span>(symbols: T[]): T[] {
  const code = symbols.filter((s) => !NOT_WALKED.has(s.kind));
  const nested = (s: T) =>
    code.some(
      (o) => o !== s && o.startLine <= s.startLine && o.endLine >= s.endLine && (o.startLine < s.startLine || o.endLine > s.endLine),
    );
  return code.filter((s) => !nested(s)).sort((a, b) => a.startLine - b.startLine);
}

/**
 * Orders `walkable` so each function comes after every function it calls, ties in source order.
 * Calls made by nested symbols (anything in `all`) count for the walkable symbol containing them.
 * A call cycle is broken at its first function in source order, and noted in `cycleBreaks`.
 */
export function dependencyOrder<T extends Pick<SymbolRecord, 'id' | 'name' | 'startLine' | 'endLine'>>(
  walkable: T[],
  all: Pick<SymbolRecord, 'id' | 'startLine' | 'endLine'>[],
  edges: CallEdge[],
): { order: T[]; cycleBreaks: string[] } {
  const byId = new Map(all.map((s) => [s.id, s]));
  const ownerOf = (id: number): T | undefined => {
    const s = byId.get(id);
    return s && walkable.find((w) => w.startLine <= s.startLine && w.endLine >= s.endLine);
  };

  const callees = new Map<T, Set<T>>(walkable.map((w) => [w, new Set<T>()]));
  for (const e of edges) {
    const from = ownerOf(e.callerId);
    const to = ownerOf(e.calleeId);
    if (from && to && from !== to) callees.get(from)!.add(to);
  }

  const done = new Set<T>();
  const order: T[] = [];
  const cycleBreaks: string[] = [];
  const bySource = [...walkable].sort((a, b) => a.startLine - b.startLine);
  const waitingOn = (w: T) => [...callees.get(w)!].filter((c) => !done.has(c));
  const reaches = (from: T, target: T, seen: Set<T>): boolean => {
    if (from === target) return true;
    if (seen.has(from) || done.has(from)) return false;
    seen.add(from);
    return [...callees.get(from)!].some((c) => reaches(c, target, seen));
  };

  while (order.length < walkable.length) {
    const remaining = bySource.filter((w) => !done.has(w));
    let next = remaining.find((w) => waitingOn(w).length === 0);
    if (!next) {
      // Nothing is ready, so the remaining functions contain a cycle: start at its first member.
      next = remaining.find((w) => waitingOn(w).some((c) => reaches(c, w, new Set())))!;
      cycleBreaks.push(`${next.name} calls ${waitingOn(next).map((c) => c.name).join(', ')}, which calls it back; walked in source order`);
    }
    done.add(next);
    order.push(next);
  }
  return { order, cycleBreaks };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run core/src/context/order.test.ts`
Expected: PASS (5 tests).

---

### Task 3: Saved-walkthrough model, condensed prompt, line stub, section generate/reuse

**Files:**
- Create: `core/src/walkthrough/saved.ts`, `core/src/walkthrough/section.ts`, `core/src/llm/stub.ts`, `core/src/walkthrough/__fixtures__/sections.ts`
- Modify: `core/src/llm/prompt.ts`, `core/src/llm/generate.ts`, `core/src/walkthrough/fn.ts`, `core/src/llm/index.ts`
- Test: `core/src/walkthrough/section.test.ts`

**Interfaces:**
- Consumes: `explainFn`, `FnWalkthrough`, `WalkthroughStep` (`core/src/walkthrough/fn.ts`), `FnContext` (`core/src/context/fn.ts`), `FnTarget` (`core/src/context/target.ts`), `SymbolKind` (`core/src/store/types.ts`).
- Produces (in `core/src/walkthrough/saved.ts`):
  - `SAVED_VERSION = 1`, `type ScopeKind = 'fn' | 'file'`
  - `interface BlockRef { file; symbol: string | null; start; end; hash }`
  - `interface Section { block: BlockRef; stepHashes: Record<string, string>; fileHashes: Record<string, string>; generatedAt: string; walkthrough: FnWalkthrough }`
  - `interface SymbolSummary { name: string; kind: SymbolKind; line: number }`
  - `interface FileOverview { file; lineCount; importers: { file: string; importedNames: string[] }[]; exports: SymbolSummary[]; helpers: SymbolSummary[]; order: string[]; cycleBreaks: string[]; failed: { symbol: string; reason: string }[] }`
  - `interface SavedWalkthrough { version: 1; scopeKind: ScopeKind; scopeRef: string; model: string; overview: FileOverview | null; sections: Section[] }`
  - `splitLines(text): string[]`, `readLines(repoRoot, file): string[] | null`, `hashFile(repoRoot, file): string | null`, `hashLines(lines): string`, `contentHashOf(sections): string`
  - `fnScopeRef(target: FnTarget): string` returns `"file#name"` or `"file:start-end"`.
  - `flattenWalkthrough(saved): FnWalkthrough`, `overviewNotes(o: FileOverview): string[]`
- Produces (in `core/src/walkthrough/section.ts`):
  - `generateSection(provider: LlmProvider, ctx: FnContext, repoRoot: string, options: { symbol: string | null; condensed?: boolean }): Promise<Section>`
  - `reuseSection(prev: Section, current: { start: number; end: number; lines: string[] }, fileHash: (file: string) => string | null): Section | null`. Here `current.lines` holds only the block's lines.
- Produces (LLM):
  - `interface FnPromptOptions { condensed?: boolean }`, `renderFnPrompt(ctx, options?)`, `generateFnWalkthrough(provider, ctx, options?)`, `explainFn(provider, ctx, repoRoot, options?)`
  - `createLineStubProvider(): LineStubProvider` with `targets: string[]` (`"file:start-end"` per call) and `prompts: string[]`
- Produces (test helper, `core/src/walkthrough/__fixtures__/sections.ts`): `lineStep(id, file, line)`, `sectionFor(lines, file, symbol, start, end)`

- [ ] **Step 1: Write the test helpers**

Create `core/src/walkthrough/__fixtures__/sections.ts`:

```ts
import type { WalkthroughStep } from '../fn.js';
import { hashLines, type Section } from '../saved.js';

// Builds saved sections straight from source text, one step per line, for staleness and reuse tests.

export function lineStep(id: string, file: string, line: number): WalkthroughStep {
  return {
    id,
    code_ref: { file, start: line, end: line },
    explanation: `Line ${line}.`,
    example: { input: 'in', state_after: 'out' },
    references: [],
    docs: [],
    concepts: [],
    risks: [],
    docLinks: [],
  };
}

export function sectionFor(lines: string[], file: string, symbol: string | null, start: number, end: number): Section {
  const steps = Array.from({ length: end - start + 1 }, (_, i) => lineStep(`s${i + 1}`, file, start + i));
  return {
    block: { file, symbol, start, end, hash: hashLines(lines.slice(start - 1, end)) },
    stepHashes: Object.fromEntries(steps.map((s) => [s.id, hashLines(lines.slice(s.code_ref.start - 1, s.code_ref.end))])),
    fileHashes: { [file]: 'file-hash-at-generation' },
    generatedAt: '2026-10-09T00:00:00.000Z',
    walkthrough: {
      scope: { file, start, end, symbol },
      title: `Walkthrough of ${symbol}`,
      summary: 'Summary.',
      stages: [{ name: 'Body', steps }],
      unresolved: [],
      verification: { attempts: 1, keptSteps: steps.length, dropped: [], removedDocs: [] },
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

Create `core/src/walkthrough/section.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lineStep, sectionFor } from './__fixtures__/sections.js';
import { contentHashOf, flattenWalkthrough, fnScopeRef, hashLines, overviewNotes, SAVED_VERSION, type SavedWalkthrough } from './saved.js';
import { reuseSection } from './section.js';

const SOURCE = ['function helper() {', '  return 1;', '}', '', 'function main() {', '  const x = helper();', '  return x + 1;', '}'];

describe('hashLines', () => {
  it('depends only on the text, not on where it sits', () => {
    expect(hashLines(SOURCE.slice(4, 8))).toBe(hashLines(['', '', ...SOURCE].slice(6, 10)));
    expect(hashLines(['a'])).not.toBe(hashLines(['b']));
  });
});

describe('fnScopeRef', () => {
  it('names a symbol or a line range', () => {
    expect(fnScopeRef({ kind: 'symbol', file: 'a.ts', name: 'main' })).toBe('a.ts#main');
    expect(fnScopeRef({ kind: 'range', file: 'a.ts', start: 5, end: 8 })).toBe('a.ts:5-8');
  });
});

describe('reuseSection', () => {
  const unchangedFiles = (f: string) => ({ 'a.ts': 'a-now', 'b.ts': 'b-same', 'c.ts': 'c-now' })[f] ?? null;

  it('returns null when the block text changed', () => {
    const prev = sectionFor(SOURCE, 'a.ts', 'main', 5, 8);
    const edited = ['function main() {', '  const x = helper() * 2;', '  return x + 1;', '}'];
    expect(reuseSection(prev, { start: 5, end: 8, lines: edited }, unchangedFiles)).toBeNull();
  });

  it('moves steps and in-block references with the block, drops references into changed files', () => {
    const prev = sectionFor(SOURCE, 'a.ts', 'main', 5, 8);
    prev.fileHashes = { 'a.ts': 'a-then', 'b.ts': 'b-same', 'c.ts': 'c-then' };
    prev.walkthrough.stages[0].steps[1].references = [
      { file: 'a.ts', line: 6, role: 'callee' }, // inside the block: shifts
      { file: 'a.ts', line: 1, role: 'callee' }, // outside the block, a.ts changed: dropped
      { file: 'b.ts', line: 4, role: 'caller' }, // b.ts unchanged: kept
      { file: 'c.ts', line: 9, role: 'type' }, // c.ts changed: dropped
    ];

    const moved = reuseSection(prev, { start: 7, end: 10, lines: SOURCE.slice(4, 8) }, unchangedFiles)!;
    expect(moved.block).toMatchObject({ start: 7, end: 10, hash: prev.block.hash });
    expect(moved.walkthrough.scope).toMatchObject({ start: 7, end: 10 });
    expect(moved.walkthrough.stages[0].steps.map((s) => s.code_ref.start)).toEqual([7, 8, 9, 10]);
    expect(moved.walkthrough.stages[0].steps[1].references).toEqual([
      { file: 'a.ts', line: 8, role: 'callee' },
      { file: 'b.ts', line: 4, role: 'caller' },
    ]);
    expect(moved.fileHashes).toEqual({ 'a.ts': 'a-now', 'b.ts': 'b-same', 'c.ts': 'c-now' });
    expect(moved.stepHashes).toEqual(prev.stepHashes);
  });

  it('refuses a section with a step outside its block', () => {
    const prev = sectionFor(SOURCE, 'a.ts', 'main', 5, 8);
    prev.walkthrough.stages[0].steps.push(lineStep('s9', 'a.ts', 2));
    expect(reuseSection(prev, { start: 5, end: 8, lines: SOURCE.slice(4, 8) }, unchangedFiles)).toBeNull();
  });
});

describe('flattenWalkthrough', () => {
  it('turns a file walkthrough into one stepper walkthrough with prefixed stages and ids', () => {
    const saved: SavedWalkthrough = {
      version: SAVED_VERSION,
      scopeKind: 'file',
      scopeRef: 'a.ts',
      model: 'm',
      overview: {
        file: 'a.ts',
        lineCount: 8,
        importers: [{ file: 'b.ts', importedNames: ['main'] }],
        exports: [{ name: 'main', kind: 'function', line: 5 }],
        helpers: [{ name: 'helper', kind: 'function', line: 1 }],
        order: ['helper', 'main'],
        cycleBreaks: [],
        failed: [],
      },
      sections: [sectionFor(SOURCE, 'a.ts', 'helper', 1, 3), sectionFor(SOURCE, 'a.ts', 'main', 5, 8)],
    };
    const w = flattenWalkthrough(saved);
    expect(w.title).toBe('How a.ts works');
    expect(w.scope).toEqual({ file: 'a.ts', start: 1, end: 8, symbol: null });
    expect(w.stages.map((s) => s.name)).toEqual(['helper · Body', 'main · Body']);
    expect(w.stages[1].steps[0].id).toBe('main/s1');
    expect(w.verification.keptSteps).toBe(7);
    expect(overviewNotes(saved.overview!)).toEqual([
      'Imported by: b.ts (main)',
      'Exports: main (function, line 5)',
      'Internal helpers: helper (function, line 1)',
      'Walk order (helpers first): helper → main',
    ]);
    expect(contentHashOf(saved.sections)).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run core/src/walkthrough/section.test.ts`
Expected: FAIL with `Failed to load url ./saved.js`.

- [ ] **Step 4: Add the condensed prompt option**

In `core/src/llm/prompt.ts`, add after `FN_SYSTEM_PROMPT`:

```ts
export interface FnPromptOptions {
  /** `walk file`: this function is one of several, so keep its walkthrough short (CLAUDE.md §6.2). */
  condensed?: boolean;
}

const CONDENSED =
  'Keep it condensed: this function is one of several in a file walkthrough. Use at most 5 steps, each covering a meaningful group of lines.';
```

Change the signature `export function renderFnPrompt(ctx: FnContext): string {` to `export function renderFnPrompt(ctx: FnContext, options: FnPromptOptions = {}): string {` and, directly after the existing `out.push(\`Write the walkthrough of ...\`);` line, add:

```ts
  if (options.condensed) out.push(CONDENSED);
```

In `core/src/llm/generate.ts`: change the import to `import { FN_SYSTEM_PROMPT, renderFnPrompt, type FnPromptOptions } from './prompt.js';`, the signature to `export async function generateFnWalkthrough(provider: LlmProvider, ctx: FnContext, options: FnPromptOptions = {}): Promise<GenerateResult> {` and the first line of its body to `const messages: LlmMessage[] = [{ role: 'user', content: renderFnPrompt(ctx, options) }];`.

In `core/src/walkthrough/fn.ts`: add `import type { FnPromptOptions } from '../llm/prompt.js';`, change the signature to `export async function explainFn(provider: LlmProvider, ctx: FnContext, repoRoot: string, options: FnPromptOptions = {}): Promise<FnWalkthrough> {` and its first line to `const { walkthrough, attempts } = await generateFnWalkthrough(provider, ctx, options);`.

- [ ] **Step 5: Add the line stub provider**

Create `core/src/llm/stub.ts`:

```ts
import type { LlmProvider } from './generate.js';

/**
 * An offline provider that answers with one step per line of the target, each citing only that line.
 * Deterministic and always passes the verifier, so tests of caching, staleness and ordering use it
 * where the explanation text doesn't matter.
 */
export interface LineStubProvider extends LlmProvider {
  /** "file:start-end" of every target explained, in call order. */
  targets: string[];
  prompts: string[];
}

const TARGET = /^# Target: .* at (\S+):(\d+)-(\d+)$/m;

export function createLineStubProvider(): LineStubProvider {
  const targets: string[] = [];
  const prompts: string[] = [];
  return {
    targets,
    prompts,
    async generate({ messages }) {
      const prompt = messages[0].content;
      const match = TARGET.exec(prompt);
      if (!match) throw new Error('line stub: no "# Target:" line in the prompt');
      const [, file, s, e] = match;
      const start = Number(s);
      const end = Number(e);
      targets.push(`${file}:${start}-${end}`);
      prompts.push(prompt);
      const steps = Array.from({ length: end - start + 1 }, (_, i) => ({
        id: `s${i + 1}`,
        code_ref: { file, start: start + i, end: start + i },
        explanation: `Line ${start + i} of the target.`,
        example: { input: 'any input', state_after: 'unchanged' },
        references: [],
        docs: [],
        concepts: [],
        risks: [],
      }));
      return JSON.stringify({ title: `Walkthrough of ${file}:${start}-${end}`, summary: 'Stub summary.', stages: [{ name: 'Body', steps }], unresolved: [] });
    },
  };
}
```

Replace `core/src/llm/index.ts` with:

```ts
export { AnthropicProvider, LlmRequestError } from './anthropic.js';
export { generateFnWalkthrough, LlmOutputError, type GenerateResult, type LlmMessage, type LlmProvider } from './generate.js';
export { FN_SYSTEM_PROMPT, renderFnPrompt, type FnPromptOptions } from './prompt.js';
export { createLineStubProvider, type LineStubProvider } from './stub.js';
export * from './schema.js';
```

- [ ] **Step 6: Implement the saved model**

Create `core/src/walkthrough/saved.ts`:

```ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FnTarget } from '../context/target.js';
import type { SymbolKind } from '../store/types.js';
import type { FnWalkthrough } from './fn.js';

// What `walk fn` and `walk file` save (CLAUDE.md §9). A saved walkthrough is a list of sections, one
// per explained code block: `walk fn` has one, `walk file` one per function. Each section keeps the
// hash of its block and of every step's lines, so staleness is decided per step.

export const SAVED_VERSION = 1;

export type ScopeKind = 'fn' | 'file';

/** The code a section explains: a named symbol (found again by name when lines move) or a fixed range. */
export interface BlockRef {
  file: string;
  /** Symbol name, or null for a `walk fn <file>:<start>-<end>` range. */
  symbol: string | null;
  start: number;
  end: number;
  /** hashLines of lines start..end when the section was generated. */
  hash: string;
}

export interface Section {
  block: BlockRef;
  /** Step id -> hashLines of the step's code_ref lines at generation time. */
  stepHashes: Record<string, string>;
  /** Content hash of every file the context cited, at generation time. */
  fileHashes: Record<string, string>;
  generatedAt: string;
  walkthrough: FnWalkthrough;
}

export interface SymbolSummary {
  name: string;
  kind: SymbolKind;
  line: number;
}

/** A file's role and map (CLAUDE.md §6.2 items 1-2), from the index alone; rebuilt on every run. */
export interface FileOverview {
  file: string;
  lineCount: number;
  importers: { file: string; importedNames: string[] }[];
  exports: SymbolSummary[];
  helpers: SymbolSummary[];
  /** Names of the walked functions, helpers first. */
  order: string[];
  cycleBreaks: string[];
  /** Functions with no section this run, and why. */
  failed: { symbol: string; reason: string }[];
}

export interface SavedWalkthrough {
  version: typeof SAVED_VERSION;
  scopeKind: ScopeKind;
  /** "file#symbol" or "file:start-end" for fn, "file" for file. */
  scopeRef: string;
  model: string;
  overview: FileOverview | null;
  sections: Section[];
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** Lines of a repo file, or null when it no longer exists. */
export function readLines(repoRoot: string, file: string): string[] | null {
  const path = join(repoRoot, file);
  return existsSync(path) ? splitLines(readFileSync(path, 'utf8')) : null;
}

/** Content hash of a repo file, or null when it no longer exists. */
export function hashFile(repoRoot: string, file: string): string | null {
  const path = join(repoRoot, file);
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

/** Hash of a block's text alone: moving the block to other lines does not change it. */
export function hashLines(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** walkthroughs.content_hash: changes whenever any section's block changes. */
export function contentHashOf(sections: Section[]): string {
  const keys = sections.map((s) => `${s.block.file}#${s.block.symbol ?? `${s.block.start}-${s.block.end}`}:${s.block.hash}`);
  return createHash('sha256').update(keys.join('\n')).digest('hex');
}

export function fnScopeRef(target: FnTarget): string {
  return target.kind === 'symbol' ? `${target.file}#${target.name}` : `${target.file}:${target.start}-${target.end}`;
}

/** One walkthrough for the stepper and plain-text output: a file's sections become prefixed stages. */
export function flattenWalkthrough(saved: SavedWalkthrough): FnWalkthrough {
  if (saved.scopeKind === 'fn') return saved.sections[0].walkthrough;
  const o = saved.overview!;
  const prefix = (s: Section, id: string) => `${s.block.symbol ?? 'block'}/${id}`;
  const all = saved.sections;
  return {
    scope: { file: o.file, start: 1, end: o.lineCount, symbol: null },
    title: `How ${o.file} works`,
    summary: `${o.file} has ${o.order.length} function(s), walked helpers first.`,
    stages: all.flatMap((s) =>
      s.walkthrough.stages.map((stage) => ({
        name: `${s.block.symbol ?? 'block'} · ${stage.name}`,
        steps: stage.steps.map((step) => ({ ...step, id: prefix(s, step.id) })),
      })),
    ),
    unresolved: [...new Set(all.flatMap((s) => s.walkthrough.unresolved))],
    verification: {
      attempts: all.reduce((n, s) => n + s.walkthrough.verification.attempts, 0),
      keptSteps: all.reduce((n, s) => n + s.walkthrough.verification.keptSteps, 0),
      dropped: all.flatMap((s) => s.walkthrough.verification.dropped.map((d) => ({ ...d, stepId: prefix(s, d.stepId) }))),
      removedDocs: all.flatMap((s) => s.walkthrough.verification.removedDocs.map((d) => ({ ...d, stepId: prefix(s, d.stepId) }))),
    },
  };
}

/** The file overview as plain lines, shared by the terminal, the stepper and Markdown. */
export function overviewNotes(o: FileOverview): string[] {
  const list = (xs: SymbolSummary[]) => xs.map((s) => `${s.name} (${s.kind}, line ${s.line})`).join(', ') || 'none';
  const importers = o.importers.map((i) => (i.importedNames.length ? `${i.file} (${i.importedNames.join(', ')})` : i.file));
  return [
    `Imported by: ${importers.join('; ') || 'no indexed file'}`,
    `Exports: ${list(o.exports)}`,
    `Internal helpers: ${list(o.helpers)}`,
    `Walk order (helpers first): ${o.order.join(' → ') || 'no functions'}`,
    ...o.cycleBreaks.map((c) => `Cycle: ${c}`),
    ...o.failed.map((f) => `Not explained: ${f.symbol}: ${f.reason}`),
  ];
}
```

- [ ] **Step 7: Implement generate/reuse**

Create `core/src/walkthrough/section.ts`:

```ts
import type { FnContext } from '../context/fn.js';
import type { LlmProvider } from '../llm/generate.js';
import { explainFn } from './fn.js';
import { hashFile, hashLines, readLines, type Section } from './saved.js';

/**
 * Explains ctx's target and records what staleness checks need. `symbol` names the block so it can
 * be found again after its lines move; null pins it to the exact range (`walk fn file:a-b`).
 */
export async function generateSection(
  provider: LlmProvider,
  ctx: FnContext,
  repoRoot: string,
  options: { symbol: string | null; condensed?: boolean },
): Promise<Section> {
  const walkthrough = await explainFn(provider, ctx, repoRoot, { condensed: options.condensed });
  const cache = new Map<string, string[]>();
  const lines = (file: string) => {
    if (!cache.has(file)) cache.set(file, readLines(repoRoot, file) ?? []);
    return cache.get(file)!;
  };
  const steps = walkthrough.stages.flatMap((s) => s.steps);
  const { target } = ctx;
  return {
    block: { file: target.file, symbol: options.symbol, start: target.start, end: target.end, hash: hashLines(target.code.lines) },
    stepHashes: Object.fromEntries(steps.map((s) => [s.id, hashLines(lines(s.code_ref.file).slice(s.code_ref.start - 1, s.code_ref.end))])),
    fileHashes: Object.fromEntries(Object.keys(ctx.files).map((f) => [f, hashFile(repoRoot, f) ?? ''])),
    generatedAt: new Date().toISOString(),
    walkthrough,
  };
}

/**
 * The saved section moved to where its block is now, or null when it must be regenerated (the
 * block's text changed, or a step cites code outside the block). Lines inside the block shift with
 * it. A reference elsewhere is kept only if its file is unchanged since generation; otherwise its
 * line could be wrong, so it is dropped.
 */
export function reuseSection(
  prev: Section,
  current: { start: number; end: number; lines: string[] },
  fileHash: (file: string) => string | null,
): Section | null {
  if (hashLines(current.lines) !== prev.block.hash) return null;
  const { file, start: oldStart, end: oldEnd } = prev.block;
  const inBlock = (f: string, line: number) => f === file && line >= oldStart && line <= oldEnd;
  const w = prev.walkthrough;
  const steps = w.stages.flatMap((s) => s.steps);
  if (steps.some((s) => !inBlock(s.code_ref.file, s.code_ref.start) || !inBlock(s.code_ref.file, s.code_ref.end))) return null;

  const delta = current.start - oldStart;
  const unchanged = (f: string) => fileHash(f) === prev.fileHashes[f];
  return {
    ...prev,
    block: { ...prev.block, start: current.start, end: current.end },
    fileHashes: Object.fromEntries(Object.keys(prev.fileHashes).map((f) => [f, fileHash(f) ?? ''])),
    walkthrough: {
      ...w,
      scope: { ...w.scope, start: current.start, end: current.end },
      stages: w.stages.map((stage) => ({
        ...stage,
        steps: stage.steps.map((step) => ({
          ...step,
          code_ref: { ...step.code_ref, start: step.code_ref.start + delta, end: step.code_ref.end + delta },
          references: step.references.flatMap((r) =>
            inBlock(r.file, r.line) ? [{ ...r, line: r.line + delta }] : unchanged(r.file) ? [r] : [],
          ),
        })),
      })),
    },
  };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run core/src/walkthrough/section.test.ts core/src/walkthrough/fn.test.ts`
Expected: PASS. `fn.test.ts` is unchanged and still passes because the new options all have defaults.

---

### Task 4: Staleness

**Files:**
- Create: `core/src/walkthrough/staleness.ts`
- Test: `core/src/walkthrough/staleness.test.ts`

**Interfaces:**
- Consumes: `Section`, `SavedWalkthrough`, `BlockRef`, `hashLines`, `readLines` (Task 3), `walkableSymbols` (Task 2), `Store.getSymbolsInFile`.
- Produces:
  - `interface CurrentFile { lines: string[]; symbols: Pick<SymbolRecord, 'name' | 'kind' | 'startLine' | 'endLine'>[] }`
  - `type CurrentSource = (file: string) => CurrentFile | null`
  - `interface StepStatus { stepId: string; fresh: boolean; file: string; start: number; end: number }`. A fresh step reports where its lines are now; a stale step reports where they were.
  - `type SectionState = 'fresh' | 'changed' | 'missing'`
  - `interface SectionStatus { symbol: string | null; file: string; state: SectionState; current: { start: number; end: number } | null; steps: StepStatus[] }`
  - `interface WalkthroughStatus { fresh: boolean; sections: SectionStatus[]; uncovered: string[]; staleSteps: number; totalSteps: number }`
  - `locateBlock(block: BlockRef, file: CurrentFile): { start: number; end: number } | null`
  - `checkSection(section: Section, source: CurrentSource): SectionStatus`
  - `checkWalkthrough(saved: SavedWalkthrough, source: CurrentSource): WalkthroughStatus`
  - `filesOf(saved: SavedWalkthrough): string[]`
  - `loadCurrentSource(store: Store, repoRoot: string, files: string[]): Promise<CurrentSource>`

- [ ] **Step 1: Write the failing tests**

Create `core/src/walkthrough/staleness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sectionFor } from './__fixtures__/sections.js';
import { SAVED_VERSION, type SavedWalkthrough } from './saved.js';
import { checkSection, checkWalkthrough, type CurrentFile, type CurrentSource } from './staleness.js';

const SOURCE = ['function helper() {', '  return 1;', '}', '', 'function main() {', '  const x = helper();', '  return x + 1;', '}'];
const fn = (name: string, startLine: number, endLine: number) => ({ name, kind: 'function' as const, startLine, endLine });
const only = (file: CurrentFile | null): CurrentSource => (f) => (f === 'a.ts' ? file : null);

describe('checkSection', () => {
  const main = sectionFor(SOURCE, 'a.ts', 'main', 5, 8);

  it('is fresh when the code is unchanged', () => {
    const status = checkSection(main, only({ lines: SOURCE, symbols: [fn('helper', 1, 3), fn('main', 5, 8)] }));
    expect(status.state).toBe('fresh');
    expect(status.steps.every((s) => s.fresh)).toBe(true);
  });

  it('stays fresh when lines above it moved, and reports the new lines', () => {
    const moved = ['// a', '// b', ...SOURCE];
    const status = checkSection(main, only({ lines: moved, symbols: [fn('helper', 3, 5), fn('main', 7, 10)] }));
    expect(status.state).toBe('fresh');
    expect(status.current).toEqual({ start: 7, end: 10 });
    expect(status.steps.map((s) => s.start)).toEqual([7, 8, 9, 10]);
  });

  it('marks only the edited step stale when the function changed', () => {
    const edited = [...SOURCE];
    edited[5] = '  const x = helper() * 2;';
    const status = checkSection(main, only({ lines: edited, symbols: [fn('helper', 1, 3), fn('main', 5, 8)] }));
    expect(status.state).toBe('changed');
    expect(status.steps.filter((s) => !s.fresh).map((s) => s.stepId)).toEqual(['s2']);
  });

  it('finds unchanged steps after a line is inserted inside the function', () => {
    const grown = [...SOURCE.slice(0, 6), '  console.log(x);', ...SOURCE.slice(6)];
    const status = checkSection(main, only({ lines: grown, symbols: [fn('helper', 1, 3), fn('main', 5, 9)] }));
    expect(status.state).toBe('changed');
    expect(status.steps.map((s) => [s.stepId, s.fresh, s.start])).toEqual([
      ['s1', true, 5],
      ['s2', true, 6],
      ['s3', true, 8],
      ['s4', true, 9],
    ]);
  });

  it('is missing when the function was renamed or removed', () => {
    const status = checkSection(main, only({ lines: SOURCE, symbols: [fn('helper', 1, 3), fn('mainRenamed', 5, 8)] }));
    expect(status.state).toBe('missing');
    expect(status.current).toBeNull();
    expect(status.steps.every((s) => !s.fresh)).toBe(true);
  });

  it('is missing when the file was deleted', () => {
    expect(checkSection(main, only(null)).state).toBe('missing');
  });

  it('pins a range block to its lines and goes missing when the file got shorter', () => {
    const range = sectionFor(SOURCE, 'a.ts', null, 5, 8);
    expect(checkSection(range, only({ lines: SOURCE, symbols: [] })).state).toBe('fresh');
    expect(checkSection(range, only({ lines: SOURCE.slice(0, 4), symbols: [] })).state).toBe('missing');
  });
});

describe('checkWalkthrough', () => {
  it('reports functions a file walkthrough does not cover', () => {
    const saved: SavedWalkthrough = {
      version: SAVED_VERSION,
      scopeKind: 'file',
      scopeRef: 'a.ts',
      model: 'm',
      overview: null,
      sections: [sectionFor(SOURCE, 'a.ts', 'helper', 1, 3)],
    };
    const status = checkWalkthrough(saved, only({ lines: SOURCE, symbols: [fn('helper', 1, 3), fn('main', 5, 8)] }));
    expect(status).toMatchObject({ fresh: false, uncovered: ['main'], staleSteps: 0, totalSteps: 3 });
  });

  it('counts stale steps across sections', () => {
    const edited = [...SOURCE];
    edited[1] = '  return 2;';
    const saved: SavedWalkthrough = {
      version: SAVED_VERSION,
      scopeKind: 'file',
      scopeRef: 'a.ts',
      model: 'm',
      overview: null,
      sections: [sectionFor(SOURCE, 'a.ts', 'helper', 1, 3), sectionFor(SOURCE, 'a.ts', 'main', 5, 8)],
    };
    const status = checkWalkthrough(saved, only({ lines: edited, symbols: [fn('helper', 1, 3), fn('main', 5, 8)] }));
    expect(status).toMatchObject({ fresh: false, uncovered: [], staleSteps: 1, totalSteps: 7 });
    expect(status.sections.map((s) => s.state)).toEqual(['changed', 'fresh']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run core/src/walkthrough/staleness.test.ts`
Expected: FAIL with `Failed to load url ./staleness.js`.

- [ ] **Step 3: Implement**

Create `core/src/walkthrough/staleness.ts`:

```ts
import { walkableSymbols } from '../context/order.js';
import type { Store } from '../store/index.js';
import type { SymbolRecord } from '../store/types.js';
import type { WalkthroughStep } from './fn.js';
import { hashLines, readLines, type BlockRef, type SavedWalkthrough, type Section } from './saved.js';

// Staleness (CLAUDE.md §9). A section is fresh when its block's text is unchanged, wherever it now
// sits. When the block changed, each step stays fresh if its exact lines still appear in the block,
// so editing one function marks only the steps whose code changed.

export interface CurrentFile {
  lines: string[];
  symbols: Pick<SymbolRecord, 'name' | 'kind' | 'startLine' | 'endLine'>[];
}

/** The current lines and indexed symbols of a file; null when it no longer exists. */
export type CurrentSource = (file: string) => CurrentFile | null;

export interface StepStatus {
  stepId: string;
  fresh: boolean;
  /** Where the step's lines are now (fresh) or were when generated (stale). */
  file: string;
  start: number;
  end: number;
}

export type SectionState = 'fresh' | 'changed' | 'missing';

export interface SectionStatus {
  symbol: string | null;
  file: string;
  state: SectionState;
  /** Where the block is now; null when it can't be found. */
  current: { start: number; end: number } | null;
  steps: StepStatus[];
}

export interface WalkthroughStatus {
  fresh: boolean;
  sections: SectionStatus[];
  /** File walkthroughs only: functions in the file that no section explains (new, or failed last time). */
  uncovered: string[];
  staleSteps: number;
  totalSteps: number;
}

/** Where the block is now: by symbol name (nearest to its old line if repeated), or the same range. */
export function locateBlock(block: BlockRef, file: CurrentFile): { start: number; end: number } | null {
  if (block.symbol === null) return block.end <= file.lines.length ? { start: block.start, end: block.end } : null;
  const matches = file.symbols.filter((s) => s.name === block.symbol);
  if (matches.length === 0) return null;
  const best = matches.reduce((a, b) => (Math.abs(b.startLine - block.start) < Math.abs(a.startLine - block.start) ? b : a));
  return { start: best.startLine, end: best.endLine };
}

export function checkSection(section: Section, source: CurrentSource): SectionStatus {
  const { block } = section;
  const steps = section.walkthrough.stages.flatMap((s) => s.steps);
  const base = { symbol: block.symbol, file: block.file };
  const file = source(block.file);
  const at = file && locateBlock(block, file);
  if (!file || !at) return { ...base, state: 'missing', current: null, steps: steps.map((s) => stepAt(s, false, s.code_ref.start)) };

  const delta = at.start - block.start;
  if (hashLines(file.lines.slice(at.start - 1, at.end)) === block.hash) {
    return { ...base, state: 'fresh', current: at, steps: steps.map((s) => stepAt(s, true, s.code_ref.start + delta)) };
  }
  return {
    ...base,
    state: 'changed',
    current: at,
    steps: steps.map((s) => findStep(s, section.stepHashes[s.id], file.lines, at, s.code_ref.start + delta)),
  };
}

export function checkWalkthrough(saved: SavedWalkthrough, source: CurrentSource): WalkthroughStatus {
  const sections = saved.sections.map((s) => checkSection(s, source));
  let uncovered: string[] = [];
  if (saved.scopeKind === 'file') {
    const file = source(saved.scopeRef);
    const covered = new Set(saved.sections.map((s) => s.block.symbol));
    uncovered = file ? walkableSymbols(file.symbols).map((s) => s.name).filter((name) => !covered.has(name)) : [];
  }
  const steps = sections.flatMap((s) => s.steps);
  return {
    fresh: sections.every((s) => s.state === 'fresh') && uncovered.length === 0,
    sections,
    uncovered,
    staleSteps: steps.filter((s) => !s.fresh).length,
    totalSteps: steps.length,
  };
}

/** Every file whose current state decides the walkthrough's staleness. */
export function filesOf(saved: SavedWalkthrough): string[] {
  return [...new Set([...saved.sections.map((s) => s.block.file), ...(saved.scopeKind === 'file' ? [saved.scopeRef] : [])])];
}

/** Reads each file once, with its indexed symbols (the index must be current). */
export async function loadCurrentSource(store: Store, repoRoot: string, files: string[]): Promise<CurrentSource> {
  const loaded = new Map<string, CurrentFile | null>();
  for (const file of new Set(files)) {
    const lines = readLines(repoRoot, file);
    loaded.set(file, lines && { lines, symbols: await store.getSymbolsInFile(file) });
  }
  return (file) => loaded.get(file) ?? null;
}

function stepAt(step: WalkthroughStep, fresh: boolean, start: number): StepStatus {
  return { stepId: step.id, fresh, file: step.code_ref.file, start, end: start + (step.code_ref.end - step.code_ref.start) };
}

/** The occurrence of the step's exact lines inside the block nearest to where it is expected. */
function findStep(step: WalkthroughStep, hash: string | undefined, lines: string[], at: { start: number; end: number }, expected: number): StepStatus {
  const length = step.code_ref.end - step.code_ref.start + 1;
  let best: number | null = null;
  if (hash !== undefined) {
    for (let start = at.start; start + length - 1 <= at.end; start++) {
      if (hashLines(lines.slice(start - 1, start - 1 + length)) !== hash) continue;
      if (best === null || Math.abs(start - expected) < Math.abs(best - expected)) best = start;
    }
  }
  return best === null ? stepAt(step, false, step.code_ref.start) : stepAt(step, true, best);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run core/src/walkthrough/staleness.test.ts`
Expected: PASS (9 tests).

---

### Task 5: File context and the per-function walkthrough loop

**Files:**
- Create: `core/src/context/file.ts`, `core/src/walkthrough/file.ts`
- Modify: `core/src/context/target.ts` (add `parseFileTarget`)
- Test: `core/src/walkthrough/file.test.ts`

**Interfaces:**
- Consumes: `Store.getFile`, `getSymbolsInFile`, `getImportersOf`, `getCallEdgesInFile` (Task 1), `walkableSymbols`, `dependencyOrder` (Task 2), `generateSection`, `reuseSection`, `readLines`, `hashFile`, `SAVED_VERSION`, `FileOverview`, `SavedWalkthrough` (Task 3), `buildFnContext`, `TargetError`, `NoVerifiedStepsError`, `LlmRequestError`, `LlmOutputError`, `createLineStubProvider`.
- Produces:
  - `parseFileTarget(arg: string): string` (normalized repo-relative path)
  - `interface FileContext { file: string; lineCount: number; importers: ImporterRecord[]; exports: SymbolRecord[]; helpers: SymbolRecord[]; order: SymbolRecord[]; cycleBreaks: string[]; warnings: string[] }`
  - `buildFileContext(store: Store, repoRoot: string, file: string): Promise<FileContext>`
  - `interface ExplainFileOptions { depth: number; maxContextTokens: number; model: string; refresh: boolean; onProgress?: (line: string) => void }`
  - `interface ExplainFileResult { saved: SavedWalkthrough; generated: string[]; reused: string[]; aborted: Error | null }`
  - `explainFile(store: Store, provider: LlmProvider, repoRoot: string, fileCtx: FileContext, previous: SavedWalkthrough | null, options: ExplainFileOptions): Promise<ExplainFileResult>`

- [ ] **Step 1: Write the failing tests**

Create `core/src/walkthrough/file.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildFileContext } from '../context/file.js';
import { buildFnContext } from '../context/fn.js';
import { parseFileTarget, TargetError } from '../context/target.js';
import { indexRepo } from '../indexer/index.js';
import { LlmRequestError } from '../llm/anthropic.js';
import type { LlmProvider } from '../llm/generate.js';
import { createLineStubProvider } from '../llm/stub.js';
import { openStore, type Store } from '../store/index.js';
import { explainFile, type ExplainFileOptions } from './file.js';
import { hashLines, readLines } from './saved.js';
import { generateSection } from './section.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const SERVICE = 'api/services/enrollService.ts';

describe('walk file on a copy of the fixture', () => {
  let repo: string;
  let store: Store;
  const options = (o: Partial<ExplainFileOptions> = {}): ExplainFileOptions => ({ depth: 2, maxContextTokens: 60000, model: 'stub', refresh: false, ...o });
  const reindex = () => indexRepo(repo, loadConfig(repo), store);
  const editService = (change: (text: string) => string) => writeFileSync(join(repo, SERVICE), change(readFileSync(join(repo, SERVICE), 'utf8')));

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-file-'));
    cpSync(FIXTURE, repo, { recursive: true });
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_file_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await reindex();
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('parses a file argument and rejects fn-style targets', () => {
    expect(parseFileTarget('./api/services/enrollService.ts')).toBe(SERVICE);
    expect(() => parseFileTarget('api/x.ts#f')).toThrow(TargetError);
    expect(() => parseFileTarget('api/x.ts:1-4')).toThrow(/use `walk fn/);
  });

  it('builds the file overview: importers, exports, helpers, helpers-first order', async () => {
    const ctx = await buildFileContext(store, repo, SERVICE);
    expect(ctx.importers).toEqual([{ file: 'api/controllers/patientsController.ts', importedNames: ['enrollPatient', 'getPatient'] }]);
    expect(ctx.exports.map((s) => s.name)).toEqual(['normalizePhone', 'calculateAge', 'enrollPatient', 'getPatient']);
    expect(ctx.helpers).toEqual([]);
    expect(ctx.order.map((s) => s.name)).toEqual(['normalizePhone', 'calculateAge', 'enrollPatient', 'getPatient']);

    const handlers = await buildFileContext(store, repo, 'api/events/handlers.ts');
    expect(handlers.helpers.map((s) => s.name)).toEqual(['sendWelcomeSms', 'notifyCareTeam']);
    expect(handlers.exports.map((s) => s.name)).toEqual(['dispatch']);
  });

  it('reports a file that is not indexed', async () => {
    await expect(buildFileContext(store, repo, 'api/nope.ts')).rejects.toThrow(/api\/nope\.ts is not in the index/);
  });

  it('records block and step hashes when generating a section', async () => {
    const ctx = await buildFnContext(store, repo, { kind: 'symbol', file: SERVICE, name: 'normalizePhone' }, { depth: 2, maxContextTokens: 60000 });
    const section = await generateSection(createLineStubProvider(), ctx, repo, { symbol: 'normalizePhone' });
    const lines = readLines(repo, SERVICE)!;
    expect(section.block).toEqual({ file: SERVICE, symbol: 'normalizePhone', start: 17, end: 20, hash: hashLines(lines.slice(16, 20)) });
    expect(Object.keys(section.stepHashes)).toEqual(['s1', 's2', 's3', 's4']);
    expect(Object.keys(section.fileHashes)).toContain(SERVICE);
  });

  it('explains every function once with a condensed prompt, then reuses all of them', async () => {
    const first = createLineStubProvider();
    const ctx = await buildFileContext(store, repo, SERVICE);
    const a = await explainFile(store, first, repo, ctx, null, options());
    expect(first.targets).toEqual([`${SERVICE}:17-20`, `${SERVICE}:23-33`, `${SERVICE}:35-69`, `${SERVICE}:71-81`]);
    expect(first.prompts.every((p) => p.includes('Keep it condensed'))).toBe(true);
    expect(a.generated).toHaveLength(4);
    expect(a.saved.overview!.order).toEqual(['normalizePhone', 'calculateAge', 'enrollPatient', 'getPatient']);

    const second = createLineStubProvider();
    const b = await explainFile(store, second, repo, ctx, a.saved, options());
    expect(second.targets).toEqual([]);
    expect(b.reused).toHaveLength(4);

    const forced = createLineStubProvider();
    await explainFile(store, forced, repo, ctx, a.saved, options({ refresh: true }));
    expect(forced.targets).toHaveLength(4);
  });

  it('makes no LLM call for a file without functions', async () => {
    const stub = createLineStubProvider();
    const ctx = await buildFileContext(store, repo, 'web/types.ts');
    const result = await explainFile(store, stub, repo, ctx, null, options());
    expect(stub.targets).toEqual([]);
    expect(result.saved.sections).toEqual([]);
    expect(result.saved.overview!.order).toEqual([]);
  });

  it('keeps finished sections when a request fails, and the next run fills the gap', async () => {
    const stub = createLineStubProvider();
    let calls = 0;
    const flaky: LlmProvider = {
      generate: async (req) => {
        if (++calls === 2) throw new LlmRequestError('rate limited');
        return stub.generate(req);
      },
    };
    const ctx = await buildFileContext(store, repo, SERVICE);
    const partial = await explainFile(store, flaky, repo, ctx, null, options());
    expect(partial.aborted).toBeInstanceOf(LlmRequestError);
    expect(partial.saved.sections.map((s) => s.block.symbol)).toEqual(['normalizePhone']);
    expect(partial.saved.overview!.failed).toEqual([
      { symbol: 'calculateAge', reason: 'rate limited' },
      { symbol: 'enrollPatient', reason: 'skipped after an earlier error' },
      { symbol: 'getPatient', reason: 'skipped after an earlier error' },
    ]);

    const rest = createLineStubProvider();
    const filled = await explainFile(store, rest, repo, ctx, partial.saved, options());
    expect(filled.reused).toEqual(['normalizePhone']);
    expect(filled.generated).toEqual(['calculateAge', 'enrollPatient', 'getPatient']);
    expect(filled.saved.overview!.failed).toEqual([]);
  });

  it('after an edit, regenerates only the changed function and shifts the others', async () => {
    const original = await explainFile(store, createLineStubProvider(), repo, await buildFileContext(store, repo, SERVICE), null, options());

    editService((t) => `// enrollment service\n${t.replace("phone.replace(/\\D/g, '')", "phone.replace(/[^0-9]/g, '')")}`);
    await reindex();

    const stub = createLineStubProvider();
    const ctx = await buildFileContext(store, repo, SERVICE);
    const result = await explainFile(store, stub, repo, ctx, original.saved, options());
    expect(stub.targets).toEqual([`${SERVICE}:18-21`]);
    expect(result.generated).toEqual(['normalizePhone']);
    expect(result.reused).toEqual(['calculateAge', 'enrollPatient', 'getPatient']);
    const enroll = result.saved.sections.find((s) => s.block.symbol === 'enrollPatient')!;
    expect(enroll.block).toMatchObject({ start: 36, end: 70 });
    expect(enroll.walkthrough.stages[0].steps[0].code_ref.start).toBe(36);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run core/src/walkthrough/file.test.ts`
Expected: FAIL with `Failed to load url ../context/file.js`.

- [ ] **Step 3: Add `parseFileTarget`**

Append to `core/src/context/target.ts`:

```ts
/** Parses the argument of `walk file`: a repo-relative path. */
export function parseFileTarget(arg: string): string {
  const file = normalizeFile(arg);
  if (!file) throw new TargetError('Expected a file path, e.g. api/services/enrollService.ts');
  if (file.includes('#') || RANGE.test(file)) {
    throw new TargetError(`"${arg}" names a function or line range; use \`walk fn ${arg}\` instead.`);
  }
  return file;
}
```

- [ ] **Step 4: Implement the file context**

Create `core/src/context/file.ts`:

```ts
import type { Store } from '../store/index.js';
import type { ImporterRecord, SymbolRecord } from '../store/types.js';
import { hashFile, readLines } from '../walkthrough/saved.js';
import { dependencyOrder, walkableSymbols } from './order.js';
import { TargetError } from './target.js';

// Static facts for `walk file` (CLAUDE.md §6.2): who imports the file, what it exports, its internal
// helpers, and the order its functions are walked in. Also the `walk file --no-llm` output.

export interface FileContext {
  file: string;
  lineCount: number;
  importers: ImporterRecord[];
  /** Exported symbols of any kind, in source order. */
  exports: SymbolRecord[];
  /** Walked functions that aren't exported. */
  helpers: SymbolRecord[];
  /** Walked functions, helpers first, entry points last. */
  order: SymbolRecord[];
  cycleBreaks: string[];
  warnings: string[];
}

export async function buildFileContext(store: Store, repoRoot: string, file: string): Promise<FileContext> {
  const record = await store.getFile(file);
  const lines = readLines(repoRoot, file);
  if (!record || !lines) {
    throw new TargetError(`${file} is not in the index. Check the path (relative to the repo root) or run \`walk index\`.`);
  }
  const warnings = hashFile(repoRoot, file) === record.hash ? [] : [`${file} changed since it was indexed; run \`walk index\` for accurate facts.`];

  const [symbols, importers, edges] = await Promise.all([
    store.getSymbolsInFile(file),
    store.getImportersOf(file),
    store.getCallEdgesInFile(file),
  ]);
  const walkable = walkableSymbols(symbols);
  const { order, cycleBreaks } = dependencyOrder(walkable, symbols, edges);

  return {
    file,
    lineCount: lines.length,
    importers,
    exports: symbols.filter((s) => s.exported),
    helpers: walkable.filter((s) => !s.exported),
    order,
    cycleBreaks,
    warnings,
  };
}
```

- [ ] **Step 5: Implement `explainFile`**

Create `core/src/walkthrough/file.ts`:

```ts
import type { FileContext } from '../context/file.js';
import { buildFnContext } from '../context/fn.js';
import { TargetError } from '../context/target.js';
import { LlmRequestError } from '../llm/anthropic.js';
import { LlmOutputError, type LlmProvider } from '../llm/generate.js';
import type { Store } from '../store/index.js';
import type { SymbolRecord } from '../store/types.js';
import { NoVerifiedStepsError } from './fn.js';
import { hashFile, readLines, SAVED_VERSION, type FileOverview, type SavedWalkthrough, type Section, type SymbolSummary } from './saved.js';
import { generateSection, reuseSection } from './section.js';

// `walk file` (CLAUDE.md §6.2): each function in dependency order, explained in condensed `walk fn`
// form. A function whose code is unchanged since the previous run reuses its saved section; only
// changed or new functions go to the LLM (CLAUDE.md §9).

export interface ExplainFileOptions {
  depth: number;
  maxContextTokens: number;
  model: string;
  /** Regenerate every function even if its saved section is still fresh. */
  refresh: boolean;
  onProgress?: (line: string) => void;
}

export interface ExplainFileResult {
  saved: SavedWalkthrough;
  generated: string[];
  reused: string[];
  /** A request or output error that stopped generation. Finished sections are still in `saved`. */
  aborted: Error | null;
}

export async function explainFile(
  store: Store,
  provider: LlmProvider,
  repoRoot: string,
  fileCtx: FileContext,
  previous: SavedWalkthrough | null,
  options: ExplainFileOptions,
): Promise<ExplainFileResult> {
  const lines = readLines(repoRoot, fileCtx.file) ?? [];
  const fileHash = (f: string) => hashFile(repoRoot, f);
  const sections: Section[] = [];
  const generated: string[] = [];
  const reused: string[] = [];
  const failed: FileOverview['failed'] = [];
  let aborted: Error | null = null;

  for (const [i, symbol] of fileCtx.order.entries()) {
    const label = `[${i + 1}/${fileCtx.order.length}] ${symbol.name}`;
    const prev = options.refresh ? undefined : previous?.sections.find((s) => s.block.symbol === symbol.name);
    const block = { start: symbol.startLine, end: symbol.endLine, lines: lines.slice(symbol.startLine - 1, symbol.endLine) };
    const kept = prev && reuseSection(prev, block, fileHash);
    if (kept) {
      sections.push(kept);
      reused.push(symbol.name);
      options.onProgress?.(`${label}: unchanged, reused`);
      continue;
    }
    if (aborted) {
      failed.push({ symbol: symbol.name, reason: 'skipped after an earlier error' });
      continue;
    }

    try {
      const target = { kind: 'range' as const, file: fileCtx.file, start: symbol.startLine, end: symbol.endLine };
      const ctx = await buildFnContext(store, repoRoot, target, options);
      options.onProgress?.(`${label}: explaining…`);
      sections.push(await generateSection(provider, ctx, repoRoot, { symbol: symbol.name, condensed: true }));
      generated.push(symbol.name);
    } catch (err) {
      if (err instanceof NoVerifiedStepsError || err instanceof TargetError) {
        failed.push({ symbol: symbol.name, reason: err.message });
      } else if (err instanceof LlmRequestError || err instanceof LlmOutputError) {
        // Likely to fail the same way for every function (auth, rate limit): stop asking.
        aborted = err;
        failed.push({ symbol: symbol.name, reason: err.message });
      } else {
        throw err;
      }
    }
  }

  const overview: FileOverview = {
    file: fileCtx.file,
    lineCount: fileCtx.lineCount,
    importers: fileCtx.importers,
    exports: fileCtx.exports.map(summary),
    helpers: fileCtx.helpers.map(summary),
    order: fileCtx.order.map((s) => s.name),
    cycleBreaks: fileCtx.cycleBreaks,
    failed,
  };
  return {
    saved: { version: SAVED_VERSION, scopeKind: 'file', scopeRef: fileCtx.file, model: options.model, overview, sections },
    generated,
    reused,
    aborted,
  };
}

function summary(s: SymbolRecord): SymbolSummary {
  return { name: s.name, kind: s.kind, line: s.startLine };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run core/src/walkthrough/file.test.ts`
Expected: PASS (8 tests).

---

### Task 6: Markdown export and persistence

**Files:**
- Create: `core/src/render/markdown.ts`, `core/src/walkthrough/persist.ts`, `core/src/walkthrough/index.ts`
- Modify: `core/src/index.ts`, `core/src/context/index.ts`
- Test: `core/src/render/markdown.test.ts`, `core/src/walkthrough/persist.test.ts`

**Interfaces:**
- Consumes: `SavedWalkthrough`, `flattenWalkthrough`, `overviewNotes`, `contentHashOf`, `readLines`, `SAVED_VERSION` (Task 3), `Store.saveWalkthrough`, `getWalkthrough`, `listWalkthroughs` (Task 1), `WALKTHROUGH_DIR` (`core/src/config.ts`).
- Produces:
  - `renderMarkdown(saved: SavedWalkthrough, codeLines: (file: string) => string[]): string`
  - `WALKTHROUGHS_DIR` (`.walkthrough/walkthroughs`)
  - `walkthroughSlug(kind: ScopeKind, ref: string): string`
  - `codeReader(repoRoot: string): (file: string) => string[]` (cached; `[]` for missing files)
  - `persistWalkthrough(store, repoRoot, saved): Promise<{ json: string; markdown: string }>` (repo-relative paths)
  - `loadSavedWalkthrough(store, kind: ScopeKind, ref: string): Promise<SavedWalkthrough | null>`
  - `listSavedWalkthroughs(store): Promise<{ saved: SavedWalkthrough; savedAt: Date }[]>`
  - Package exports: everything in `core/src/walkthrough/index.ts`, `renderMarkdown`, `buildFileContext`, `FileContext`, `parseFileTarget`, `walkableSymbols`, `dependencyOrder`.

- [ ] **Step 1: Write the failing tests**

Create `core/src/render/markdown.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sectionFor } from '../walkthrough/__fixtures__/sections.js';
import { SAVED_VERSION, type SavedWalkthrough } from '../walkthrough/saved.js';
import { renderMarkdown } from './markdown.js';

const SOURCE = ['function helper() {', '  return 1;', '}', '', 'function main() {', '  const x = helper();', '  return x + 1;', '}'];
const code = () => SOURCE;

describe('renderMarkdown', () => {
  it('renders a fn walkthrough with numbered code, examples and verification', () => {
    const section = sectionFor(SOURCE, 'a.ts', 'main', 5, 8);
    section.walkthrough.stages[0].steps[1].references = [{ file: 'a.ts', line: 1, role: 'callee' }];
    section.walkthrough.stages[0].steps[1].docLinks = [{ package: 'pg', symbol: 'Pool', version: '8.0.0', url: 'https://node-postgres.com/apis/pool', source: 'curated' }];
    section.walkthrough.unresolved = ['unresolved: likely handlers[name]'];
    const saved: SavedWalkthrough = { version: SAVED_VERSION, scopeKind: 'fn', scopeRef: 'a.ts#main', model: 'm', overview: null, sections: [section] };

    const md = renderMarkdown(saved, code);
    expect(md).toMatch(/^# Walkthrough of main\n\n`a\.ts:5-8`\n\nSummary\./);
    expect(md).toContain('## Body');
    expect(md).toContain('### Step 2 · `a.ts:6-6`');
    expect(md).toContain('```ts\n6 |   const x = helper();\n```');
    expect(md).toContain('**Example:** in  \n**After:** out');
    expect(md).toContain('- callee `a.ts:1`');
    expect(md).toContain('- [pg Pool](https://node-postgres.com/apis/pool)');
    expect(md).toContain('## Verification\n\nVerified: 4 step(s) kept, 0 dropped.');
    expect(md).toContain('## Unresolved\n\n- unresolved: likely handlers[name]');
  });

  it('renders a file walkthrough with its overview and one numbered section per function', () => {
    const saved: SavedWalkthrough = {
      version: SAVED_VERSION,
      scopeKind: 'file',
      scopeRef: 'a.ts',
      model: 'm',
      overview: { file: 'a.ts', lineCount: 8, importers: [], exports: [], helpers: [], order: ['helper', 'main'], cycleBreaks: [], failed: [] },
      sections: [sectionFor(SOURCE, 'a.ts', 'helper', 1, 3), sectionFor(SOURCE, 'a.ts', 'main', 5, 8)],
    };
    const md = renderMarkdown(saved, code);
    expect(md).toContain('# How a.ts works\n\n## Overview\n\n- Imported by: no indexed file');
    expect(md).toContain('- Walk order (helpers first): helper → main');
    expect(md).toContain('## 1. helper (`a.ts:1-3`)');
    expect(md).toContain('## 2. main (`a.ts:5-8`)');
    expect(md).toContain('#### Step 1 · `a.ts:5-5`');
    expect(md).toContain('Verified: 7 step(s) kept, 0 dropped.');
  });
});
```

Create `core/src/walkthrough/persist.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../store/index.js';
import { sectionFor } from './__fixtures__/sections.js';
import { listSavedWalkthroughs, loadSavedWalkthrough, persistWalkthrough, walkthroughSlug } from './persist.js';
import { SAVED_VERSION, type SavedWalkthrough } from './saved.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const SOURCE = ['function main() {', '  return 1;', '}'];

describe('persistence', () => {
  let repo: string;
  let store: Store;
  const saved = (summary = 'Summary.'): SavedWalkthrough => {
    const section = sectionFor(SOURCE, 'api/a.ts', 'main', 1, 3);
    section.walkthrough.summary = summary;
    return { version: SAVED_VERSION, scopeKind: 'fn', scopeRef: 'api/a.ts#main', model: 'm', overview: null, sections: [section] };
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-persist-'));
    mkdirSync(join(repo, 'api'));
    writeFileSync(join(repo, 'api', 'a.ts'), `${SOURCE.join('\n')}\n`);
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_persist_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('makes readable, collision-free file names', () => {
    expect(walkthroughSlug('fn', 'api/a.ts#main')).toMatch(/^fn--api_a\.ts_main--[0-9a-f]{8}$/);
    // Both sanitize to "api_a.ts_main"; the hash suffix keeps them apart.
    expect(walkthroughSlug('fn', 'api/a.ts#main')).not.toBe(walkthroughSlug('fn', 'api_a.ts_main'));
  });

  it('saves to Postgres and mirrors JSON + Markdown under .walkthrough/walkthroughs', async () => {
    const paths = await persistWalkthrough(store, repo, saved());
    expect(paths.json).toMatch(/^\.walkthrough\/walkthroughs\/fn--api_a\.ts_main--[0-9a-f]{8}\.json$/);
    expect(JSON.parse(readFileSync(join(repo, paths.json), 'utf8'))).toEqual(saved());
    expect(readFileSync(join(repo, paths.markdown), 'utf8')).toContain('1 | function main() {');
    expect(await loadSavedWalkthrough(store, 'fn', 'api/a.ts#main')).toEqual(saved());
  });

  it('replaces the previous save of the same scope', async () => {
    await persistWalkthrough(store, repo, saved('Second.'));
    const all = await listSavedWalkthroughs(store);
    expect(all).toHaveLength(1);
    expect(all[0].saved.sections[0].walkthrough.summary).toBe('Second.');
    expect(all[0].savedAt).toBeInstanceOf(Date);
  });

  it('ignores content saved in an older format', async () => {
    await store.saveWalkthrough({ scopeKind: 'fn', scopeRef: 'api/old.ts#f', contentHash: 'x', content: { version: 0 } });
    expect(await loadSavedWalkthrough(store, 'fn', 'api/old.ts#f')).toBeNull();
    expect((await listSavedWalkthroughs(store)).map((e) => e.saved.scopeRef)).toEqual(['api/a.ts#main']);
    expect(existsSync(join(repo, '.walkthrough', 'walkthroughs'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run core/src/render/markdown.test.ts core/src/walkthrough/persist.test.ts`
Expected: FAIL with `Failed to load url ./markdown.js` and `./persist.js`.

- [ ] **Step 3: Implement Markdown rendering**

Create `core/src/render/markdown.ts`:

````ts
import type { FnWalkthrough, WalkthroughStep } from '../walkthrough/fn.js';
import { flattenWalkthrough, overviewNotes, type SavedWalkthrough } from '../walkthrough/saved.js';

// Markdown export (CLAUDE.md §9): saved next to the JSON in .walkthrough/walkthroughs/ and printed
// by `--out md`. Code snippets come from the current source, which matches the saved line numbers.

export function renderMarkdown(saved: SavedWalkthrough, codeLines: (file: string) => string[]): string {
  const out: string[] = [];
  if (saved.scopeKind === 'fn') {
    const w = saved.sections[0].walkthrough;
    out.push(`# ${w.title}`, '', `\`${location(w)}\``, '', w.summary);
    renderStages(out, w, 2, codeLines);
  } else {
    const o = saved.overview!;
    out.push(`# How ${o.file} works`, '', '## Overview', '', ...overviewNotes(o).map((n) => `- ${n}`));
    saved.sections.forEach((s, i) => {
      const w = s.walkthrough;
      out.push('', `## ${i + 1}. ${s.block.symbol ?? 'block'} (\`${location(w)}\`)`, '', w.summary);
      renderStages(out, w, 3, codeLines);
    });
  }
  renderFooter(out, flattenWalkthrough(saved));
  return `${out.join('\n')}\n`;
}

function renderStages(out: string[], w: FnWalkthrough, level: number, codeLines: (file: string) => string[]) {
  const h = '#'.repeat(level);
  let n = 0;
  for (const stage of w.stages) {
    out.push('', `${h} ${stage.name}`);
    for (const step of stage.steps) {
      n++;
      const { file, start, end } = step.code_ref;
      out.push('', `${h}# Step ${n} · \`${file}:${start}-${end}\``, '', fence(file, start, end, codeLines(file)), '', ...stepBody(step));
    }
  }
}

function stepBody(step: WalkthroughStep): string[] {
  const out = [step.explanation, '', `**Example:** ${step.example.input}  `, `**After:** ${step.example.state_after}`];
  if (step.references.length) out.push('', '**References**', ...step.references.map((r) => `- ${r.role} \`${r.file}:${r.line}\``));
  if (step.docLinks.length) out.push('', '**Docs**', ...step.docLinks.map((d) => `- [${d.package} ${d.symbol}](${d.url})`));
  if (step.concepts.length) out.push('', `**Concepts:** ${step.concepts.join(' · ')}`);
  if (step.risks.length) out.push('', '**Risks**', ...step.risks.map((r) => `- ${r}`));
  return out;
}

function renderFooter(out: string[], w: FnWalkthrough) {
  const v = w.verification;
  out.push('', '## Verification', '', `Verified: ${v.keptSteps} step(s) kept, ${v.dropped.length} dropped.`);
  for (const d of v.dropped) out.push(`- dropped ${d.stepId}: ${d.reasons.join('; ')}`);
  if (w.unresolved.length) out.push('', '## Unresolved', '', ...w.unresolved.map((u) => `- ${u}`));
}

function fence(file: string, start: number, end: number, lines: string[]): string {
  const width = String(end).length;
  const body = lines.slice(start - 1, end).map((line, i) => `${String(start + i).padStart(width)} | ${line}`);
  return ['```' + (file.endsWith('.tsx') ? 'tsx' : 'ts'), ...body, '```'].join('\n');
}

const location = (w: FnWalkthrough) => `${w.scope.file}:${w.scope.start}-${w.scope.end}`;
````

- [ ] **Step 4: Implement persistence**

Create `core/src/walkthrough/persist.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WALKTHROUGH_DIR } from '../config.js';
import { renderMarkdown } from '../render/markdown.js';
import type { Store } from '../store/index.js';
import { contentHashOf, readLines, SAVED_VERSION, type SavedWalkthrough, type ScopeKind } from './saved.js';

// Postgres (`walkthroughs`) is the source of truth for caching and `walk list`. Every save is also
// mirrored to .walkthrough/walkthroughs/<slug>.json and .md for reading and sharing (CLAUDE.md §9).

export const WALKTHROUGHS_DIR = join(WALKTHROUGH_DIR, 'walkthroughs');

/** A readable file name; the hash suffix keeps refs that sanitize alike from colliding. */
export function walkthroughSlug(kind: ScopeKind, ref: string): string {
  const readable = ref.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const id = createHash('sha256').update(`${kind}:${ref}`).digest('hex').slice(0, 8);
  return `${kind}--${readable}--${id}`;
}

/** Reads repo files once each; a missing file reads as no lines. */
export function codeReader(repoRoot: string): (file: string) => string[] {
  const cache = new Map<string, string[]>();
  return (file) => {
    if (!cache.has(file)) cache.set(file, readLines(repoRoot, file) ?? []);
    return cache.get(file)!;
  };
}

/** Saves to Postgres and writes the JSON + Markdown mirror. Returns the mirror paths, repo-relative. */
export async function persistWalkthrough(store: Store, repoRoot: string, saved: SavedWalkthrough): Promise<{ json: string; markdown: string }> {
  await store.saveWalkthrough({ scopeKind: saved.scopeKind, scopeRef: saved.scopeRef, contentHash: contentHashOf(saved.sections), content: saved });
  mkdirSync(join(repoRoot, WALKTHROUGHS_DIR), { recursive: true });
  const base = join(WALKTHROUGHS_DIR, walkthroughSlug(saved.scopeKind, saved.scopeRef));
  const paths = { json: `${base}.json`, markdown: `${base}.md` };
  writeFileSync(join(repoRoot, paths.json), `${JSON.stringify(saved, null, 2)}\n`);
  writeFileSync(join(repoRoot, paths.markdown), renderMarkdown(saved, codeReader(repoRoot)));
  return paths;
}

export async function loadSavedWalkthrough(store: Store, kind: ScopeKind, ref: string): Promise<SavedWalkthrough | null> {
  const record = await store.getWalkthrough(kind, ref);
  return record ? asSaved(record.content) : null;
}

export async function listSavedWalkthroughs(store: Store): Promise<{ saved: SavedWalkthrough; savedAt: Date }[]> {
  return (await store.listWalkthroughs()).flatMap((r) => {
    const saved = asSaved(r.content);
    return saved ? [{ saved, savedAt: r.createdAt }] : [];
  });
}

/** Content saved by an older, incompatible format is treated as never generated. */
function asSaved(content: unknown): SavedWalkthrough | null {
  const version = typeof content === 'object' && content !== null ? (content as { version?: unknown }).version : undefined;
  return version === SAVED_VERSION ? (content as SavedWalkthrough) : null;
}
```

- [ ] **Step 5: Wire up exports**

Create `core/src/walkthrough/index.ts`:

```ts
export { explainFn, NoVerifiedStepsError, type FnWalkthrough, type WalkthroughStep } from './fn.js';
export { explainFile, type ExplainFileOptions, type ExplainFileResult } from './file.js';
export { generateSection, reuseSection } from './section.js';
export * from './persist.js';
export * from './saved.js';
export * from './staleness.js';
```

In `core/src/index.ts`, replace the line `export { explainFn, NoVerifiedStepsError, type FnWalkthrough, type WalkthroughStep } from './walkthrough/fn.js';` with:

```ts
export * from './walkthrough/index.js';
export { renderMarkdown } from './render/markdown.js';
```

Replace `core/src/context/index.ts` with:

```ts
export * from './fn.js';
export * from './file.js';
export * from './order.js';
export { parseFileTarget, parseFnTarget, TargetError, type FnTarget } from './target.js';
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm vitest run core/src && pnpm --filter @codewalk/core typecheck`
Expected: all core tests PASS; typecheck reports no errors.

---

### Task 7: CLI `walk fn` caches, saves, and prints Markdown

**Files:**
- Modify: `cli/src/commands/shared.ts`, `cli/src/commands/fn.ts`, `cli/src/ui/format.ts`, `cli/src/ui/Stepper.tsx`, `cli/src/index.ts`
- Test: `cli/src/commands/fn.test.ts`, `cli/src/ui/Stepper.test.tsx`

**Interfaces:**
- Consumes: `fnScopeRef`, `loadSavedWalkthrough`, `reuseSection`, `generateSection`, `persistWalkthrough`, `flattenWalkthrough`, `renderMarkdown`, `codeReader`, `hashFile`, `SAVED_VERSION`.
- Produces:
  - `reportError(err: unknown, io: IO): number` in `shared.ts`. It replaces the private `fail` in `fn.ts` and keeps the same behaviour.
  - `FnOptions` gains `out: 'terminal' | 'json' | 'md'` and `refresh: boolean`.
  - `formatWalkthrough(w, codeLines, notes: string[] = [])`.
  - `StepperProps.notes?: string[]`, `Overview({ walkthrough, notes })`.

- [ ] **Step 1: Write the failing tests**

In `cli/src/commands/fn.test.ts`:

1. Add `readdirSync` to the `node:fs` import.
2. Change the `opts` helper to `({ llm: true, depth: 2, out: 'terminal', refresh: false, ...o })`.
3. In `'reports LLM failures'`, pass `opts({ refresh: true })`, because otherwise the saved walkthrough would be reused.
4. Append these tests inside the `describe`:

```ts
  it('reuses the saved walkthrough when the code is unchanged', async () => {
    const { io, err } = captureIO();
    const unused: LlmProvider = { generate: async () => { throw new Error('should not be called'); } };
    expect(await runFn(repo, TARGET, opts(), io, { provider: unused, interactive: false })).toBe(0);
    expect(err.join('\n')).toContain('showing the saved walkthrough');
  });

  it('--refresh regenerates even when the code is unchanged', async () => {
    let calls = 0;
    const counting: LlmProvider = { generate: async () => { calls++; return RECORDED; } };
    expect(await runFn(repo, TARGET, opts({ refresh: true, out: 'json' }), captureIO().io, { provider: counting })).toBe(0);
    expect(calls).toBe(1);
  });

  it('--out md prints Markdown, and the walkthrough is mirrored to .walkthrough/walkthroughs', async () => {
    const { io, out, err } = captureIO();
    expect(await runFn(repo, TARGET, opts({ out: 'md' }), io, { provider: recorded })).toBe(0);
    const md = out.join('\n');
    expect(md).toMatch(/^# /);
    expect(md).toContain('```ts\n36 | ');
    expect(err.join('\n')).toMatch(/Saved \.walkthrough\/walkthroughs\/fn--api_services_enrollService\.ts_enrollPatient--[0-9a-f]{8}\.md/);
    const files = readdirSync(join(repo, '.walkthrough', 'walkthroughs'));
    expect(files.filter((f) => f.startsWith('fn--')).map((f) => f.split('.').pop()).sort()).toEqual(['json', 'md']);
  });
```

In `cli/src/ui/Stepper.test.tsx`, append inside `describe('Stepper')`:

```tsx
  it('renders overview notes under the summary', () => {
    const text = renderToString(<Overview walkthrough={walkthrough} notes={['Imported by: api/y.ts (normalize)']} />, { columns: 100 });
    expect(text).toContain('Imported by: api/y.ts (normalize)');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run cli/src/commands/fn.test.ts cli/src/ui/Stepper.test.tsx`
Expected: FAIL. `'reuses the saved walkthrough…'` fails with exit code 1 and "should not be called", the md test fails because `md` isn't handled, and the Stepper test fails because `notes` aren't rendered.

- [ ] **Step 3: Move error reporting to `shared.ts`**

In `cli/src/commands/shared.ts`, add `LlmOutputError`, `LlmRequestError`, `NoVerifiedStepsError` and `TargetError` to the `@codewalk/core` import, and append:

```ts
/** Prints known, user-fixable errors and returns 1; anything else is a bug and is rethrown. */
export function reportError(err: unknown, io: IO): number {
  if (err instanceof TargetError || err instanceof LlmRequestError || err instanceof LlmOutputError) {
    io.error(`✖ ${err.message}`);
    return 1;
  }
  if (err instanceof NoVerifiedStepsError) {
    io.error(`✖ ${err.message}`);
    for (const d of err.dropped) io.error(`  ${d.stepId}: ${d.reasons.join('; ')}`);
    return 1;
  }
  throw err;
}
```

- [ ] **Step 4: Rewrite `cli/src/commands/fn.ts`**

Replace the whole file with:

```ts
import { createElement } from 'react';
import { render } from 'ink';
import {
  AnthropicProvider,
  buildFnContext,
  codeReader,
  flattenWalkthrough,
  fnScopeRef,
  generateSection,
  hashFile,
  indexRepo,
  loadSavedWalkthrough,
  parseFnTarget,
  persistWalkthrough,
  renderMarkdown,
  reuseSection,
  SAVED_VERSION,
  type LlmProvider,
  type SavedWalkthrough,
} from '@codewalk/core';
import { Stepper } from '../ui/Stepper.js';
import { formatFacts, formatWalkthrough } from '../ui/format.js';
import { connectStore, loadRepo, reportError, type IO } from './shared.js';

export interface FnOptions {
  /** False with --no-llm: print only the static facts. */
  llm: boolean;
  depth: number;
  out: 'terminal' | 'json' | 'md';
  /** Ignore the saved walkthrough and regenerate (--refresh). */
  refresh: boolean;
}

export interface FnDeps {
  /** Overrides the configured Anthropic provider (tests use recorded responses). */
  provider?: LlmProvider;
  /** Use the Ink stepper; defaults to true when stdin and stdout are terminals. */
  interactive?: boolean;
}

/** `walk fn <file>#<symbol> | <file>:<start>-<end>`. Returns an exit code. */
export async function runFn(cwd: string, targetArg: string, options: FnOptions, io: IO, deps: FnDeps = {}): Promise<number> {
  let target;
  try {
    target = parseFnTarget(targetArg);
  } catch (err) {
    return reportError(err, io);
  }

  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;

  let saved: SavedWalkthrough;
  try {
    // Facts first: bring the index up to date (a no-op when nothing changed).
    await store.migrate();
    await indexRepo(repo.repoRoot, repo.config, store);

    const ctx = await buildFnContext(store, repo.repoRoot, target, {
      depth: options.depth,
      maxContextTokens: repo.config.llm.maxContextTokens,
    });
    for (const warning of ctx.warnings) io.error(`! ${warning}`);

    if (!options.llm) {
      io.log(options.out === 'json' ? JSON.stringify(ctx, null, 2) : formatFacts(ctx));
      return 0;
    }

    // Cached by the content of the explained code (CLAUDE.md §9): unchanged code is not re-sent.
    const scopeRef = fnScopeRef(target);
    const previous = options.refresh ? null : await loadSavedWalkthrough(store, 'fn', scopeRef);
    const current = { start: ctx.target.start, end: ctx.target.end, lines: ctx.target.code.lines };
    let section = previous && reuseSection(previous.sections[0], current, (f) => hashFile(repo.repoRoot, f));
    if (section) {
      io.error(`Code unchanged since ${section.generatedAt}: showing the saved walkthrough (--refresh to regenerate).`);
    } else {
      io.error(`Explaining ${ctx.target.file}:${ctx.target.start}-${ctx.target.end} with ${repo.config.llm.model}…`);
      const provider = deps.provider ?? new AnthropicProvider(repo.config.llm.model);
      section = await generateSection(provider, ctx, repo.repoRoot, { symbol: target.kind === 'symbol' ? target.name : null });
    }
    saved = { version: SAVED_VERSION, scopeKind: 'fn', scopeRef, model: repo.config.llm.model, overview: null, sections: [section] };
    const paths = await persistWalkthrough(store, repo.repoRoot, saved);
    io.error(`Saved ${paths.markdown}`);
  } catch (err) {
    return reportError(err, io);
  } finally {
    await store.close();
  }

  const codeLines = codeReader(repo.repoRoot);
  const walkthrough = flattenWalkthrough(saved);
  if (options.out === 'json') {
    io.log(JSON.stringify(walkthrough, null, 2));
  } else if (options.out === 'md') {
    io.log(renderMarkdown(saved, codeLines));
  } else if (deps.interactive ?? (process.stdin.isTTY && process.stdout.isTTY)) {
    const app = render(createElement(Stepper, { walkthrough, codeLines }));
    await app.waitUntilExit();
  } else {
    io.log(formatWalkthrough(walkthrough, codeLines));
  }
  return 0;
}
```

- [ ] **Step 5: Overview notes in the plain-text format and the stepper**

In `cli/src/ui/format.ts`, change `formatWalkthrough`'s signature and first line to:

```ts
export function formatWalkthrough(w: FnWalkthrough, codeLines: (file: string) => string[], notes: string[] = []): string {
  const out: string[] = [w.title, '', w.summary];
  if (notes.length) out.push('', ...notes);
```

In `cli/src/ui/Stepper.tsx`:

- Add to `StepperProps`: `/** Extra overview lines, e.g. a file's importers and exports. */ notes?: string[];`
- Change `export function Stepper({ walkthrough, codeLines }: StepperProps)` to `export function Stepper({ walkthrough, codeLines, notes = [] }: StepperProps)` and `<Overview walkthrough={walkthrough} />` to `<Overview walkthrough={walkthrough} notes={notes} />`.
- Change `export function Overview({ walkthrough: w }: { walkthrough: FnWalkthrough })` to `export function Overview({ walkthrough: w, notes = [] }: { walkthrough: FnWalkthrough; notes?: string[] })` and insert directly after the summary `<Box marginTop={1}>…</Box>`:

```tsx
      {notes.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {notes.map((n, i) => (
            <Text key={i} dimColor>
              {n}
            </Text>
          ))}
        </Box>
      )}
```

- [ ] **Step 6: Register the new flags**

In `cli/src/index.ts`, replace the `fn` command definition with:

```ts
program
  .command('fn')
  .description('walkthrough of a function (<file>#<symbolName>) or a line range (<file>:<startLine>-<endLine>)')
  .argument('<target>', 'e.g. api/services/enrollService.ts#enrollPatient or api/app.ts:10-24')
  .option('--no-llm', 'print only the static facts')
  .option('--depth <n>', 'how many levels of callees to include', parseDepth, 2)
  .option('--refresh', 'ignore the saved walkthrough and regenerate', false)
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json', 'md']).default('terminal'))
  .action(async (target: string, opts: FnOptions) => {
    process.exitCode = await runFn(process.cwd(), target, opts, io);
  });
```

and change the import to `import { runFn, type FnOptions } from './commands/fn.js';`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run cli/src`
Expected: PASS (all existing CLI tests plus the four new ones).

---

### Task 8: CLI `walk file`

**Files:**
- Create: `cli/src/commands/file.ts`
- Modify: `cli/src/ui/format.ts` (add `formatFileFacts`), `cli/src/index.ts`
- Test: `cli/src/commands/file.test.ts`

**Interfaces:**
- Consumes: `parseFileTarget`, `buildFileContext`, `FileContext`, `explainFile`, `loadSavedWalkthrough`, `persistWalkthrough`, `flattenWalkthrough`, `overviewNotes`, `renderMarkdown`, `codeReader`, `createLineStubProvider` (tests), `reportError`, `formatWalkthrough(…, notes)`, `Stepper` `notes`.
- Produces:
  - `interface FileOptions { llm: boolean; depth: number; out: 'terminal' | 'json' | 'md'; refresh: boolean }`
  - `runFile(cwd: string, fileArg: string, options: FileOptions, io: IO, deps?: FnDeps): Promise<number>`. It exits 1 when any function failed, and still prints and saves the partial walkthrough.
  - `formatFileFacts(ctx: FileContext): string`
  - `--out json` prints the full `SavedWalkthrough` (overview + sections).

- [ ] **Step 1: Write the failing tests**

Create `cli/src/commands/file.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, createLineStubProvider, openStore } from '@codewalk/core';
import { runFile, type FileOptions } from './file.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const SERVICE = 'api/services/enrollService.ts';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) }, out, err };
}

const opts = (o: Partial<FileOptions> = {}): FileOptions => ({ llm: true, depth: 2, out: 'terminal', refresh: false, ...o });

describe('walk file', () => {
  let repo: string;
  let schema: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-file-cli-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_filecli_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  });

  afterAll(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('--no-llm prints the role, export map and helpers-first order', async () => {
    const { io, out } = captureIO();
    expect(await runFile(repo, SERVICE, opts({ llm: false }), io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`file ${SERVICE} — 81 lines`);
    expect(text).toContain('Imported by\n  api/controllers/patientsController.ts  (enrollPatient, getPatient)');
    expect(text).toContain(`Walk order (helpers first)\n  1. normalizePhone  ${SERVICE}:17-20\n  2. calculateAge`);
  });

  it('explains each function, saves, and reuses everything on the next run', async () => {
    const stub = createLineStubProvider();
    const first = captureIO();
    expect(await runFile(repo, SERVICE, opts(), first.io, { provider: stub, interactive: false })).toBe(0);
    expect(stub.targets).toHaveLength(4);
    const text = first.out.join('\n');
    expect(text).toContain(`How ${SERVICE} works`);
    expect(text).toContain('Walk order (helpers first): normalizePhone → calculateAge → enrollPatient → getPatient');
    expect(text).toContain('== normalizePhone · Body ==');
    expect(first.err.join('\n')).toMatch(/Saved \.walkthrough\/walkthroughs\/file--.*\.md \(4 generated, 0 reused\)/);

    const again = createLineStubProvider();
    const second = captureIO();
    expect(await runFile(repo, SERVICE, opts({ out: 'json' }), second.io, { provider: again })).toBe(0);
    expect(again.targets).toEqual([]);
    expect(second.err.join('\n')).toContain('(0 generated, 4 reused)');
    expect(JSON.parse(second.out.join('\n')).overview.order).toHaveLength(4);
  });

  it('--out md prints one section per function', async () => {
    const { io, out } = captureIO();
    expect(await runFile(repo, SERVICE, opts({ out: 'md' }), io, { provider: createLineStubProvider() })).toBe(0);
    expect(out.join('\n')).toContain(`## 1. normalizePhone (\`${SERVICE}:17-20\`)`);
  });

  it('handles a file without functions without calling the LLM', async () => {
    const stub = createLineStubProvider();
    const { io, out } = captureIO();
    expect(await runFile(repo, 'web/types.ts', opts(), io, { provider: stub, interactive: false })).toBe(0);
    expect(stub.targets).toEqual([]);
    expect(out.join('\n')).toContain('Walk order (helpers first): no functions');
  });

  it('reports a file that is not indexed, or a fn-style target', async () => {
    const missing = captureIO();
    expect(await runFile(repo, 'api/nope.ts', opts(), missing.io)).toBe(1);
    expect(missing.err[0]).toMatch(/^✖ api\/nope\.ts is not in the index/);

    const fnStyle = captureIO();
    expect(await runFile(repo, `${SERVICE}#enrollPatient`, opts(), fnStyle.io)).toBe(1);
    expect(fnStyle.err[0]).toMatch(/use `walk fn/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run cli/src/commands/file.test.ts`
Expected: FAIL with `Failed to load url ./file.js`.

- [ ] **Step 3: Add `formatFileFacts`**

In `cli/src/ui/format.ts`, add `FileContext` to the `import type { ... } from '@codewalk/core'` list and add after `formatFacts`:

```ts
export function formatFileFacts(ctx: FileContext): string {
  const out = [`file ${ctx.file} — ${ctx.lineCount} lines`];
  section(out, 'Imported by', ctx.importers.map((i) => `${i.file}${i.importedNames.length ? `  (${i.importedNames.join(', ')})` : ''}`));
  section(out, 'Exports', ctx.exports.map((s) => `${s.kind} ${s.name}  ${s.file}:${s.startLine}`));
  section(out, 'Internal helpers', ctx.helpers.map((s) => `${s.kind} ${s.name}  ${s.file}:${s.startLine}`));
  section(out, 'Walk order (helpers first)', ctx.order.map((s, i) => `${i + 1}. ${s.name}  ${s.file}:${s.startLine}-${s.endLine}`));
  section(out, 'Call cycles', ctx.cycleBreaks);
  section(out, 'Warnings', ctx.warnings);
  return out.join('\n');
}
```

- [ ] **Step 4: Implement the command**

Create `cli/src/commands/file.ts`:

```ts
import { createElement } from 'react';
import { render } from 'ink';
import {
  AnthropicProvider,
  buildFileContext,
  codeReader,
  explainFile,
  flattenWalkthrough,
  indexRepo,
  loadSavedWalkthrough,
  overviewNotes,
  parseFileTarget,
  persistWalkthrough,
  renderMarkdown,
  type SavedWalkthrough,
} from '@codewalk/core';
import { Stepper } from '../ui/Stepper.js';
import { formatFileFacts, formatWalkthrough } from '../ui/format.js';
import type { FnDeps } from './fn.js';
import { connectStore, loadRepo, reportError, type IO } from './shared.js';

export interface FileOptions {
  /** False with --no-llm: print only the static facts. */
  llm: boolean;
  depth: number;
  out: 'terminal' | 'json' | 'md';
  /** Ignore saved sections and regenerate every function (--refresh). */
  refresh: boolean;
}

/** `walk file <file>`: every function, helpers first. Returns an exit code (1 if any function failed). */
export async function runFile(cwd: string, fileArg: string, options: FileOptions, io: IO, deps: FnDeps = {}): Promise<number> {
  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;

  let saved: SavedWalkthrough;
  try {
    await store.migrate();
    await indexRepo(repo.repoRoot, repo.config, store);

    const fileCtx = await buildFileContext(store, repo.repoRoot, parseFileTarget(fileArg));
    for (const warning of fileCtx.warnings) io.error(`! ${warning}`);
    if (!options.llm) {
      io.log(options.out === 'json' ? JSON.stringify(fileCtx, null, 2) : formatFileFacts(fileCtx));
      return 0;
    }

    const { model, maxContextTokens } = repo.config.llm;
    const previous = options.refresh ? null : await loadSavedWalkthrough(store, 'file', fileCtx.file);
    const provider = deps.provider ?? new AnthropicProvider(model);
    io.error(`Explaining ${fileCtx.order.length} function(s) in ${fileCtx.file} with ${model}…`);
    const result = await explainFile(store, provider, repo.repoRoot, fileCtx, previous, {
      depth: options.depth,
      maxContextTokens,
      model,
      refresh: options.refresh,
      onProgress: (line) => io.error(`  ${line}`),
    });
    saved = result.saved;
    const paths = await persistWalkthrough(store, repo.repoRoot, saved);
    io.error(`Saved ${paths.markdown} (${result.generated.length} generated, ${result.reused.length} reused)`);
    for (const f of saved.overview!.failed) io.error(`✖ ${f.symbol}: ${f.reason}`);
  } catch (err) {
    return reportError(err, io);
  } finally {
    await store.close();
  }

  const codeLines = codeReader(repo.repoRoot);
  const walkthrough = flattenWalkthrough(saved);
  const notes = overviewNotes(saved.overview!);
  if (options.out === 'json') {
    io.log(JSON.stringify(saved, null, 2));
  } else if (options.out === 'md') {
    io.log(renderMarkdown(saved, codeLines));
  } else if (deps.interactive ?? (process.stdin.isTTY && process.stdout.isTTY)) {
    const app = render(createElement(Stepper, { walkthrough, codeLines, notes }));
    await app.waitUntilExit();
  } else {
    io.log(formatWalkthrough(walkthrough, codeLines, notes));
  }
  return saved.overview!.failed.length > 0 ? 1 : 0;
}
```

- [ ] **Step 5: Register the command**

In `cli/src/index.ts`, add `import { runFile, type FileOptions } from './commands/file.js';` and, after the `fn` command:

```ts
program
  .command('file')
  .description('walkthrough of a whole file: every function, helpers first')
  .argument('<file>', 'e.g. api/services/enrollService.ts')
  .option('--no-llm', 'print only the static facts')
  .option('--depth <n>', 'how many levels of callees to include per function', parseDepth, 2)
  .option('--refresh', 'ignore saved walkthroughs and regenerate every function', false)
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json', 'md']).default('terminal'))
  .action(async (file: string, opts: FileOptions) => {
    process.exitCode = await runFile(process.cwd(), file, opts, io);
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run cli/src/commands/file.test.ts`
Expected: PASS (5 tests).

---

### Task 9: CLI `walk list` and the Phase 2 acceptance test

**Files:**
- Create: `cli/src/commands/list.ts`
- Modify: `cli/src/ui/format.ts` (add `ListRow`, `formatList`), `cli/src/index.ts`
- Test: `cli/src/commands/list.test.ts`

**Interfaces:**
- Consumes: `listSavedWalkthroughs`, `loadCurrentSource`, `filesOf`, `checkWalkthrough`, `WalkthroughStatus`, `ScopeKind`, `runFile` (Task 8), `runFn` (Task 7), `createLineStubProvider`.
- Produces:
  - `interface ListRow { scopeKind: ScopeKind; scopeRef: string; savedAt: Date; status: WalkthroughStatus }`
  - `formatList(rows: ListRow[]): string`
  - `interface ListOptions { out: 'terminal' | 'json' }`, `runList(cwd: string, options: ListOptions, io: IO): Promise<number>`

- [ ] **Step 1: Write the failing acceptance test**

Create `cli/src/commands/list.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, createLineStubProvider, openStore, type LlmProvider } from '@codewalk/core';
import type { ListRow } from '../ui/format.js';
import { runFile } from './file.js';
import { runFn } from './fn.js';
import { runList } from './list.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const SERVICE = 'api/services/enrollService.ts';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) }, out, err };
}

// Phase 2 acceptance (CLAUDE.md §12): editing one function marks only the affected steps stale.
describe('walk list', () => {
  let repo: string;
  let schema: string;
  const fileOpts = { llm: true, depth: 2, out: 'json' as const, refresh: false };
  const editService = (change: (text: string) => string) => writeFileSync(join(repo, SERVICE), change(readFileSync(join(repo, SERVICE), 'utf8')));
  const list = async () => {
    const { io, out } = captureIO();
    expect(await runList(repo, { out: 'terminal' }, io)).toBe(0);
    return out.join('\n');
  };
  const rows = async () => {
    const { io, out } = captureIO();
    expect(await runList(repo, { out: 'json' }, io)).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as ListRow[];
    return { file: parsed.find((r) => r.scopeKind === 'file')!, fn: parsed.find((r) => r.scopeKind === 'fn')! };
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-list-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_list_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  });

  afterAll(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('says how to start when nothing is saved', async () => {
    expect(await list()).toBe('No saved walkthroughs yet. Run `walk fn` or `walk file` to create one.');
  });

  it('shows fresh walkthroughs after generating them', async () => {
    const stub = createLineStubProvider();
    expect(await runFile(repo, SERVICE, fileOpts, captureIO().io, { provider: stub })).toBe(0);
    expect(await runFn(repo, `${SERVICE}#enrollPatient`, fileOpts, captureIO().io, { provider: stub })).toBe(0);

    const text = await list();
    expect(text).toMatch(/^fresh {2}file {2}api\/services\/enrollService\.ts\s+61 steps · saved \d{4}-\d\d-\d\d \d\d:\d\d$/m);
    expect(text).toMatch(/^fresh {2}fn {4}api\/services\/enrollService\.ts#enrollPatient\s+35 steps · saved /m);
  });

  it('editing one line of normalizePhone marks only that step stale', async () => {
    editService((t) => t.replace("phone.replace(/\\D/g, '')", "phone.replace(/[^0-9]/g, '')"));

    const { file, fn } = await rows();
    expect(file.status).toMatchObject({ fresh: false, staleSteps: 1, totalSteps: 61, uncovered: [] });
    expect(file.status.sections.map((s) => [s.symbol, s.state])).toEqual([
      ['normalizePhone', 'changed'],
      ['calculateAge', 'fresh'],
      ['enrollPatient', 'fresh'],
      ['getPatient', 'fresh'],
    ]);
    expect(file.status.sections[0].steps.filter((s) => !s.fresh).map((s) => s.start)).toEqual([18]);
    expect(fn.status).toMatchObject({ fresh: true, staleSteps: 0, totalSteps: 35 });

    expect(await list()).toMatch(/^stale {2}file {2}api\/services\/enrollService\.ts\s+1\/61 steps stale · changed: normalizePhone · saved /m);
  });

  it('a line added above every function moves them without making them stale', async () => {
    editService((t) => `// enrollment service\n${t}`);
    const { file, fn } = await rows();
    expect(file.status).toMatchObject({ staleSteps: 1, totalSteps: 61 });
    expect(file.status.sections.filter((s) => s.state !== 'fresh').map((s) => s.symbol)).toEqual(['normalizePhone']);
    expect(fn.status.fresh).toBe(true);
    expect(fn.status.sections[0].current).toEqual({ start: 36, end: 70 });
  });

  it('walk file regenerates only the stale function, and everything is fresh again', async () => {
    const stub = createLineStubProvider();
    expect(await runFile(repo, SERVICE, fileOpts, captureIO().io, { provider: stub })).toBe(0);
    expect(stub.targets).toEqual([`${SERVICE}:18-21`]);

    const unused: LlmProvider = { generate: async () => { throw new Error('should not be called'); } };
    const { io, out } = captureIO();
    expect(await runFn(repo, `${SERVICE}#enrollPatient`, fileOpts, io, { provider: unused })).toBe(0);
    expect(JSON.parse(out.join('\n')).stages[0].steps[0].code_ref.start).toBe(36);

    const { file, fn } = await rows();
    expect(file.status.fresh).toBe(true);
    expect(fn.status.fresh).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run cli/src/commands/list.test.ts`
Expected: FAIL with `Failed to load url ./list.js`.

- [ ] **Step 3: Add `formatList`**

In `cli/src/ui/format.ts`, add `ScopeKind` and `WalkthroughStatus` to the `import type { ... } from '@codewalk/core'` list and append:

```ts
export interface ListRow {
  scopeKind: ScopeKind;
  scopeRef: string;
  savedAt: Date;
  status: WalkthroughStatus;
}

export function formatList(rows: ListRow[]): string {
  if (rows.length === 0) return 'No saved walkthroughs yet. Run `walk fn` or `walk file` to create one.';
  const width = Math.max(...rows.map((r) => r.scopeRef.length));
  return rows
    .map((r) => {
      const s = r.status;
      const detail = s.fresh ? `${s.totalSteps} steps` : staleDetail(s);
      const saved = new Date(r.savedAt).toISOString().slice(0, 16).replace('T', ' ');
      return `${s.fresh ? 'fresh' : 'stale'}  ${r.scopeKind.padEnd(4)}  ${r.scopeRef.padEnd(width)}  ${detail} · saved ${saved}`;
    })
    .join('\n');
}

function staleDetail(s: WalkthroughStatus): string {
  const label = (x: WalkthroughStatus['sections'][number]) => x.symbol ?? `${x.file} lines`;
  const changed = s.sections.filter((x) => x.state === 'changed').map(label);
  const removed = s.sections.filter((x) => x.state === 'missing').map(label);
  const parts = [`${s.staleSteps}/${s.totalSteps} steps stale`];
  if (changed.length) parts.push(`changed: ${changed.join(', ')}`);
  if (removed.length) parts.push(`removed: ${removed.join(', ')}`);
  if (s.uncovered.length) parts.push(`not covered: ${s.uncovered.join(', ')}`);
  return parts.join(' · ');
}
```

- [ ] **Step 4: Implement the command**

Create `cli/src/commands/list.ts`:

```ts
import { checkWalkthrough, filesOf, indexRepo, listSavedWalkthroughs, loadCurrentSource } from '@codewalk/core';
import { formatList, type ListRow } from '../ui/format.js';
import { connectStore, loadRepo, type IO } from './shared.js';

export interface ListOptions {
  out: 'terminal' | 'json';
}

/** `walk list`: every saved walkthrough, fresh or stale against the current code. Returns an exit code. */
export async function runList(cwd: string, options: ListOptions, io: IO): Promise<number> {
  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;

  let rows: ListRow[];
  try {
    await store.migrate();
    // Blocks are found again by symbol name, so the index must match the code on disk.
    await indexRepo(repo.repoRoot, repo.config, store);
    const entries = await listSavedWalkthroughs(store);
    const source = await loadCurrentSource(store, repo.repoRoot, entries.flatMap((e) => filesOf(e.saved)));
    rows = entries.map(({ saved, savedAt }) => ({
      scopeKind: saved.scopeKind,
      scopeRef: saved.scopeRef,
      savedAt,
      status: checkWalkthrough(saved, source),
    }));
  } finally {
    await store.close();
  }

  io.log(options.out === 'json' ? JSON.stringify(rows, null, 2) : formatList(rows));
  return 0;
}
```

- [ ] **Step 5: Register the command**

In `cli/src/index.ts`, add `import { runList } from './commands/list.js';` and, after the `file` command:

```ts
program
  .command('list')
  .description('list saved walkthroughs and whether the code they explain has changed')
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json']).default('terminal'))
  .action(async (opts: { out: 'terminal' | 'json' }) => {
    process.exitCode = await runList(process.cwd(), opts, io);
  });
```

- [ ] **Step 6: Run the acceptance test**

Run: `pnpm vitest run cli/src/commands/list.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Run the full suite, typecheck and build**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: every test file passes (baseline 77 tests plus the new ones), no type errors, and all packages build. The build copies the new migration into `core/dist/migrations`.

- [ ] **Step 8: Manual check on the real fixture (optional, uses the API)**

```bash
cd fixture
npx tsx ../cli/src/index.ts file api/services/enrollService.ts --no-llm
npx tsx ../cli/src/index.ts file api/services/enrollService.ts --out md | head -40
npx tsx ../cli/src/index.ts list
cd ..
```

Expected: the facts print the helpers-first order, the Markdown has an Overview and numbered sections, and `list` shows `fresh  file  api/services/enrollService.ts …`. Running it writes `fixture/.walkthrough/walkthroughs/`, which `.gitignore` already excludes.

- [ ] **Step 9: Stop for review**

Don't commit (CLAUDE.md §15). Report the test counts and the `walk list` output to the user, and wait for review before Phase 3.
