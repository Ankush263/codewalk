# Phase 4: `walk component` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `walk component web/components/EnrollForm.tsx#EnrollForm` explains one React component through fixed stages. The stages cover props, state and context; the render tree; effects; custom hooks expanded as sub-steps; event handlers; and data fetching. Every API call is detected statically with the handler or effect that triggers it.

**Architecture:** The indexer extracts two new per-file facts: React facts per component/hook (`components` table) and API calls (`api_calls` table, using `apiClientWrappers`). Inline functions in a hook's returned object become symbols, so `const { mutate } = useX()` resolves. `buildComponentContext` picks the component, expands repo hooks breadth-first to `--depth`, and collects children one level deep. It gathers callees with one recursive query per owner and computes each API call's triggers over the call graph. The LLM explains it with the unchanged §8.2 schema and the existing verifier. The result is saved as one multi-block section, like `walk endpoint`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), ts-morph, `pg` + `node-pg-migrate`, zod, commander, Ink, vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-phase-4-walk-component-design.md` (implements `CLAUDE.md` §6.4, §8.1, §8.1a, §9, §10, §12 Phase 4, §13).

## Global Constraints

- Node `>=24`, pnpm workspaces, vitest, tsup. TypeScript 7; `pnpm typecheck` must pass at the end.
- Nothing outside `core/src/store` writes SQL (CLAUDE.md §8.1a).
- Database tests use the real compose Postgres, each in its own `cw_test_<random>` schema that is dropped afterwards (CLAUDE.md §14). Never mock the DB.
- LLM calls are mocked in tests with a handcrafted recorded response (CLAUDE.md §14).
- Docs URLs are never produced by the LLM (CLAUDE.md §8.4).
- Unresolved or uncertain facts are surfaced, never guessed silently (CLAUDE.md §8.1). Depth caps are stated in the output (CLAUDE.md §13).
- No Phase 5 features: no route matching for API calls, no `cross_edges` writes, no pins, no combined diagram.
- `SAVED_VERSION` stays `2`; new saved fields are optional.
- The fixture is unchanged (tests that need edits work on a temp copy).
- **Do not commit** (CLAUDE.md §15). Each task ends with a checkpoint instead of a commit.
- Run tests from the repo root with Postgres up (`pnpm db:up`). Baseline before starting: `pnpm test` all green. The baseline could not be counted while writing this plan because Docker was not running; record the counts before Task 1.

## Review Focus

1. **Changing `apiClientWrappers` in config with no code change** must change the detected API calls on the next run. Without the extraction-settings hash, unchanged files are never re-extracted. Tested in Task 4.
2. **A hook returning inline functions** (`return { mutate: (v) => … }`) must still link `handleSubmit → mutate → api.post`. Tested in Task 1 (resolution) and Task 5 (trigger path via the fixture's declared-function form).
3. **The client wrapper's own plumbing** (`fetch(url, …)` inside `request`) must not show up as an API call of every component. Tested in Task 3.
4. **An API call made from a `useEffect`** (no user action) must be reported with the effect as its trigger, not "no trigger found". Tested in Task 5 (`PatientSummary` → `usePatient`).
5. **Wrong target shapes** (file with several or zero components, naming a hook, a line range) must exit 1 with the command to run instead. Tested in Task 5 and Task 8.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/indexer/symbols.ts` (modify) | Inline functions in a hook's returned object → `<hook>.<name>` symbols |
| `core/src/indexer/react.ts` (create) | Per-component/hook React facts |
| `core/src/indexer/apiCalls.ts` (create) | Per-file API call facts + `toUrlPattern` |
| `core/src/indexer/sideEffects.ts` (modify) | Export `literalText`, `propertyValue`, `declaredInRepo`, `oneLine` for reuse |
| `core/src/indexer/extract.ts`, `index.ts` (modify) | Wire new facts; pass `apiClientWrappers`; re-extract on settings change |
| `core/src/indexer/__fixtures__/snippets.ts` (modify) | JSX compiler option; extractor options |
| `core/src/store/migrations/1793000000000_react-facts-and-api-calls.ts` (create) | New `components`/`api_calls` columns, `index_settings` |
| `core/src/store/types.ts`, `store.ts` (modify) | Fact/record types; persist; `getReactFacts`, `getApiCalls`, `getSymbolsByKeys`, `getIndexSetting`, `resetIndexForSetting` |
| `core/src/context/target.ts` (modify) | `parseComponentTarget` |
| `core/src/context/fn.ts` (modify) | Export `resolveTypes` |
| `core/src/context/component.ts` (create) | `buildComponentContext`, `structureHashOf`, `currentStructureHash`, `describeTrigger` |
| `core/src/verify/verify.ts` (modify) | `componentVerifyFacts` |
| `core/src/llm/componentPrompt.ts` (create) | System prompt + renderer |
| `core/src/llm/__fixtures__/enrollForm.response.json` (create) | Handcrafted response for `EnrollForm` |
| `core/src/walkthrough/explain.ts` (create) | `explainGrounded`: generate → verify → docs, shared by endpoint and component |
| `core/src/walkthrough/component.ts` (create) | `explainComponent`, `componentBlocks`, `generateComponentSection`, `componentOverviewOf` |
| `core/src/walkthrough/endpoint.ts` (modify) | Use `explainGrounded`; `reuseEndpointSection` → `reuseMultiBlockSection` |
| `core/src/walkthrough/saved.ts`, `staleness.ts` (modify) | `component` scope, `ComponentOverview`, `componentNotes`, structure staleness |
| `core/src/render/markdown.ts` (modify) | Component Markdown |
| `cli/src/commands/component.ts` (create), `index.ts`, `list.ts`, `endpoint.ts`, `ui/format.ts`, `ui/output.ts` (modify) | `walk component`; list/format/output support |

---

### Task 1: Hook-returned inline functions become symbols

**Files:**
- Modify: `core/src/indexer/symbols.ts`
- Test: `core/src/indexer/symbols.test.ts` (append)

**Interfaces:**
- Produces: inside a symbol of kind `hook`, each function-valued property of the returned object literal (`return { … }` or an arrow's `({ … })` expression body) is registered as kind `method`, named `<hook>.<property>`. The existing type-based resolution in `calls.ts` (step 2) then resolves `const { increment } = useCounter(); increment()` to it.

- [ ] **Step 1: Write the failing test**

Append to `core/src/indexer/symbols.test.ts` (add the `snippetProject` import if the file doesn't have it: `import { snippetProject } from './__fixtures__/snippets.js';`):

```ts
describe('functions a hook returns', () => {
  const files = {
    'hooks/useCounter.ts': `import { useState } from 'react';
export function useCounter() {
  const [n, setN] = useState(0);
  return {
    n,
    increment: () => setN(n + 1),
    reset() { setN(0); },
  };
}
export const useToggle = () => ({ toggle: () => {} });
`,
    'components/Counter.tsx': `import { useCounter } from '../hooks/useCounter';
export function Counter() {
  const { increment } = useCounter();
  return <button onClick={() => increment()}>+</button>;
}
`,
  };

  it('become <hook>.<name> symbols, for `return { ... }` and for an arrow returning an object', () => {
    const { facts } = snippetProject(files);
    expect(facts('hooks/useCounter.ts').symbols.map((s) => `${s.kind} ${s.name}:${s.startLine}`)).toEqual(
      expect.arrayContaining(['hook useCounter:2', 'method useCounter.increment:6', 'method useCounter.reset:7', 'hook useToggle:10', 'method useToggle.toggle:10']),
    );
  });

  it('resolve when a caller destructures them from the hook', () => {
    const { facts } = snippetProject(files);
    expect(facts('components/Counter.tsx').calls).toContainEqual(
      expect.objectContaining({ calleeText: 'increment', callee: { file: 'hooks/useCounter.ts', name: 'useCounter.increment', startLine: 6 }, resolved: true }),
    );
  });

  it('leaves shorthand properties alone (the declared function is already a symbol)', () => {
    const { facts } = snippetProject({ 'h.ts': 'export function useX() {\n  function go() {}\n  return { go };\n}\n' });
    expect(facts('h.ts').symbols.map((s) => s.name)).toEqual(['useX', 'useX.go']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run core/src/indexer/symbols.test.ts -t "functions a hook returns"`
Expected: FAIL. The first test is missing `method useCounter.increment:6` and the rest; the second finds `increment` with `callee: null`.

- [ ] **Step 3: Implement**

In `core/src/indexer/symbols.ts`, inside `visit`, insert this block immediately **before** the `// \`router.get('/x', (req, res) => ...)\`` comment:

```ts
    // A hook's returned object: `return { mutate: (v) => ... }` or `() => ({ toggle: () => ... })`.
    // Its inline functions become "<hook>.<name>" symbols, so `const { mutate } = useX(); mutate()`
    // resolves to their code (calls.ts resolves the destructured name through its type).
    if (owner?.kind === 'hook') {
      const arrowBody = owner.bodyOwner && Node.isArrowFunction(owner.bodyOwner) && owner.bodyOwner.getBody().compilerNode === node.compilerNode;
      const returned = Node.isReturnStatement(node) ? unwrap(node.getExpression()) : arrowBody ? unwrap(node) : undefined;
      if (returned && Node.isObjectLiteralExpression(returned)) {
        return returned.forEachChild((c) => visit(c, null, owner.name));
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/indexer`
Expected: PASS (new tests and all existing indexer tests; the fixture's hooks return shorthand properties, so their symbols are unchanged).

- [ ] **Step 5: Checkpoint**

Do not commit. `git diff --stat` shows only `symbols.ts` and `symbols.test.ts`.

---

### Task 2: React facts per component and hook

**Files:**
- Modify: `core/src/store/types.ts`
- Modify: `core/src/indexer/sideEffects.ts` (export helpers)
- Modify: `core/src/indexer/__fixtures__/snippets.ts`
- Create: `core/src/indexer/react.ts`
- Modify: `core/src/indexer/extract.ts`
- Test: `core/src/indexer/react.test.ts`

**Interfaces:**
- Consumes: `enclosingSymbol`, `declarationOf`, `packageOf`, `calleeText` (`calls.ts`); `FileSymbols`, `RegisteredSymbol`, `functionInitializer`, `unwrap` (`symbols.ts`).
- Produces (in `store/types.ts`):
  ```ts
  export interface StateVarFact { name: string; setter: string | null; hook: 'useState' | 'useReducer'; initial: string | null; line: number }
  export interface HookUseFact { name: string; line: number; callee: SymbolKey | null; package: string | null; bindings: string[]; callbacks: { name: string; line: number }[] }
  export interface ContextUseFact { context: string; line: number; bindings: string[] }
  export interface EffectFact { hook: string; line: number; endLine: number; deps: string[] | null; binding: string | null }
  export interface RenderNodeFact { element: string; kind: 'component' | 'element'; line: number; depth: number; component: SymbolKey | null; package: string | null; props: { name: string; value: string }[]; condition: string | null }
  export interface HandlerBindingFact { element: string; event: string; handler: string; line: number; endLine: number; target: SymbolKey | null }
  export interface ReactFact { symbol: Pick<SymbolKey, 'name' | 'startLine'>; propsType: string | null; props: string[]; state: StateVarFact[]; hooks: HookUseFact[]; context: ContextUseFact[]; effects: EffectFact[]; render: RenderNodeFact[]; handlers: HandlerBindingFact[] }
  ```
  `FileFacts.reactFacts?: ReactFact[]`; `IndexChanges.callRefreshes[]` gains `reactFacts?: ReactFact[]`.
- Produces: `collectReactFacts(sourceFile: SourceFile, registry: FileSymbols, repo: RepoLookup): ReactFact[]`; `ExtractedFacts.reactFacts: ReactFact[]`.
- Produces (exported from `sideEffects.ts`, unchanged behaviour): `literalText(node, depth?)`, `propertyValue(obj, name)`, `declaredInRepo(id, repo)`, `oneLine(text)`.
- Produces: `snippetProject(files, options?: ExtractOptions)`, where `ExtractOptions` is defined in Task 3. In this task the second parameter is accepted and ignored until Task 3 wires it.

- [ ] **Step 1: Add the types**

In `core/src/store/types.ts`, after `SideEffectFact`, add:

```ts
/** A `useState` / `useReducer` binding owned by a component or hook. */
export interface StateVarFact {
  name: string;
  setter: string | null;
  hook: 'useState' | 'useReducer';
  /** useState's argument / useReducer's initial state, one line; null when absent. */
  initial: string | null;
  line: number;
}

/** A hook call made by a component or hook: built-in, package or repo. */
export interface HookUseFact {
  /** Callee text, e.g. "useState", "useEnrollMutation", "React.useMemo". */
  name: string;
  line: number;
  /** The repo hook called; null for package hooks. */
  callee: SymbolKey | null;
  /** e.g. "react", "@tanstack/react-query"; null for repo hooks. */
  package: string | null;
  /** Names the result is bound to: `const { mutate, status } = useX()` -> ["mutate", "status"]. */
  bindings: string[];
  /** Inline functions passed in object-literal arguments: `useX({ onSuccess: (p) => ... })`. */
  callbacks: { name: string; line: number }[];
}

export interface ContextUseFact {
  /** The argument of useContext, e.g. "AuthContext". */
  context: string;
  line: number;
  bindings: string[];
}

/** useEffect / useLayoutEffect / useInsertionEffect / useMemo / useCallback. */
export interface EffectFact {
  hook: string;
  line: number;
  endLine: number;
  /** Dependency array entries; null when there is none (an effect then runs after every render). */
  deps: string[] | null;
  /** `const total = useMemo(...)` -> "total". */
  binding: string | null;
}

/** A JSX element in a component's render tree (CLAUDE.md §6.4 item 2). */
export interface RenderNodeFact {
  /** Tag text, e.g. "form", "FormField", "Foo.Bar". */
  element: string;
  kind: 'component' | 'element';
  line: number;
  /** Number of enclosing JSX elements. */
  depth: number;
  /** The repo component rendered; null for intrinsic elements and package components. */
  component: SymbolKey | null;
  /** Package of a component element, e.g. "react-router-dom". */
  package: string | null;
  /** Attributes as written: string literals keep their quotes; `{expr}` becomes "expr"; spreads are "...". */
  props: { name: string; value: string }[];
  /** e.g. "error", "!(count > 0)", "a && b"; null when always rendered. */
  condition: string | null;
}

/** An `on*` JSX attribute: which user action runs which code. */
export interface HandlerBindingFact {
  element: string;
  /** e.g. "onSubmit". */
  event: string;
  /** Source text of the handler expression, e.g. "handleSubmit" or "() => setOpen(true)". */
  handler: string;
  line: number;
  endLine: number;
  /** The repo function named by the handler; null for inline functions and unknown values. */
  target: SymbolKey | null;
}

/** React facts of one component or hook (CLAUDE.md §6.4). Code inside nested symbols is not included. */
export interface ReactFact {
  symbol: Pick<SymbolKey, 'name' | 'startLine'>;
  /** Type annotation of the first parameter, one line. */
  propsType: string | null;
  /** Components: names destructured from the props parameter. Hooks: every parameter's names. */
  props: string[];
  state: StateVarFact[];
  hooks: HookUseFact[];
  context: ContextUseFact[];
  effects: EffectFact[];
  render: RenderNodeFact[];
  handlers: HandlerBindingFact[];
}
```

In `FileFacts`, after `sideEffects?: SideEffectFact[];`, add `reactFacts?: ReactFact[];`. In `IndexChanges.callRefreshes` change the element type to:

```ts
  callRefreshes?: { path: string; calls: CallFact[]; routerCalls?: RouterCallFact[]; sideEffects?: SideEffectFact[]; reactFacts?: ReactFact[] }[];
```

- [ ] **Step 2: Export the side-effect helpers**

In `core/src/indexer/sideEffects.ts`, add `export` to these four existing functions (no other change): `function literalText`, `function propertyValue`, `function declaredInRepo`, `function oneLine`.

- [ ] **Step 3: Let snippets parse JSX and take extractor options**

Replace `core/src/indexer/__fixtures__/snippets.ts` with:

```ts
import { Project, SyntaxKind, ts, type CallExpression } from 'ts-morph';
import { Extractor, type ExtractedFacts, type ExtractOptions } from '../extract.js';

// In-memory repos for indexer unit tests: no disk and no node_modules, so package imports stay
// unresolved, exactly like a repo whose dependencies aren't installed (the fixture is the same).

const ROOT = '/repo';

export function snippetProject(files: Record<string, string>, options: ExtractOptions = {}) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
  });
  for (const [path, text] of Object.entries(files)) project.createSourceFile(`${ROOT}/${path}`, text);
  project.resolveSourceFileDependencies();
  const extractor = new Extractor(project, ROOT, new Set(Object.keys(files)), options);
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

In `core/src/indexer/extract.ts`, add the options type and constructor parameter now (Task 3 uses it):

```ts
import type { ApiClientWrapper } from '../config.js';

export interface ExtractOptions {
  /** CLAUDE.md §10: custom API clients recognised as API calls. */
  apiClientWrappers?: ApiClientWrapper[];
}
```

and change the constructor to:

```ts
  constructor(
    private readonly project: Project,
    private readonly repoRoot: string,
    /** Repo-relative paths of every indexed file (not just the ones being extracted). */
    private readonly repoPaths: Set<string>,
    private readonly options: ExtractOptions = {},
  ) {
```

In `core/src/config.ts`, after `export type WalkConfig = …`, add:

```ts
export type ApiClientWrapper = WalkConfig['apiClientWrappers'][number];
```

- [ ] **Step 4: Write the failing test**

Create `core/src/indexer/react.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';

const FIXTURE = new URL('../../../fixture/', import.meta.url);
const WEB = [
  'web/apiClient.ts',
  'web/types.ts',
  'web/components/EnrollForm.tsx',
  'web/components/FormField.tsx',
  'web/components/PatientSummary.tsx',
  'web/hooks/useEnrollMutation.ts',
  'web/hooks/usePatient.ts',
];
const web = () => snippetProject(Object.fromEntries(WEB.map((p) => [p, readFileSync(new URL(p, FIXTURE), 'utf8')])));
const only = <T>(xs: T[]): T => {
  expect(xs).toHaveLength(1);
  return xs[0];
};

describe('React facts on the fixture', () => {
  it('EnrollForm: props, state, hooks with callee and callbacks', () => {
    const f = only(web().facts('web/components/EnrollForm.tsx').reactFacts);
    expect(f.symbol).toEqual({ name: 'EnrollForm', startLine: 18 });
    expect(f.propsType).toBe('EnrollFormProps');
    expect(f.props).toEqual(['onEnrolled']);
    expect(f.state).toEqual([{ name: 'values', setter: 'setValues', hook: 'useState', initial: 'EMPTY_FORM', line: 19 }]);
    expect(f.hooks).toEqual([
      { name: 'useState', line: 19, callee: null, package: 'react', bindings: ['values', 'setValues'], callbacks: [] },
      {
        name: 'useEnrollMutation',
        line: 20,
        callee: { file: 'web/hooks/useEnrollMutation.ts', name: 'useEnrollMutation', startLine: 11 },
        package: null,
        bindings: ['mutate', 'status', 'error'],
        callbacks: [{ name: 'onSuccess', line: 21 }],
      },
    ]);
    expect(f.context).toEqual([]);
    expect(f.effects).toEqual([]);
  });

  it('EnrollForm: render tree keeps components and elements with handlers or conditions', () => {
    const f = only(web().facts('web/components/EnrollForm.tsx').reactFacts);
    expect(f.render.map((r) => `${r.element}:${r.line}:${r.depth}:${r.condition ?? '-'}`)).toEqual([
      'form:39:0:-',
      'FormField:40:1:-',
      'FormField:41:1:-',
      'FormField:42:1:-',
      'FormField:43:1:-',
      'input:45:2:-',
      'p:48:1:error',
    ]);
    expect(f.render[1]).toEqual({
      element: 'FormField',
      kind: 'component',
      line: 40,
      depth: 1,
      component: { file: 'web/components/FormField.tsx', name: 'FormField', startLine: 11 },
      package: null,
      props: [
        { name: 'label', value: '"First name"' },
        { name: 'name', value: '"firstName"' },
        { name: 'value', value: 'values.firstName' },
        { name: 'onChange', value: 'handleChange' },
      ],
      condition: null,
    });
  });

  it('EnrollForm: handlers resolve to the functions they name', () => {
    const f = only(web().facts('web/components/EnrollForm.tsx').reactFacts);
    expect(f.handlers.map((h) => `${h.event} <${h.element}> ${h.handler} :${h.line} -> ${h.target ? `${h.target.name}@${h.target.startLine}` : '-'}`)).toEqual([
      'onSubmit <form> handleSubmit :39 -> EnrollForm.handleSubmit@32',
      'onChange <FormField> handleChange :40 -> EnrollForm.handleChange@27',
      'onChange <FormField> handleChange :41 -> EnrollForm.handleChange@27',
      'onChange <FormField> handleChange :42 -> EnrollForm.handleChange@27',
      'onChange <FormField> handleChange :43 -> EnrollForm.handleChange@27',
      'onChange <input> handleChange :45 -> EnrollForm.handleChange@27',
    ]);
  });

  it('hooks: parameters, state and effects with deps', () => {
    const p = web();
    const mutation = only(p.facts('web/hooks/useEnrollMutation.ts').reactFacts);
    expect(mutation).toMatchObject({
      symbol: { name: 'useEnrollMutation', startLine: 11 },
      propsType: 'Options',
      props: ['onSuccess'],
      state: [
        { name: 'status', setter: 'setStatus', hook: 'useState', initial: "'idle'", line: 12 },
        { name: 'error', setter: 'setError', hook: 'useState', initial: 'null', line: 13 },
      ],
      render: [],
      handlers: [],
    });
    const patient = only(p.facts('web/hooks/usePatient.ts').reactFacts);
    expect(patient.props).toEqual(['id']);
    expect(patient.propsType).toBe('string');
    expect(patient.hooks.map((h) => `${h.name}:${h.line}`)).toEqual(['useState:6', 'useState:7', 'useEffect:9']);
    expect(patient.effects).toEqual([{ hook: 'useEffect', line: 9, endLine: 23, deps: ['id'], binding: null }]);
  });

  it('PatientSummary: early returns become conditions', () => {
    const f = only(web().facts('web/components/PatientSummary.tsx').reactFacts);
    expect(f.props).toEqual(['patientId']);
    expect(f.propsType).toBe('{ patientId: string }');
    expect(f.hooks[0]).toMatchObject({ name: 'usePatient', callee: { file: 'web/hooks/usePatient.ts', name: 'usePatient', startLine: 5 }, bindings: ['patient', 'loading'] });
    expect(f.render.map((r) => `${r.element}:${r.line}:${r.condition}`)).toEqual(['p:6:loading', 'p:7:!patient']);
  });

  it('non-React files have no React facts', () => {
    expect(web().facts('web/apiClient.ts').reactFacts).toEqual([]);
  });
});

describe('React facts on snippets', () => {
  const panel = `import { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import { Link } from 'react-router-dom';
export const ThemeContext = createContext('light');
function reducer(n: number, a: { type: 'inc' }) { return a.type === 'inc' ? n + 1 : n; }
export function Panel({ items, onPick: pick, ...rest }: { items: string[]; onPick(i: string): void }) {
  const theme = useContext(ThemeContext);
  const [count, dispatch] = useReducer(reducer, 0);
  const total = useMemo(() => items.length, [items]);
  const choose = useCallback((i: string) => pick(i), [pick]);
  return (
    <div {...rest}>
      {count > 0 ? <Link to="/done">Done</Link> : <span onClick={() => dispatch({ type: 'inc' })}>{total}</span>}
      <button onClick={() => choose(items[0])}>{theme}</button>
    </div>
  );
}
`;

  it('collects context, reducers, derived values, package components, ternaries and inline handlers', () => {
    const f = snippetProject({ 'Panel.tsx': panel }).facts('Panel.tsx').reactFacts.find((x) => x.symbol.name === 'Panel')!;
    expect(f.props).toEqual(['items', 'onPick', '...rest']);
    expect(f.context).toEqual([{ context: 'ThemeContext', line: 6, bindings: ['theme'] }]);
    expect(f.state).toEqual([{ name: 'count', setter: 'dispatch', hook: 'useReducer', initial: '0', line: 7 }]);
    expect(f.effects).toEqual([
      { hook: 'useMemo', line: 8, endLine: 8, deps: ['items'], binding: 'total' },
      { hook: 'useCallback', line: 9, endLine: 9, deps: ['pick'], binding: 'choose' },
    ]);
    expect(f.hooks.map((h) => `${h.name}:${h.package}`)).toEqual(['useContext:react', 'useReducer:react', 'useMemo:react', 'useCallback:react']);
    expect(f.render.map((r) => `${r.kind} ${r.element}:${r.line}:${r.depth}:${r.condition ?? '-'}:${r.package ?? '-'}`)).toEqual([
      'component Link:12:1:count > 0:react-router-dom',
      'element span:12:1:!(count > 0):-',
      'element button:13:1:-:-',
    ]);
    expect(f.handlers.map((h) => `${h.event} <${h.element}> ${h.handler} ${h.target ? 'resolved' : 'inline'}`)).toEqual([
      "onClick <span> () => dispatch({ type: 'inc' }) inline",
      'onClick <button> () => choose(items[0]) inline',
    ]);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm vitest run core/src/indexer/react.test.ts`
Expected: FAIL: `reactFacts` is undefined on `ExtractedFacts`.

- [ ] **Step 6: Implement the collector**

Create `core/src/indexer/react.ts`:

```ts
import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { HandlerBindingFact, ReactFact, RenderNodeFact, StateVarFact, SymbolKey } from '../store/types.js';
import { calleeText, declarationOf, enclosingSymbol, packageOf, type RepoLookup } from './calls.js';
import { oneLine } from './sideEffects.js';
import { functionInitializer, unwrap, type FileSymbols, type RegisteredSymbol } from './symbols.js';

// React facts per component and hook (CLAUDE.md §6.4): props, state, hooks, context, effects, render
// tree and event handlers. Only code the symbol owns counts: bodies of nested symbols (e.g.
// EnrollForm.handleSubmit) have facts of their own. Inline arrows that aren't symbols (effect
// callbacks, `.map` callbacks) belong to the enclosing component or hook.

const HOOK_NAME = /^use[A-Z0-9]/;
const REACT = new Set(['react', 'preact']);
const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useMemo', 'useCallback']);
const EVENT = /^on[A-Z]/;

export function collectReactFacts(sourceFile: SourceFile, registry: FileSymbols, repo: RepoLookup): ReactFact[] {
  return registry.symbols.filter((s) => (s.kind === 'component' || s.kind === 'hook') && s.bodyOwner).map((s) => factsOf(s, registry, repo));
}

function factsOf(sym: RegisteredSymbol, registry: FileSymbols, repo: RepoLookup): ReactFact {
  const fn = sym.bodyOwner!;
  const owns = (n: Node): boolean => {
    if (enclosingSymbol(n, registry.byNode) === sym) return true;
    // `const onSave = useCallback(() => ..., [])`: the declaration is a symbol of its own, but the hook call belongs to `sym`.
    const parent = n.getParent();
    return Node.isCallExpression(n) && !!parent && Node.isVariableDeclaration(parent) && enclosingSymbol(parent, registry.byNode) === sym;
  };
  const params = (fn as unknown as { getParameters(): Node[] }).getParameters();
  const first = params[0];
  const typeNode = first && Node.isParameterDeclaration(first) ? first.getTypeNode() : undefined;

  const facts: ReactFact = {
    symbol: { name: sym.name, startLine: sym.startLine },
    propsType: typeNode ? oneLine(typeNode.getText()) : null,
    props: (sym.kind === 'component' ? params.slice(0, 1) : params).flatMap((p) => (Node.isParameterDeclaration(p) ? propertyNames(p.getNameNode()) : [])),
    state: [],
    hooks: [],
    context: [],
    effects: [],
    render: [],
    handlers: [],
  };

  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = calleeText(call.getExpression());
    const short = name.slice(name.lastIndexOf('.') + 1);
    if (HOOK_NAME.test(short) && owns(call)) collectHook(call, name, short, facts, repo);
  }

  const elements = [...fn.getDescendantsOfKind(SyntaxKind.JsxElement), ...fn.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)].sort(
    (a, b) => a.getStart() - b.getStart(),
  );
  for (const el of elements) if (owns(el)) collectElement(el, fn, facts, repo);
  return facts;
}

function collectHook(call: CallExpression, name: string, short: string, facts: ReactFact, repo: RepoLookup): void {
  const expr = call.getExpression();
  const line = (Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr).getStartLineNumber();
  const pkg = packageOf(expr, repo);
  const decl = pkg ? undefined : declarationOf(expr);
  const callee = decl && repo.isRepoFile(decl.getSourceFile()) ? repo.keyFor(decl) : null;
  const holder = call.getParent();
  const bindingNode = holder && Node.isVariableDeclaration(holder) ? holder.getNameNode() : undefined;
  const bindings = bindingNode ? localNames(bindingNode) : [];
  const args = call.getArguments();
  facts.hooks.push({ name, line, callee, package: pkg, bindings, callbacks: callbacksOf(args) });

  if (pkg === null || !REACT.has(pkg)) return;
  if (short === 'useState' || short === 'useReducer') {
    const [firstEl, secondEl] = bindingNode && Node.isArrayBindingPattern(bindingNode) ? bindingNode.getElements() : [];
    const nameOf = (e: Node | undefined) => (e && Node.isBindingElement(e) ? e.getName() : null);
    const init = short === 'useState' ? args[0] : args[1];
    const state: StateVarFact = {
      name: nameOf(firstEl) ?? (bindingNode && Node.isIdentifier(bindingNode) ? bindingNode.getText() : '(unnamed)'),
      setter: nameOf(secondEl),
      hook: short,
      initial: init ? oneLine(init.getText()) : null,
      line,
    };
    facts.state.push(state);
  } else if (short === 'useContext') {
    facts.context.push({ context: args[0] ? oneLine(args[0].getText()) : '', line, bindings });
  } else if (EFFECT_HOOKS.has(short)) {
    const depsArg = unwrap(args[1]);
    facts.effects.push({
      hook: short,
      line: call.getStartLineNumber(),
      endLine: call.getEndLineNumber(),
      deps: !depsArg ? null : Node.isArrayLiteralExpression(depsArg) ? depsArg.getElements().map((e) => oneLine(e.getText())) : [oneLine(depsArg.getText())],
      binding: bindingNode && Node.isIdentifier(bindingNode) ? bindingNode.getText() : null,
    });
  }
}

function collectElement(el: Node, fn: Node, facts: ReactFact, repo: RepoLookup): void {
  const opening = Node.isJsxElement(el) ? el.getOpeningElement() : el;
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return;
  const tag = opening.getTagNameNode();
  const element = tag.getText();
  const kind = /^[A-Z]/.test(element) || element.includes('.') ? 'component' : 'element';
  const attributes = opening.getAttributes();
  const props = attributes.map(attributeOf);

  for (const attr of attributes) {
    if (!Node.isJsxAttribute(attr)) continue;
    const event = attr.getNameNode().getText();
    const init = attr.getInitializer();
    const value = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
    if (!EVENT.test(event) || !value) continue;
    const handler: HandlerBindingFact = {
      element,
      event,
      handler: oneLine(value.getText()),
      line: attr.getStartLineNumber(),
      endLine: attr.getEndLineNumber(),
      target: targetOf(unwrap(value) ?? value, repo),
    };
    facts.handlers.push(handler);
  }

  const condition = conditionOf(el, fn);
  if (kind === 'element' && condition === null && !props.some((p) => EVENT.test(p.name))) return;

  let component: SymbolKey | null = null;
  let pkg: string | null = null;
  if (kind === 'component') {
    pkg = packageOf(tag, repo);
    const decl = pkg ? undefined : declarationOf(tag);
    component = decl && repo.isRepoFile(decl.getSourceFile()) ? repo.keyFor(decl) : null;
  }
  let depth = 0;
  for (let a = el.getParent(); a && a.compilerNode !== fn.compilerNode; a = a.getParent()) if (Node.isJsxElement(a)) depth++;
  const node: RenderNodeFact = { element, kind, line: opening.getStartLineNumber(), depth, component, package: pkg, props, condition };
  facts.render.push(node);
}

/** `a && <X/>` -> "a"; `c ? <X/> : ...` -> "c" / "!(c)"; `if (c) return <X/>` -> "c" / "!(c)"; joined outermost first. */
function conditionOf(el: Node, fn: Node): string | null {
  const parts: string[] = [];
  let child: Node = el;
  for (let a = el.getParent(); a && a.compilerNode !== fn.compilerNode; child = a, a = a.getParent()) {
    const is = (n: Node | undefined) => n !== undefined && n.compilerNode === child.compilerNode;
    if (Node.isBinaryExpression(a) && a.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken && is(a.getRight())) {
      parts.push(oneLine(a.getLeft().getText()));
    } else if (Node.isConditionalExpression(a)) {
      if (is(a.getWhenTrue())) parts.push(oneLine(a.getCondition().getText()));
      else if (is(a.getWhenFalse())) parts.push(`!(${oneLine(a.getCondition().getText())})`);
    } else if (Node.isIfStatement(a)) {
      if (is(a.getThenStatement())) parts.push(oneLine(a.getExpression().getText()));
      else if (is(a.getElseStatement())) parts.push(`!(${oneLine(a.getExpression().getText())})`);
    }
  }
  return parts.length ? parts.reverse().join(' && ') : null;
}

function attributeOf(attr: Node): { name: string; value: string } {
  if (Node.isJsxSpreadAttribute(attr)) return { name: '...', value: oneLine(attr.getExpression().getText()) };
  if (!Node.isJsxAttribute(attr)) return { name: '?', value: oneLine(attr.getText()) };
  const init = attr.getInitializer();
  const value = !init ? 'true' : Node.isJsxExpression(init) ? oneLine(init.getExpression()?.getText() ?? '') : oneLine(init.getText());
  return { name: attr.getNameNode().getText(), value };
}

/** The repo function a handler expression names (`handleSubmit`, `actions.save`); null for inline functions. */
function targetOf(expr: Node, repo: RepoLookup): SymbolKey | null {
  if (!Node.isIdentifier(expr) && !Node.isPropertyAccessExpression(expr)) return null;
  const decl = declarationOf(expr);
  return decl && repo.isRepoFile(decl.getSourceFile()) ? repo.keyFor(decl) : null;
}

/** Inline functions passed in object-literal arguments, e.g. `useX({ onSuccess: (p) => ... })`. */
function callbacksOf(args: Node[]): { name: string; line: number }[] {
  return args.flatMap((arg) => {
    const obj = unwrap(arg);
    if (!obj || !Node.isObjectLiteralExpression(obj)) return [];
    return obj.getProperties().flatMap((p) => {
      if (Node.isMethodDeclaration(p) || (Node.isPropertyAssignment(p) && functionInitializer(p.getInitializer()))) {
        return [{ name: p.getName(), line: p.getStartLineNumber() }];
      }
      return [];
    });
  });
}

/** Prop names a parameter receives: `{ a, b: c, ...rest }` -> ["a", "b", "...rest"]; `props` -> ["props"]. */
function propertyNames(name: Node): string[] {
  if (Node.isIdentifier(name)) return [name.getText()];
  if (Node.isObjectBindingPattern(name)) {
    return name.getElements().map((e) => (e.getDotDotDotToken() ? `...${e.getName()}` : (e.getPropertyNameNode()?.getText() ?? e.getName())));
  }
  return localNames(name);
}

/** Local names a binding introduces: `{ a: b }` -> ["b"], `[x, , y]` -> ["x", "y"]. */
function localNames(name: Node): string[] {
  if (Node.isIdentifier(name)) return [name.getText()];
  if (Node.isObjectBindingPattern(name) || Node.isArrayBindingPattern(name)) {
    return (name.getElements() as Node[]).flatMap((e) => (Node.isBindingElement(e) ? [e.getName()] : []));
  }
  return [];
}
```

- [ ] **Step 7: Wire into extraction**

In `core/src/indexer/extract.ts`: import `collectReactFacts` from `./react.js` and `ReactFact` from `../store/types.js`; add `reactFacts: ReactFact[];` to `ExtractedFacts`; in `extract()` add `reactFacts: collectReactFacts(sourceFile, registry, this.repo),` after `sideEffects`.

In `core/src/indexer/index.ts`, change the refresh mapping to carry the new facts:

```ts
    const callRefreshes = refreshed.map((path) => {
      const { calls, routerCalls, sideEffects, reactFacts } = extractor.extract(path);
      return { path, calls, routerCalls, sideEffects, reactFacts };
    });
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vitest run core/src/indexer`
Expected: PASS. If an existing test compares a whole `ExtractedFacts` object with `toEqual`, add `reactFacts: []` (or the expected facts) to its expectation. Don't loosen it.

- [ ] **Step 9: Checkpoint**

Do not commit. Run `pnpm --filter @codewalk/core exec tsc --noEmit` and expect no errors.

---

### Task 3: API call facts

**Files:**
- Modify: `core/src/store/types.ts`
- Create: `core/src/indexer/apiCalls.ts`
- Modify: `core/src/indexer/extract.ts`, `core/src/indexer/index.ts`
- Test: `core/src/indexer/apiCalls.test.ts`

**Interfaces:**
- Consumes: `ExtractOptions.apiClientWrappers` (Task 2); `literalText`, `propertyValue`, `declaredInRepo`, `oneLine` (Task 2); `normalizePath` (`routes/match.ts`).
- Produces (in `store/types.ts`):
  ```ts
  export interface ApiCallFact { symbol: Pick<SymbolKey, 'name' | 'startLine'>; method: string; urlPattern: string; urlText: string; line: number }
  ```
  `FileFacts.apiCalls?: ApiCallFact[]`; `IndexChanges.callRefreshes[]` gains `apiCalls?: ApiCallFact[]`.
- Produces: `collectApiCalls(sourceFile, byNode, repo, wrappers: ApiClientWrapper[]): ApiCallFact[]`; `toUrlPattern(parts: string[], params?: string[]): string`; `ExtractedFacts.apiCalls: ApiCallFact[]`.

- [ ] **Step 1: Add the type**

In `core/src/store/types.ts`, after `ReactFact`, add:

```ts
/** An HTTP request made by frontend code (CLAUDE.md §6.4 item 5). Phase 5 matches it to routes. */
export interface ApiCallFact {
  symbol: Pick<SymbolKey, 'name' | 'startLine'>;
  /** GET, POST, ...; UNKNOWN when a `method` option isn't a literal. */
  method: string;
  /** e.g. "/api/patients/:id" from `/api/patients/${id}`. */
  urlPattern: string;
  /** The URL argument as written. */
  urlText: string;
  line: number;
}
```

Add `apiCalls?: ApiCallFact[];` to `FileFacts` (after `reactFacts`), and `apiCalls?: ApiCallFact[]` to the `callRefreshes` element type.

- [ ] **Step 2: Write the failing test**

Create `core/src/indexer/apiCalls.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';
import { toUrlPattern } from './apiCalls.js';

const FIXTURE = new URL('../../../fixture/', import.meta.url);
const WEB = ['web/apiClient.ts', 'web/types.ts', 'web/hooks/useEnrollMutation.ts', 'web/hooks/usePatient.ts'];
const WRAPPERS = [
  { name: 'api.get', method: 'GET' as const, urlArgIndex: 0 },
  { name: 'api.post', method: 'POST' as const, urlArgIndex: 0 },
];
const web = (apiClientWrappers = WRAPPERS) =>
  snippetProject(Object.fromEntries(WEB.map((p) => [p, readFileSync(new URL(p, FIXTURE), 'utf8')])), { apiClientWrappers });

describe('toUrlPattern', () => {
  it('turns substitutions into params and drops base URLs, hosts and queries', () => {
    expect(toUrlPattern(['/patients/', ''], ['id'])).toBe('/patients/:id');
    expect(toUrlPattern(['', '/patients'], ['API_URL'])).toBe('/patients');
    expect(toUrlPattern(['https://x.example.com/v1/items?page=1'])).toBe('/v1/items');
    expect(toUrlPattern(['/a//b/'])).toBe('/a/b');
  });
});

describe('API calls on the fixture', () => {
  it('finds wrapper calls, with literal and template URLs', () => {
    const p = web();
    expect(p.facts('web/hooks/useEnrollMutation.ts').apiCalls).toEqual([
      { symbol: { name: 'useEnrollMutation.mutate', startLine: 15 }, method: 'POST', urlPattern: '/api/patients/enroll', urlText: "'/api/patients/enroll'", line: 19 },
    ]);
    expect(p.facts('web/hooks/usePatient.ts').apiCalls).toEqual([
      { symbol: { name: 'usePatient', startLine: 5 }, method: 'GET', urlPattern: '/api/patients/:id', urlText: '`/api/patients/${id}`', line: 13 },
    ]);
  });

  it("skips the wrapper's own plumbing (fetch with a non-literal URL)", () => {
    expect(web().facts('web/apiClient.ts').apiCalls).toEqual([]);
  });

  it('finds nothing for a custom client that is not configured', () => {
    expect(web([]).facts('web/hooks/useEnrollMutation.ts').apiCalls).toEqual([]);
  });
});

describe('API calls on snippets', () => {
  it('handles fetch and axios forms', () => {
    const { facts } = snippetProject({
      'load.ts': `import axios from 'axios';
const ENROLL = '/api/patients/enroll';
const API = 'https://api.example.com';
export async function load(id: string, patient: { id: string }, verb: string) {
  await fetch(ENROLL, { method: 'post' });
  await fetch(\`\${API}/patients/\${patient.id}/visits?page=2\`);
  await fetch(\`https://other.example.com/v1/items/\${id}\`, { method: verb });
  await axios.get(\`/api/patients/\${id}\`);
  await axios({ url: '/api/reports', method: 'PUT' });
  await axios('/api/ping');
  const url = id ? '/a' : '/b';
  await fetch(url);
}
`,
    });
    expect(facts('load.ts').apiCalls.map((c) => `${c.line} ${c.method} ${c.urlPattern} ${c.urlText}`)).toEqual([
      '5 POST /api/patients/enroll ENROLL',
      '6 GET /patients/:id/visits `${API}/patients/${patient.id}/visits?page=2`',
      '7 UNKNOWN /v1/items/:id `https://other.example.com/v1/items/${id}`',
      '8 GET /api/patients/:id `/api/patients/${id}`',
      "9 PUT /api/reports '/api/reports'",
      "10 GET /api/ping '/api/ping'",
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run core/src/indexer/apiCalls.test.ts`
Expected: FAIL: cannot resolve `./apiCalls.js`.

- [ ] **Step 4: Implement the collector**

Create `core/src/indexer/apiCalls.ts`:

```ts
import { Node, SyntaxKind, VariableDeclarationKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { ApiClientWrapper } from '../config.js';
import { normalizePath } from '../routes/match.js';
import type { ApiCallFact } from '../store/types.js';
import { calleeText, declarationOf, enclosingSymbol, packageOf, type RepoLookup } from './calls.js';
import { declaredInRepo, literalText, oneLine, propertyValue } from './sideEffects.js';
import { unwrap, type RegisteredSymbol } from './symbols.js';

// API calls made by frontend code (CLAUDE.md §6.4 item 5, §10): configured client wrappers, fetch and
// axios, each with a literal URL. A call whose URL isn't a literal, e.g. `fetch(url)` inside the
// wrapper itself, is plumbing rather than an API call and is skipped. Phase 5 matches url_pattern to routes.

const AXIOS_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const MAX_CONST_DEPTH = 3;

export function collectApiCalls(sourceFile: SourceFile, byNode: Map<unknown, RegisteredSymbol>, repo: RepoLookup, wrappers: ApiClientWrapper[]): ApiCallFact[] {
  const facts: ApiCallFact[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const found = classify(call, repo, wrappers);
    const url = found && urlOf(found.url, 0);
    if (!found || !url) continue;
    const owner = enclosingSymbol(call, byNode);
    if (!owner) continue;
    const expr = call.getExpression();
    facts.push({
      symbol: { name: owner.name, startLine: owner.startLine },
      method: found.method,
      urlPattern: url.pattern,
      urlText: url.text,
      line: (Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr).getStartLineNumber(),
    });
  }
  return facts.sort((a, b) => a.line - b.line);
}

/**
 * "/patients/" + ${id} -> "/patients/:id". A leading substitution before the first "/" is a base URL
 * (`${API_URL}/patients`) and is dropped, as are a scheme + host, the query string and the hash.
 */
export function toUrlPattern(parts: string[], params: string[] = []): string {
  let out = parts[0];
  params.forEach((param, i) => {
    const next = parts[i + 1] ?? '';
    if (i === 0 && out === '' && next.startsWith('/')) out = next;
    else out += `:${param}${next}`;
  });
  out = out.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  return out.startsWith('/') ? normalizePath(out) : out;
}

function classify(call: CallExpression, repo: RepoLookup, wrappers: ApiClientWrapper[]): { method: string; url: Node | undefined } | null {
  const expr = unwrap(call.getExpression()) ?? call.getExpression();
  const args = call.getArguments();
  const text = calleeText(expr);

  const wrapper = wrappers.find((w) => w.name === text);
  if (wrapper) return { method: wrapper.method, url: args[wrapper.urlArgIndex] };

  if (Node.isIdentifier(expr) && text === 'fetch' && !declaredInRepo(expr, repo)) return { method: optionMethod(args[1]) ?? 'GET', url: args[0] };

  if (Node.isIdentifier(expr) && packageOf(expr, repo) === 'axios') {
    const config = unwrap(args[0]);
    if (config && Node.isObjectLiteralExpression(config)) return { method: optionMethod(config) ?? 'GET', url: propertyValue(config, 'url') };
    return { method: optionMethod(args[1]) ?? 'GET', url: args[0] };
  }
  if (Node.isPropertyAccessExpression(expr) && AXIOS_VERBS.has(expr.getName()) && packageOf(expr.getExpression(), repo) === 'axios') {
    return { method: expr.getName().toUpperCase(), url: args[0] };
  }
  return null;
}

/** A literal `method` option, upper-cased; UNKNOWN when present but not a literal; null when absent. */
function optionMethod(node: Node | undefined): string | null {
  const n = unwrap(node);
  if (!n || !Node.isObjectLiteralExpression(n) || !n.getProperty('method')) return null;
  return literalText(propertyValue(n, 'method'))?.toUpperCase() ?? 'UNKNOWN';
}

/** Pattern and source text of a literal URL (or a const initialised with one); null for anything else. */
function urlOf(node: Node | undefined, depth: number): { pattern: string; text: string } | null {
  const n = unwrap(node);
  if (!n || depth > MAX_CONST_DEPTH) return null;
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return { pattern: toUrlPattern([n.getLiteralText()]), text: oneLine(n.getText()) };
  if (Node.isTemplateExpression(n)) {
    const parts = [n.getHead().getLiteralText()];
    const params: string[] = [];
    for (const span of n.getTemplateSpans()) {
      params.push(paramName(span.getExpression()));
      parts.push(span.getLiteral().getLiteralText());
    }
    return { pattern: toUrlPattern(parts, params), text: oneLine(n.getText()) };
  }
  if (Node.isIdentifier(n)) {
    const decl = declarationOf(n);
    const list = decl?.getParent();
    if (decl && Node.isVariableDeclaration(decl) && list && Node.isVariableDeclarationList(list) && list.getDeclarationKind() === VariableDeclarationKind.Const) {
      const inner = urlOf(decl.getInitializer(), depth + 1);
      return inner && { pattern: inner.pattern, text: n.getText() };
    }
  }
  return null;
}

/** `${id}` -> "id", `${patient.id}` -> "id", anything else -> "param". */
function paramName(expr: Node): string {
  const n = unwrap(expr) ?? expr;
  if (Node.isIdentifier(n)) return n.getText();
  if (Node.isPropertyAccessExpression(n)) return n.getName();
  return 'param';
}
```

- [ ] **Step 5: Wire into extraction and indexing**

In `core/src/indexer/extract.ts`: import `collectApiCalls` from `./apiCalls.js` and `ApiCallFact`; add `apiCalls: ApiCallFact[];` to `ExtractedFacts`; in `extract()` add:

```ts
      apiCalls: collectApiCalls(sourceFile, registry.byNode, this.repo, this.options.apiClientWrappers ?? []),
```

In `core/src/indexer/index.ts`, pass the wrappers and carry the facts on refreshes:

```ts
    const extractor = new Extractor(project, root, present, { apiClientWrappers: config.apiClientWrappers });
```

```ts
    const callRefreshes = refreshed.map((path) => {
      const { calls, routerCalls, sideEffects, reactFacts, apiCalls } = extractor.extract(path);
      return { path, calls, routerCalls, sideEffects, reactFacts, apiCalls };
    });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run core/src/indexer`
Expected: PASS.

- [ ] **Step 7: Checkpoint**

Do not commit. `pnpm --filter @codewalk/core exec tsc --noEmit` is clean.

---

### Task 4: Migration, store, and re-extraction on settings change

**Files:**
- Create: `core/src/store/migrations/1793000000000_react-facts-and-api-calls.ts`
- Modify: `core/src/store/types.ts`, `core/src/store/store.ts`
- Modify: `core/src/indexer/index.ts`
- Test: `core/src/store/migrations.test.ts` (append), `core/src/store/store.test.ts` (append), `core/src/indexer/indexer.test.ts` (append)

**Interfaces:**
- Consumes: `ReactFact`, `ApiCallFact` on `FileFacts` / `callRefreshes` (Tasks 2–3).
- Produces (types):
  ```ts
  export interface ReactFactRecord extends Omit<ReactFact, 'symbol'> { symbolId: number }
  export interface ApiCallRecord { id: number; symbolId: number; method: string; urlPattern: string; urlText: string; line: number }
  ```
- Produces (`Store`):
  - `getReactFacts(symbolIds: number[]): Promise<ReactFactRecord[]>`
  - `getApiCalls(symbolIds: number[]): Promise<ApiCallRecord[]>`: ordered by symbol, line.
  - `getSymbolsByKeys(keys: SymbolKey[]): Promise<SymbolRecord[]>`: keys that match nothing are left out; ordered by file, start line.
  - `getIndexSetting(key: string): Promise<string | null>`
  - `resetIndexForSetting(key: string, value: string): Promise<void>`: in one transaction, clears every file hash and stores the setting.
- Produces (`indexer/index.ts`): `EXTRACTION_SETTINGS = 'extraction'`; `extractionSettingsHash(config: WalkConfig): string`.

- [ ] **Step 1: Write the failing migration test**

Append to `core/src/store/migrations.test.ts`:

```ts
// Upgrading an index built before Phase 4: unchanged files must be re-extracted to get React facts and API calls.
describe('react-facts-and-api-calls migration', () => {
  const schema = `cw_test_mig4_${randomBytes(4).toString('hex')}`;
  let store: Store;
  let pool: pg.Pool;

  beforeAll(async () => {
    await runner({ databaseUrl: DATABASE_URL, dir: MIGRATIONS_DIR, migrationsTable: 'pgmigrations', schema, createSchema: true, direction: 'up', count: 3, log: () => {} });
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema},public` });
    store = await openStore({ url: DATABASE_URL, schema });
  });

  afterAll(async () => {
    await pool?.end();
    await store?.dropSchema();
    await store?.close();
  });

  it('marks every indexed file as changed and adds the new columns and settings table', async () => {
    await pool.query(`INSERT INTO files (path, hash, language) VALUES ('web/a.tsx', 'h1', 'typescript')`);
    await store.migrate();
    expect([...(await store.getFileHashes()).values()]).toEqual(['']);
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = $1 AND ((table_name = 'components' AND column_name IN ('props', 'effects', 'render', 'handlers'))
         OR (table_name = 'api_calls' AND column_name = 'url_text') OR table_name = 'index_settings')
       ORDER BY 1, 2`,
      [schema],
    );
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'api_calls.url_text', 'components.effects', 'components.handlers', 'components.props', 'components.render', 'index_settings.key', 'index_settings.value',
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run core/src/store/migrations.test.ts -t "react-facts"`
Expected: FAIL: the hash stays `h1` and the column list is empty.

- [ ] **Step 3: Write the migration**

Create `core/src/store/migrations/1793000000000_react-facts-and-api-calls.ts`:

```ts
import type { MigrationBuilder } from 'node-pg-migrate';

// Phase 4 (walk component): React facts per component/hook, the source text of API call URLs, and the
// extraction settings an index was built with (a config change must re-extract unchanged files).

export async function up(pgm: MigrationBuilder): Promise<void> {
  const list = () => ({ type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) });
  pgm.addColumns('components', { props: list(), effects: list(), render: list(), handlers: list() });
  pgm.addColumns('api_calls', { url_text: { type: 'text', notNull: true, default: '' } });
  pgm.createTable('index_settings', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'text', notNull: true },
  });
  // Files indexed before this migration have no React facts or API calls.
  pgm.sql("UPDATE files SET hash = ''");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('index_settings');
  pgm.dropColumns('api_calls', ['url_text']);
  pgm.dropColumns('components', ['props', 'effects', 'render', 'handlers']);
}
```

Run: `pnpm vitest run core/src/store/migrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing store tests**

Append to `core/src/store/store.test.ts`:

```ts
describe('store: React facts, API calls and index settings', () => {
  let store: Store;
  const form: FileFacts = {
    path: 'web/Form.tsx',
    hash: 'h-form-1',
    language: 'typescript',
    symbols: [
      { name: 'Form', kind: 'component', startLine: 3, endLine: 12, exported: true, signature: null },
      { name: 'Form.submit', kind: 'function', startLine: 5, endLine: 7, exported: false, signature: null },
    ],
    calls: [],
    imports: [],
    reactFacts: [
      {
        symbol: { name: 'Form', startLine: 3 },
        propsType: 'Props',
        props: ['onDone'],
        state: [{ name: 'v', setter: 'setV', hook: 'useState', initial: "''", line: 4 }],
        hooks: [{ name: 'useSave', line: 8, callee: { file: 'web/useSave.ts', name: 'useSave', startLine: 1 }, package: null, bindings: ['save'], callbacks: [] }],
        context: [],
        effects: [{ hook: 'useEffect', line: 9, endLine: 9, deps: null, binding: null }],
        render: [{ element: 'form', kind: 'element', line: 10, depth: 0, component: null, package: null, props: [{ name: 'onSubmit', value: 'submit' }], condition: null }],
        handlers: [{ element: 'form', event: 'onSubmit', handler: 'submit', line: 10, endLine: 10, target: { file: 'web/Form.tsx', name: 'Form.submit', startLine: 5 } }],
      },
    ],
    apiCalls: [],
  };
  const useSave: FileFacts = {
    path: 'web/useSave.ts',
    hash: 'h-save-1',
    language: 'typescript',
    symbols: [{ name: 'useSave', kind: 'hook', startLine: 1, endLine: 6, exported: true, signature: null }],
    calls: [],
    imports: [],
    reactFacts: [{ symbol: { name: 'useSave', startLine: 1 }, propsType: null, props: [], state: [], hooks: [], context: [], effects: [], render: [], handlers: [] }],
    apiCalls: [{ symbol: { name: 'useSave', startLine: 1 }, method: 'POST', urlPattern: '/api/save', urlText: "'/api/save'", line: 3 }],
  };
  const idOf = async (file: string, name: string) => (await store.findSymbol(file, name))[0].id;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_react_${randomBytes(4).toString('hex')}` });
    await store.migrate();
    await store.applyIndexChanges({ files: [form, useSave] });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('round-trips React facts', async () => {
    const formId = await idOf('web/Form.tsx', 'Form');
    const { symbol: _, ...rest } = form.reactFacts![0];
    expect(await store.getReactFacts([formId])).toEqual([{ symbolId: formId, ...rest }]);
  });

  it('round-trips API calls', async () => {
    const hookId = await idOf('web/useSave.ts', 'useSave');
    expect(await store.getApiCalls([hookId])).toEqual([
      { id: expect.any(Number), symbolId: hookId, method: 'POST', urlPattern: '/api/save', urlText: "'/api/save'", line: 3 },
    ]);
  });

  it('finds symbols by key in one query, leaving out keys that match nothing', async () => {
    const found = await store.getSymbolsByKeys([
      { file: 'web/useSave.ts', name: 'useSave', startLine: 1 },
      { file: 'web/Form.tsx', name: 'Form.submit', startLine: 5 },
      { file: 'web/Form.tsx', name: 'Nope', startLine: 1 },
    ]);
    expect(found.map((s) => `${s.file}#${s.name}`)).toEqual(['web/Form.tsx#Form.submit', 'web/useSave.ts#useSave']);
  });

  it('a call refresh replaces React facts and API calls, keeping symbol ids', async () => {
    const hookId = await idOf('web/useSave.ts', 'useSave');
    await store.applyIndexChanges({
      callRefreshes: [
        {
          path: 'web/useSave.ts',
          calls: [],
          reactFacts: useSave.reactFacts,
          apiCalls: [{ symbol: { name: 'useSave', startLine: 1 }, method: 'PUT', urlPattern: '/api/save/:id', urlText: '`/api/save/${id}`', line: 4 }],
        },
      ],
    });
    expect((await store.getApiCalls([hookId])).map((c) => `${c.method} ${c.urlPattern}`)).toEqual(['PUT /api/save/:id']);
    expect(await store.getReactFacts([hookId])).toHaveLength(1);
  });

  it('stores index settings; resetting one clears every file hash', async () => {
    expect(await store.getIndexSetting('extraction')).toBeNull();
    await store.resetIndexForSetting('extraction', 'v1');
    expect(await store.getIndexSetting('extraction')).toBe('v1');
    expect(new Set((await store.getFileHashes()).values())).toEqual(new Set(['']));
  });
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `pnpm vitest run core/src/store/store.test.ts -t "React facts"`
Expected: FAIL: `store.getReactFacts is not a function`.

- [ ] **Step 6: Implement the store**

In `core/src/store/types.ts`, after `SideEffectRecord`, add:

```ts
/** A component's or hook's React facts, as read back for context building. */
export interface ReactFactRecord extends Omit<ReactFact, 'symbol'> {
  symbolId: number;
}

export interface ApiCallRecord {
  id: number;
  symbolId: number;
  method: string;
  urlPattern: string;
  urlText: string;
  line: number;
}
```

In `core/src/store/store.ts`:

1. Add `ApiCallRecord`, `ReactFactRecord`, `SymbolKey` to the type import list.

2. In `applyIndexChanges`, after the existing `DELETE FROM side_effects …` statement, add:

```ts
      for (const table of ['components', 'api_calls']) {
        await client.query(
          `DELETE FROM ${table} WHERE symbol_id IN (
             SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ANY($1::text[]))`,
          [refreshPaths],
        );
      }
```

3. In `applyIndexChanges`, after `assertCount('side_effects', …)`, add:

```ts
      const reactFacts = factSources.flatMap((f) => (f.reactFacts ?? []).map((r) => ({ ...r, file: f.path })));
      const insertedReact = await client.query(
        `INSERT INTO components (symbol_id, props_type, props, state_vars, hooks_used, context_used, effects, render, handlers)
         SELECT s.id, x."propsType", x.props, x.state, x.hooks, x.context, x.effects, x.render, x.handlers
         FROM jsonb_to_recordset($1::jsonb) AS x(file text, symbol jsonb, "propsType" text, props jsonb, state jsonb, hooks jsonb,
                                                 context jsonb, effects jsonb, render jsonb, handlers jsonb)
         JOIN files f ON f.path = x.file
         JOIN symbols s ON s.file_id = f.id AND s.name = x.symbol->>'name' AND s.start_line = (x.symbol->>'startLine')::int`,
        [JSON.stringify(reactFacts)],
      );
      assertCount('components', insertedReact.rowCount, reactFacts.length);

      const apiCalls = factSources.flatMap((f) => (f.apiCalls ?? []).map((a) => ({ ...a, file: f.path })));
      const insertedApi = await client.query(
        `INSERT INTO api_calls (symbol_id, method, url_pattern, url_text, line)
         SELECT s.id, x.method, x."urlPattern", x."urlText", x.line
         FROM jsonb_to_recordset($1::jsonb) AS x(file text, symbol jsonb, method text, "urlPattern" text, "urlText" text, line int)
         JOIN files f ON f.path = x.file
         JOIN symbols s ON s.file_id = f.id AND s.name = x.symbol->>'name' AND s.start_line = (x.symbol->>'startLine')::int`,
        [JSON.stringify(apiCalls)],
      );
      assertCount('api_calls', insertedApi.rowCount, apiCalls.length);
```

4. Add these methods to `Store` (after `getRouteWarnings`):

```ts
  /** React facts of the given components/hooks, one query. */
  async getReactFacts(symbolIds: number[]): Promise<ReactFactRecord[]> {
    const { rows } = await this.pool.query<ReactFactRow>(
      `SELECT symbol_id, props_type, props, state_vars, hooks_used, context_used, effects, render, handlers
       FROM components WHERE symbol_id = ANY($1::bigint[]) ORDER BY symbol_id`,
      [symbolIds],
    );
    return rows.map((r) => ({
      symbolId: Number(r.symbol_id), propsType: r.props_type, props: r.props, state: r.state_vars, hooks: r.hooks_used,
      context: r.context_used, effects: r.effects, render: r.render, handlers: r.handlers,
    }));
  }

  /** API calls made by the given symbols, by symbol then line. One query. */
  async getApiCalls(symbolIds: number[]): Promise<ApiCallRecord[]> {
    const { rows } = await this.pool.query<{ id: string; symbol_id: string; method: string; url_pattern: string; url_text: string; line: number }>(
      `SELECT id, symbol_id, method, url_pattern, url_text, line FROM api_calls
       WHERE symbol_id = ANY($1::bigint[]) ORDER BY symbol_id, line, id`,
      [symbolIds],
    );
    return rows.map((r) => ({ id: Number(r.id), symbolId: Number(r.symbol_id), method: r.method, urlPattern: r.url_pattern, urlText: r.url_text, line: r.line }));
  }

  /** The symbols the keys name, in one query; keys that match nothing are left out. */
  async getSymbolsByKeys(keys: SymbolKey[]): Promise<SymbolRecord[]> {
    const { rows } = await this.pool.query<SymbolRow>(
      `SELECT DISTINCT s.id, f.path AS file, s.name, s.kind, s.start_line, s.end_line, s.exported, s.signature
       FROM jsonb_to_recordset($1::jsonb) AS k(file text, name text, "startLine" int)
       JOIN files f ON f.path = k.file
       JOIN symbols s ON s.file_id = f.id AND s.name = k.name AND s.start_line = k."startLine"
       ORDER BY f.path, s.start_line`,
      [JSON.stringify(keys)],
    );
    return rows.map(toSymbolRecord);
  }

  async getIndexSetting(key: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ value: string }>('SELECT value FROM index_settings WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  /** Records a new extraction setting and marks every file as changed, so the next index pass re-extracts all of them. */
  async resetIndexForSetting(key: string, value: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE files SET hash = ''");
      await client.query(
        'INSERT INTO index_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, value],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
```

5. Next to the other row interfaces, add:

```ts
interface ReactFactRow {
  symbol_id: string;
  props_type: string | null;
  props: ReactFactRecord['props'];
  state_vars: ReactFactRecord['state'];
  hooks_used: ReactFactRecord['hooks'];
  context_used: ReactFactRecord['context'];
  effects: ReactFactRecord['effects'];
  render: ReactFactRecord['render'];
  handlers: ReactFactRecord['handlers'];
}
```

Run: `pnpm vitest run core/src/store`
Expected: PASS.

- [ ] **Step 7: Write the failing indexer test**

Append to `core/src/indexer/indexer.test.ts`:

```ts
describe('indexRepo: React facts, API calls and extraction settings', () => {
  let store: Store;
  const config = loadConfig(FIXTURE);
  const id = async (file: string, name: string) => (await store.findSymbol(file, name))[0].id;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_idx4_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, config, store);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('stores React facts for components and hooks', async () => {
    const [form] = await store.getReactFacts([await id('web/components/EnrollForm.tsx', 'EnrollForm')]);
    expect(form.hooks.map((h) => h.name)).toEqual(['useState', 'useEnrollMutation']);
    expect(form.handlers[0]).toMatchObject({ event: 'onSubmit', target: { name: 'EnrollForm.handleSubmit' } });
    const [hook] = await store.getReactFacts([await id('web/hooks/usePatient.ts', 'usePatient')]);
    expect(hook.effects).toEqual([{ hook: 'useEffect', line: 9, endLine: 23, deps: ['id'], binding: null }]);
  });

  it('stores API calls found through the configured wrappers', async () => {
    const calls = await store.getApiCalls([await id('web/hooks/useEnrollMutation.ts', 'useEnrollMutation.mutate'), await id('web/hooks/usePatient.ts', 'usePatient')]);
    expect(calls.map((c) => `${c.method} ${c.urlPattern} :${c.line}`).sort()).toEqual(['GET /api/patients/:id :13', 'POST /api/patients/enroll :19']);
  });

  it('re-extracts unchanged files when apiClientWrappers changes, and only once', async () => {
    const noWrappers = { ...config, apiClientWrappers: [] };
    const result = await indexRepo(FIXTURE, noWrappers, store);
    expect(result.changed).toHaveLength(result.scanned);
    expect(await store.getApiCalls([await id('web/hooks/useEnrollMutation.ts', 'useEnrollMutation.mutate')])).toEqual([]);
    expect((await indexRepo(FIXTURE, noWrappers, store)).changed).toEqual([]);
    expect((await indexRepo(FIXTURE, config, store)).changed).toHaveLength(result.scanned);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm vitest run core/src/indexer/indexer.test.ts -t "extraction settings"`
Expected: the first two pass and the third FAILS: `changed` is `[]`, because nothing re-extracts on a config change.

- [ ] **Step 9: Implement the settings check**

In `core/src/indexer/index.ts`, add `import { createHash } from 'node:crypto';`, then add:

```ts
/** index_settings key for the config values that change what extraction produces. */
export const EXTRACTION_SETTINGS = 'extraction';

/** Changes when a config value that affects extraction changes (CLAUDE.md §10: apiClientWrappers). */
export function extractionSettingsHash(config: WalkConfig): string {
  return createHash('sha256').update(JSON.stringify({ apiClientWrappers: config.apiClientWrappers })).digest('hex');
}
```

and in `indexRepo`, replace `const stored = await store.getFileHashes();` with:

```ts
  // A config change (e.g. a new API client wrapper) changes the facts of files whose content didn't change.
  const settings = extractionSettingsHash(config);
  if ((await store.getIndexSetting(EXTRACTION_SETTINGS)) !== settings) await store.resetIndexForSetting(EXTRACTION_SETTINGS, settings);
  const stored = await store.getFileHashes();
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm vitest run core/src/indexer core/src/store`
Expected: PASS (including the existing incremental-index tests: the settings hash is stable across their runs).

- [ ] **Step 11: Checkpoint**

Do not commit. `pnpm --filter @codewalk/core exec tsc --noEmit` is clean.

---

### Task 5: Component target and context

**Files:**
- Modify: `core/src/context/target.ts`, `core/src/context/fn.ts`, `core/src/context/index.ts`
- Create: `core/src/context/component.ts`
- Test: `core/src/context/component.test.ts`

**Interfaces:**
- Consumes: `getReactFacts`, `getApiCalls`, `getSymbolsByKeys`, `getSymbolsInFile`, `getCallees`, `getFile` (Store); `declarationsUsed`; `SourceCache`, `Budget`, `collectPackages`, `NON_CODE_KINDS`, `PROMPT_RESERVE_TOKENS` (shared).
- Produces:
  - `ComponentTarget = { file: string; name: string | null }`; `parseComponentTarget(arg: string): ComponentTarget`.
  - `resolveTypes(store, refs: DeclarationRef[]): Promise<SymbolRecord[]>` (now exported from `fn.ts`).
  - Types `ReactUnit`, `ExpandedHook`, `ChildComponent`, `ApiTrigger`, `ComponentApiCall`, `ComponentContext`, `ComponentContextOptions` (shapes below).
  - `buildComponentContext(store, repoRoot, target: ComponentTarget, options: { depth: number; maxContextTokens: number }): Promise<ComponentContext>`
  - `structureHashOf(ctx: Pick<ComponentContext, 'component' | 'hooks' | 'children' | 'apiCalls'>): string`
  - `currentStructureHash(store, repoRoot, scopeRef: string, depth: number): Promise<string | null>`: null when the component is gone.
  - `describeTrigger(t: ApiTrigger): string`, e.g. `"onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate"`.

- [ ] **Step 1: Write the failing test**

Create `core/src/context/component.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { indexRepo } from '../indexer/index.js';
import { openStore, type Store } from '../store/index.js';
import { buildComponentContext, currentStructureHash, describeTrigger, type ComponentContext } from './component.js';
import { parseComponentTarget, TargetError } from './target.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const OPTIONS = { depth: 2, maxContextTokens: 60000 };
const schema = (tag: string) => `cw_test_${tag}_${Math.random().toString(16).slice(2, 10)}`;

describe('parseComponentTarget', () => {
  it('accepts a file with or without a component name', () => {
    expect(parseComponentTarget('./web/components/EnrollForm.tsx#EnrollForm')).toEqual({ file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' });
    expect(parseComponentTarget('web/components/EnrollForm.tsx')).toEqual({ file: 'web/components/EnrollForm.tsx', name: null });
  });

  it('rejects line ranges and empty names', () => {
    expect(() => parseComponentTarget('web/a.tsx:1-5')).toThrow(/use `walk fn web\/a\.tsx:1-5`/);
    expect(() => parseComponentTarget('web/a.tsx#')).toThrow(TargetError);
  });
});

describe('buildComponentContext on the fixture', () => {
  let store: Store;
  let ctx: ComponentContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: schema('cmp') });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildComponentContext(store, FIXTURE, { file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' }, OPTIONS);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('collects the component, its handlers and its custom hook (Phase 4 acceptance)', () => {
    expect(ctx.scopeRef).toBe('web/components/EnrollForm.tsx#EnrollForm');
    expect(ctx.component.code).toMatchObject({ file: 'web/components/EnrollForm.tsx', start: 18, end: 54 });
    expect(ctx.component.inner.map((s) => s.name)).toEqual(['EnrollForm.handleChange', 'EnrollForm.handleSubmit']);
    expect(ctx.hooks.map((h) => `${h.depth} ${h.usedBy} → ${h.symbol.name} at ${h.calledAt}`)).toEqual(['1 EnrollForm → useEnrollMutation at web/components/EnrollForm.tsx:20']);
    expect(ctx.hooks[0].inner.map((s) => s.name)).toEqual(['useEnrollMutation.mutate']);
    expect(ctx.hooks[0].code).toMatchObject({ file: 'web/hooks/useEnrollMutation.ts', start: 11, end: 29 });
  });

  it('detects the API call and the user action that triggers it (Phase 4 acceptance)', () => {
    expect(ctx.apiCalls).toEqual([
      {
        symbol: { id: expect.any(Number), file: 'web/hooks/useEnrollMutation.ts', name: 'useEnrollMutation.mutate' },
        method: 'POST',
        urlPattern: '/api/patients/enroll',
        urlText: "'/api/patients/enroll'",
        line: 19,
        triggers: [{ kind: 'event', label: 'onSubmit on <form>', at: 'web/components/EnrollForm.tsx:39', path: ['EnrollForm.handleSubmit', 'useEnrollMutation.mutate'] }],
      },
    ]);
    expect(describeTrigger(ctx.apiCalls[0].triggers[0])).toBe(
      'onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate',
    );
  });

  it('shows children one level deep and says so', () => {
    expect(ctx.children.map((c) => `${c.element}:${c.line}:${c.symbol?.name}`)).toEqual(['FormField:40:FormField', 'FormField:41:FormField', 'FormField:42:FormField', 'FormField:43:FormField']);
    expect(ctx.limits).toContain(
      'FormField (web/components/FormField.tsx:11): internals not expanded; child components are shown one level deep. Run `walk component web/components/FormField.tsx#FormField`.',
    );
  });

  it('lists calls, leaving out calls between owners, with bodies of direct repo callees', () => {
    expect(ctx.callees.some((c) => c.callee?.name === 'useEnrollMutation' || c.callee?.name === 'useEnrollMutation.mutate')).toBe(false);
    const post = ctx.callees.find((c) => c.callee?.name === 'api.post')!;
    expect(post).toMatchObject({ depth: 1, caller: { name: 'useEnrollMutation.mutate' }, code: { file: 'web/apiClient.ts', start: 28, end: 28 } });
  });

  it('explains unresolved callbacks and props with likely sources', () => {
    expect(ctx.unresolved.map((u) => u.note)).toEqual(
      expect.arrayContaining([
        'unresolved: likely the `onSuccess` callback EnrollForm passes to useEnrollMutation (web/components/EnrollForm.tsx:21)',
        'unresolved: likely the `onEnrolled` prop, supplied by whoever renders EnrollForm (call at web/components/EnrollForm.tsx:23)',
      ]),
    );
  });

  it('includes the types and values used, and every cited file', () => {
    expect(ctx.types.map((t) => t.symbol.name)).toEqual(expect.arrayContaining(['EnrollFormProps', 'EnrollFormValues', 'PatientDto', 'Options']));
    expect(ctx.values.map((v) => v.name)).toContain('EMPTY_FORM');
    expect(Object.keys(ctx.files)).toEqual(
      expect.arrayContaining(['web/apiClient.ts', 'web/components/EnrollForm.tsx', 'web/components/FormField.tsx', 'web/hooks/useEnrollMutation.ts', 'web/types.ts']),
    );
  });

  it('finds an effect-triggered API call; the file alone selects its only component', async () => {
    const summary = await buildComponentContext(store, FIXTURE, { file: 'web/components/PatientSummary.tsx', name: null }, OPTIONS);
    expect(summary.component.symbol.name).toBe('PatientSummary');
    expect(summary.apiCalls.map((a) => ({ call: `${a.method} ${a.urlPattern}`, triggers: a.triggers }))).toEqual([
      { call: 'GET /api/patients/:id', triggers: [{ kind: 'effect', label: 'useEffect [id] in usePatient', at: 'web/hooks/usePatient.ts:9', path: ['usePatient'] }] },
    ]);
  });

  it('rejects hooks, files without components and unknown names', async () => {
    const build = (file: string, name: string | null) => buildComponentContext(store, FIXTURE, { file, name }, OPTIONS);
    await expect(build('web/hooks/usePatient.ts', 'usePatient')).rejects.toThrow(/usePatient in web\/hooks\/usePatient\.ts is a hook, not a React component; use `walk fn web\/hooks\/usePatient\.ts#usePatient`/);
    await expect(build('web/apiClient.ts', null)).rejects.toThrow(/No React components in web\/apiClient\.ts/);
    await expect(build('web/components/EnrollForm.tsx', 'Nope')).rejects.toThrow(/No component "Nope" in web\/components\/EnrollForm\.tsx\. Components here: EnrollForm/);
  });

  it('has a stable structure hash that currentStructureHash reproduces; null once the component is gone', async () => {
    expect(ctx.structureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await currentStructureHash(store, FIXTURE, ctx.scopeRef, 2)).toBe(ctx.structureHash);
    expect(await currentStructureHash(store, FIXTURE, 'web/components/EnrollForm.tsx#Gone', 2)).toBeNull();
  });
});

describe('buildComponentContext depth limits', () => {
  let repo: string;
  let store: Store;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-cmp-depth-'));
    cpSync(FIXTURE, repo, { recursive: true });
    writeFileSync(join(repo, 'web/hooks/useSession.ts'), "import { useState } from 'react';\n\nexport function useSession() {\n  const [token] = useState('');\n  return token;\n}\n");
    const hook = join(repo, 'web/hooks/useEnrollMutation.ts');
    const text = readFileSync(hook, 'utf8').replace("useState<Status>('idle');", "useState<Status>('idle'); useSession();");
    writeFileSync(hook, `${text}import { useSession } from './useSession';\n`);
    store = await openStore({ url: DATABASE_URL, schema: schema('cmpd') });
    await store.migrate();
    await indexRepo(repo, loadConfig(repo), store);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('expands nested hooks up to --depth and states what it left out', async () => {
    const target = { file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' };
    const shallow = await buildComponentContext(store, repo, target, { ...OPTIONS, depth: 1 });
    expect(shallow.hooks.map((h) => h.symbol.name)).toEqual(['useEnrollMutation']);
    expect(shallow.limits).toContain('useSession (used by useEnrollMutation at web/hooks/useEnrollMutation.ts:12) is not expanded: --depth 1');
    const deep = await buildComponentContext(store, repo, target, { ...OPTIONS, depth: 2 });
    expect(deep.hooks.map((h) => `${h.depth} ${h.symbol.name}`)).toEqual(['1 useEnrollMutation', '2 useSession']);
    expect(deep.structureHash).not.toBe(shallow.structureHash);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run core/src/context/component.test.ts`
Expected: FAIL: cannot resolve `./component.js`, and `parseComponentTarget` is not exported.

- [ ] **Step 3: Add the target parser and export `resolveTypes`**

In `core/src/context/target.ts`, append:

```ts
/** `walk component <file>[#<ComponentName>]`; a null name means "the file's only component". */
export interface ComponentTarget {
  file: string;
  name: string | null;
}

export function parseComponentTarget(arg: string): ComponentTarget {
  const hash = arg.lastIndexOf('#');
  const file = normalizeFile(hash > 0 ? arg.slice(0, hash) : arg);
  const name = hash > 0 ? arg.slice(hash + 1).trim() : null;
  if (!file) throw new TargetError('Expected <file>[#<ComponentName>], e.g. web/components/EnrollForm.tsx#EnrollForm');
  if (name === '') throw new TargetError(`Missing component name after "#" in "${arg}"`);
  if (RANGE.test(file)) throw new TargetError(`"${arg}" is a line range; use \`walk fn ${arg}\` instead.`);
  return { file, name };
}
```

In `core/src/context/fn.ts`, change `async function resolveTypes(` to `export async function resolveTypes(`.

In `core/src/context/index.ts`, change the target export line to:

```ts
export { parseComponentTarget, parseFileTarget, parseFnTarget, TargetError, type ComponentTarget, type FnTarget } from './target.js';
```

and append `export * from './component.js';`.

- [ ] **Step 4: Implement the context builder**

Create `core/src/context/component.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Store } from '../store/index.js';
import type { ApiCallRecord, ReactFactRecord, SymbolKey, SymbolRecord } from '../store/types.js';
import { declarationsUsed, type DeclarationRef } from './declarations.js';
import { resolveTypes, type CalleeFact, type CodeBlock, type PackageFact, type TypeFact, type UnresolvedFact, type ValueFact } from './fn.js';
import { Budget, collectPackages, NON_CODE_KINDS, PROMPT_RESERVE_TOKENS, SourceCache } from './shared.js';
import { parseComponentTarget, TargetError, type ComponentTarget } from './target.js';

// Selects the code and static facts for `walk component` (CLAUDE.md §6.4): the component, the repo
// hooks it uses (expanded to --depth), its children one level deep, its handlers and effects, the code
// they call, and every API call reachable from them with the user action or effect that triggers it.
// The same object is the `--no-llm` output and the LLM's only input.

export interface ReactUnit {
  symbol: SymbolRecord;
  facts: ReactFactRecord;
  /** Null when it didn't fit the context budget. */
  code: CodeBlock | null;
  /** Functions declared inside it: event handlers, functions a hook returns. */
  inner: SymbolRecord[];
}

export interface ExpandedHook extends ReactUnit {
  /** 1 for hooks the component calls, 2 for hooks those call, ... */
  depth: number;
  /** Name of the component or hook that calls it. */
  usedBy: string;
  /** "file:line" of that call. */
  calledAt: string;
}

export interface ChildComponent {
  element: string;
  /** The repo component rendered (signature only); null for package components. */
  symbol: SymbolRecord | null;
  package: string | null;
  line: number;
  props: { name: string; value: string }[];
  condition: string | null;
}

export interface ApiTrigger {
  kind: 'event' | 'effect';
  /** e.g. "onSubmit on <form>", "useEffect [id] in usePatient". */
  label: string;
  /** "file:line" of the handler attribute or effect call. */
  at: string;
  /** Functions from the trigger to the call, e.g. ["EnrollForm.handleSubmit", "useEnrollMutation.mutate"]. */
  path: string[];
}

export interface ComponentApiCall {
  symbol: Pick<SymbolRecord, 'id' | 'file' | 'name'>;
  method: string;
  urlPattern: string;
  urlText: string;
  line: number;
  triggers: ApiTrigger[];
}

export interface ComponentContext {
  /** "<file>#<Component>"; the saved walkthrough's scope. */
  scopeRef: string;
  component: ReactUnit;
  /** Repo custom hooks, breadth first; package hooks are only listed in the facts. */
  hooks: ExpandedHook[];
  /** Component elements in the render tree, one level deep. */
  children: ChildComponent[];
  /** Calls made by the component, its hooks and their inner functions, to --depth; calls between them are left out. */
  callees: CalleeFact[];
  types: TypeFact[];
  values: ValueFact[];
  apiCalls: ComponentApiCall[];
  packages: PackageFact[];
  unresolved: UnresolvedFact[];
  /** Line count of every file the context cites; the verifier's bounds. */
  files: Record<string, number>;
  /** What was left out to fit the token budget. */
  omitted: string[];
  /** What the depth limits left out (CLAUDE.md §13). */
  limits: string[];
  warnings: string[];
  /** Hash of the hooks, children, handlers and API calls; a saved walkthrough is stale when it changes. */
  structureHash: string;
}

export interface ComponentContextOptions {
  depth: number;
  maxContextTokens: number;
}

const EFFECT_TRIGGERS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);

export async function buildComponentContext(store: Store, repoRoot: string, target: ComponentTarget, options: ComponentContextOptions): Promise<ComponentContext> {
  const fileRecord = await store.getFile(target.file);
  if (!fileRecord) {
    throw new TargetError(`${target.file} is not in the index. Check the path (relative to the repo root) or run \`walk index\`.`);
  }
  const source = new SourceCache(repoRoot);
  const warnings: string[] = [];
  if (source.hash(target.file) !== fileRecord.hash) {
    warnings.push(`${target.file} changed since it was indexed; run \`walk index\` for accurate facts.`);
  }

  const symbolsOf = fileSymbolsLoader(store);
  const symbol = pickComponent(target, await symbolsOf(target.file));
  const [facts] = await store.getReactFacts([symbol.id]);
  if (!facts) throw new TargetError(`No React facts for ${symbol.name}; run \`walk index\` to re-extract ${target.file}.`);
  const component: ReactUnit = { symbol, facts, code: null, inner: innerOf(symbol, await symbolsOf(symbol.file)) };

  const limits: string[] = [];
  const hooks = await expandHooks(store, component, options.depth, symbolsOf, limits);
  const units: ReactUnit[] = [component, ...hooks];

  // Code in priority order: the component (must fit), hooks (shallowest first), types, values, callees.
  const budget = new Budget(options.maxContextTokens - PROMPT_RESERVE_TOKENS);
  const omitted: string[] = [];
  component.code = source.block(symbol.file, symbol.startLine, symbol.endLine);
  if (!budget.take(component.code)) {
    throw new TargetError(
      `${symbol.name} (${symbol.file}:${symbol.startLine}-${symbol.endLine}) is too large for llm.maxContextTokens (${options.maxContextTokens}); walk its parts with \`walk fn\`.`,
    );
  }
  for (const h of hooks) {
    const block = source.block(h.symbol.file, h.symbol.startLine, h.symbol.endLine);
    if (budget.take(block)) h.code = block;
    else omitted.push(`body of hook ${h.symbol.name} (${h.symbol.file}:${h.symbol.startLine})`);
  }

  const inUnits = (ref: DeclarationRef) => units.some((u) => ref.file === u.symbol.file && ref.line >= u.symbol.startLine && ref.line <= u.symbol.endLine);
  const used = units.map((u) => declarationsUsed(repoRoot, u.symbol.file, u.symbol.startLine, u.symbol.endLine));
  const types: TypeFact[] = (await resolveTypes(store, used.flatMap((d) => d.types).filter((r) => !inUnits(r)))).map((s) => {
    const code = source.block(s.file, s.startLine, s.endLine);
    if (budget.take(code)) return { symbol: s, code };
    omitted.push(`body of type ${s.name} (${s.file}:${s.startLine})`);
    return { symbol: s, code: null };
  });
  const valueRefs = uniqueBy(used.flatMap((d) => d.values).filter((v) => !inUnits(v)), (v) => `${v.file}:${v.line}`);
  const values: ValueFact[] = valueRefs.map((v) => {
    const code = source.block(v.file, v.line, v.endLine);
    const fact = { name: v.name, file: v.file, startLine: v.line, endLine: v.endLine };
    if (budget.take(code)) return { ...fact, code };
    omitted.push(`declaration of ${v.name} (${v.file}:${v.line})`);
    return { ...fact, code: null };
  });

  const owners = uniqueBy(units.flatMap((u) => [u.symbol, ...u.inner]).filter((o) => !NON_CODE_KINDS.has(o.kind)), (o) => String(o.id));
  const { callees: calls, edges } = await collectCallees(store, owners, options.depth);
  const shown = new Set<number>();
  const callees: CalleeFact[] = calls.map((c) => {
    if (c.depth !== 1 || !c.callee || NON_CODE_KINDS.has(c.callee.kind) || shown.has(c.callee.id)) return { ...c, code: null };
    shown.add(c.callee.id);
    const block = source.block(c.callee.file, c.callee.startLine, c.callee.endLine);
    if (budget.take(block)) return { ...c, code: block };
    omitted.push(`body of ${c.callee.name} (${c.callee.file}:${c.callee.startLine})`);
    return { ...c, code: null };
  });

  const childRecords = await store.getSymbolsByKeys(facts.render.flatMap((r) => (r.kind === 'component' && r.component ? [r.component] : [])));
  const children: ChildComponent[] = facts.render
    .filter((r) => r.kind === 'component')
    .map((r) => ({
      element: r.element,
      symbol: (r.component && childRecords.find((s) => sameKey(s, r.component!))) || null,
      package: r.package,
      line: r.line,
      props: r.props,
      condition: r.condition,
    }));
  for (const s of childRecords) {
    limits.push(`${s.name} (${s.file}:${s.startLine}): internals not expanded; child components are shown one level deep. Run \`walk component ${s.file}#${s.name}\`.`);
  }

  const calleeSymbols = uniqueBy(callees.flatMap((c) => (c.callee ? [c.callee] : [])), (s) => String(s.id));
  const reached = new Map<number, SymbolRecord>([...owners, ...calleeSymbols].map((s) => [s.id, s]));
  const graph = new CallGraph(edges, reached);
  const handlerTargets = await store.getSymbolsByKeys(facts.handlers.flatMap((h) => (h.target ? [h.target] : [])));
  const apiCalls: ComponentApiCall[] = (await store.getApiCalls([...reached.keys()])).map((row) => {
    const s = reached.get(row.symbolId)!;
    return {
      symbol: { id: s.id, file: s.file, name: s.name },
      method: row.method,
      urlPattern: row.urlPattern,
      urlText: row.urlText,
      line: row.line,
      triggers: triggersOf(row, component, units, handlerTargets, graph),
    };
  });

  const unitOf = new Map<number, ReactUnit>();
  for (const u of units) for (const s of [u.symbol, ...u.inner]) unitOf.set(s.id, u);
  const unresolved: UnresolvedFact[] = callees
    .filter((c) => !c.resolved)
    .map((c) => ({ calleeText: c.calleeText, file: c.caller.file, line: c.callLine, note: unresolvedNote(c, unitOf.get(c.caller.id), units) }));

  const cited = [
    ...units.map((u) => u.symbol.file),
    ...callees.flatMap((c) => [c.caller.file, ...(c.callee ? [c.callee.file] : [])]),
    ...types.map((t) => t.symbol.file),
    ...values.map((v) => v.file),
    ...childRecords.map((s) => s.file),
  ];
  const files = Object.fromEntries([...new Set(cited)].sort().map((f) => [f, source.lineCount(f)]));

  const ctx = {
    scopeRef: `${symbol.file}#${symbol.name}`,
    component,
    hooks,
    children,
    callees,
    types,
    values,
    apiCalls,
    packages: await collectPackages(store, Object.keys(files)),
    unresolved,
    files,
    omitted,
    limits,
    warnings,
  };
  return { ...ctx, structureHash: structureHashOf(ctx) };
}

/** Changes when the hooks expanded, the children, the handler bindings or the API calls (and their triggers) change. Line moves don't count. */
export function structureHashOf(ctx: Pick<ComponentContext, 'component' | 'hooks' | 'children' | 'apiCalls'>): string {
  const key = (s: { file: string; name: string }) => `${s.file}#${s.name}`;
  const lines = [
    `component ${key(ctx.component.symbol)}`,
    ...ctx.hooks.map((h) => `hook ${h.depth} ${h.usedBy} ${key(h.symbol)}`),
    ...ctx.children.map((c) => `child ${c.element} ${c.symbol ? key(c.symbol) : (c.package ?? '-')}`),
    ...ctx.component.facts.handlers.map((h) => `handler ${h.event} ${h.element} ${h.handler}`),
    ...ctx.apiCalls.map((a) => `api ${a.method} ${a.urlPattern} ${key(a.symbol)} ${a.triggers.map((t) => `${t.label}:${t.path.join('>')}`).join(',')}`),
  ];
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The structure hash a saved component walkthrough would have now; null when the component is gone. */
export async function currentStructureHash(store: Store, repoRoot: string, scopeRef: string, depth: number): Promise<string | null> {
  try {
    const ctx = await buildComponentContext(store, repoRoot, parseComponentTarget(scopeRef), { depth, maxContextTokens: Number.MAX_SAFE_INTEGER });
    return ctx.structureHash;
  } catch (err) {
    if (err instanceof TargetError) return null;
    throw err;
  }
}

export function describeTrigger(t: ApiTrigger): string {
  return `${t.label} (${t.at}) → ${t.path.join(' → ')}`;
}

function pickComponent(target: ComponentTarget, fileSymbols: SymbolRecord[]): SymbolRecord {
  const components = fileSymbols.filter((s) => s.kind === 'component');
  const list = components.map((c) => c.name).join(', ');
  if (target.name === null) {
    if (components.length === 1) return components[0];
    if (components.length === 0) throw new TargetError(`No React components in ${target.file}. Use \`walk file ${target.file}\` for other code.`);
    throw new TargetError(`${target.file} has ${components.length} components (${list}); name one, e.g. \`walk component ${target.file}#${components[0].name}\`.`);
  }
  const matches = fileSymbols.filter((s) => s.name === target.name);
  if (matches.length === 0) throw new TargetError(`No component "${target.name}" in ${target.file}.${list ? ` Components here: ${list}` : ''}`);
  const [match] = matches;
  if (match.kind !== 'component') {
    throw new TargetError(`${target.name} in ${target.file} is a ${match.kind}, not a React component; use \`walk fn ${target.file}#${target.name}\` instead.`);
  }
  if (matches.length > 1) throw new TargetError(`"${target.name}" is ambiguous in ${target.file}; it is declared ${matches.length} times.`);
  return match;
}

/** Repo hooks reachable through `hooks_used.callee`, breadth first, each expanded once, up to `maxDepth`. */
async function expandHooks(
  store: Store,
  component: ReactUnit,
  maxDepth: number,
  symbolsOf: (file: string) => Promise<SymbolRecord[]>,
  limits: string[],
): Promise<ExpandedHook[]> {
  const hooks: ExpandedHook[] = [];
  const seen = new Set<number>([component.symbol.id]);
  let frontier: ReactUnit[] = [component];
  for (let depth = 1; frontier.length > 0; depth++) {
    const uses = frontier.flatMap((unit) => unit.facts.hooks.flatMap((use) => (use.callee ? [{ unit, use, key: use.callee }] : [])));
    const found = await store.getSymbolsByKeys(uses.map((u) => u.key));
    const factsById = new Map((await store.getReactFacts(found.map((s) => s.id))).map((f) => [f.symbolId, f]));
    const next: ExpandedHook[] = [];
    for (const { unit, use, key } of uses) {
      const calledAt = `${unit.symbol.file}:${use.line}`;
      const symbol = found.find((s) => sameKey(s, key));
      if (!symbol) {
        limits.push(`${use.name} at ${calledAt}: hook not found in the index; run \`walk index\``);
        continue;
      }
      if (seen.has(symbol.id)) continue;
      seen.add(symbol.id);
      const facts = factsById.get(symbol.id);
      if (depth > maxDepth || !facts) {
        limits.push(`${symbol.name} (used by ${unit.symbol.name} at ${calledAt}) is not expanded: --depth ${maxDepth}`);
        continue;
      }
      const hook: ExpandedHook = { symbol, facts, code: null, inner: innerOf(symbol, await symbolsOf(symbol.file)), depth, usedBy: unit.symbol.name, calledAt };
      hooks.push(hook);
      next.push(hook);
    }
    frontier = next;
  }
  return hooks;
}

interface Edge {
  from: number;
  to: number;
  line: number;
}

/**
 * Calls made by `owners`, transitively to `maxDepth` (owners are depth 0), one recursive query per owner.
 * Every resolved call becomes an edge (for trigger paths); calls into another owner are left out of the
 * list, because each owner is explained in full on its own.
 */
async function collectCallees(store: Store, owners: SymbolRecord[], maxDepth: number): Promise<{ callees: Omit<CalleeFact, 'code'>[]; edges: Edge[] }> {
  const ownerIds = new Set(owners.map((o) => o.id));
  const known = new Map<number, Pick<SymbolRecord, 'id' | 'file' | 'name'>>(owners.map((o) => [o.id, o]));
  const depthOf = new Map<number, number>(owners.map((o) => [o.id, 0]));
  const rows = (await Promise.all(owners.map((o) => store.getCallees(o.id, maxDepth)))).flat().sort((a, b) => a.depth - b.depth);
  const seen = new Set<string>();
  const callees: Omit<CalleeFact, 'code'>[] = [];
  const edges: Edge[] = [];
  for (const row of rows) {
    const key = `${row.callerId}:${row.callLine}:${row.calleeText}`;
    const callerDepth = depthOf.get(row.callerId);
    const caller = known.get(row.callerId);
    if (seen.has(key) || callerDepth === undefined || !caller || callerDepth >= maxDepth) continue;
    seen.add(key);
    if (row.callee) {
      edges.push({ from: row.callerId, to: row.callee.id, line: row.callLine });
      if (!depthOf.has(row.callee.id)) {
        depthOf.set(row.callee.id, callerDepth + 1);
        known.set(row.callee.id, row.callee);
      }
      if (ownerIds.has(row.callee.id)) continue;
    }
    callees.push({
      depth: callerDepth + 1,
      caller: { id: caller.id, file: caller.file, name: caller.name },
      callee: row.callee,
      calleeText: row.calleeText,
      callLine: row.callLine,
      resolved: row.resolved,
    });
  }
  return { callees, edges };
}

class CallGraph {
  private readonly out = new Map<number, Edge[]>();

  constructor(
    private readonly edges: Edge[],
    private readonly symbols: Map<number, SymbolRecord>,
  ) {
    for (const e of edges) this.out.set(e.from, [...(this.out.get(e.from) ?? []), e]);
  }

  /** Shortest path of symbol ids from any of `starts` to `goal`, or null. */
  pathFrom(starts: number[], goal: number): number[] | null {
    const parent = new Map<number, number | null>();
    const queue: number[] = [];
    for (const s of starts) {
      if (!parent.has(s)) {
        parent.set(s, null);
        queue.push(s);
      }
    }
    while (queue.length > 0) {
      const n = queue.shift()!;
      if (n === goal) {
        const path: number[] = [];
        for (let x: number | null = n; x !== null; x = parent.get(x) ?? null) path.unshift(x);
        return path;
      }
      for (const e of this.out.get(n) ?? []) {
        if (!parent.has(e.to)) {
          parent.set(e.to, n);
          queue.push(e.to);
        }
      }
    }
    return null;
  }

  /** Path to `call` from code inside lines start..end of `ownerId` (an inline handler or an effect callback). */
  pathWithin(ownerId: number, start: number, end: number, call: ApiCallRecord): number[] | null {
    if (call.symbolId === ownerId && call.line >= start && call.line <= end) return [ownerId];
    const starts = this.edges.filter((e) => e.from === ownerId && e.line >= start && e.line <= end).map((e) => e.to);
    const path = this.pathFrom(starts, call.symbolId);
    return path && [ownerId, ...path];
  }

  names(path: number[]): string[] {
    return path.map((id) => this.symbols.get(id)?.name ?? `#${id}`);
  }
}

/** The handler bindings of the component and the effects of every unit from which `call` is reachable. */
function triggersOf(call: ApiCallRecord, component: ReactUnit, units: ReactUnit[], handlerTargets: SymbolRecord[], graph: CallGraph): ApiTrigger[] {
  const triggers = new Map<string, ApiTrigger>();
  const add = (t: ApiTrigger) => triggers.set(`${t.label}@${t.at}`, t);
  for (const h of component.facts.handlers) {
    const target = h.target ? handlerTargets.find((s) => sameKey(s, h.target!)) : undefined;
    const path = target ? graph.pathFrom([target.id], call.symbolId) : graph.pathWithin(component.symbol.id, h.line, h.endLine, call);
    if (path) add({ kind: 'event', label: `${h.event} on <${h.element}>`, at: `${component.symbol.file}:${h.line}`, path: graph.names(path) });
  }
  for (const u of units) {
    for (const e of u.facts.effects) {
      if (!EFFECT_TRIGGERS.has(e.hook)) continue;
      const path = graph.pathWithin(u.symbol.id, e.line, e.endLine, call);
      const deps = e.deps ? `[${e.deps.join(', ')}]` : '(every render)';
      if (path) add({ kind: 'effect', label: `${e.hook} ${deps} in ${u.symbol.name}`, at: `${u.symbol.file}:${e.line}`, path: graph.names(path) });
    }
  }
  return [...triggers.values()];
}

/** "unresolved: likely ..." for a call the indexer couldn't resolve, using what the React facts show. */
function unresolvedNote(c: Omit<CalleeFact, 'code'>, unit: ReactUnit | undefined, units: ReactUnit[]): string {
  const at = `${c.caller.file}:${c.callLine}`;
  if (unit) {
    for (const u of units) {
      for (const use of u.facts.hooks) {
        const callback = use.callee && sameKey(unit.symbol, use.callee) ? use.callbacks.find((cb) => cb.name === c.calleeText) : undefined;
        if (callback) return `unresolved: likely the \`${c.calleeText}\` callback ${u.symbol.name} passes to ${unit.symbol.name} (${u.symbol.file}:${callback.line})`;
      }
    }
    if (unit.facts.props.includes(c.calleeText)) {
      return unit.symbol.kind === 'component'
        ? `unresolved: likely the \`${c.calleeText}\` prop, supplied by whoever renders ${unit.symbol.name} (call at ${at})`
        : `unresolved: likely the \`${c.calleeText}\` argument of ${unit.symbol.name} (call at ${at})`;
    }
  }
  return `unresolved: likely ${c.calleeText} (dynamic call in ${c.caller.name} at ${at})`;
}

function innerOf(symbol: SymbolRecord, fileSymbols: SymbolRecord[]): SymbolRecord[] {
  return fileSymbols.filter((s) => s.id !== symbol.id && s.startLine >= symbol.startLine && s.endLine <= symbol.endLine && !NON_CODE_KINDS.has(s.kind));
}

function fileSymbolsLoader(store: Store): (file: string) => Promise<SymbolRecord[]> {
  const cache = new Map<string, Promise<SymbolRecord[]>>();
  return (file) => {
    if (!cache.has(file)) cache.set(file, store.getSymbolsInFile(file));
    return cache.get(file)!;
  };
}

function sameKey(s: Pick<SymbolRecord, 'file' | 'name' | 'startLine'>, k: SymbolKey): boolean {
  return s.file === k.file && s.name === k.name && s.startLine === k.startLine;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run core/src/context`
Expected: PASS. If the `onEnrolled` note test fails, debug it with `--no-llm` output in Task 8 or a `console.log(ctx.callees)`. Check whether `onEnrolled` comes out as `resolved: false` with caller `EnrollForm`. Fix the cause, not the test.

- [ ] **Step 6: Checkpoint**

Do not commit. `pnpm --filter @codewalk/core exec tsc --noEmit` is clean.

---

### Task 6: Verifier facts, prompt, recorded response, and `explainComponent`

**Files:**
- Modify: `core/src/verify/verify.ts`
- Create: `core/src/llm/componentPrompt.ts`; modify `core/src/llm/index.ts`
- Create: `core/src/llm/__fixtures__/enrollForm.response.json`
- Create: `core/src/walkthrough/explain.ts`
- Modify: `core/src/walkthrough/endpoint.ts` (use `explainGrounded`)
- Create: `core/src/walkthrough/component.ts`; modify `core/src/walkthrough/index.ts`
- Test: `core/src/walkthrough/component.test.ts`

**Interfaces:**
- Consumes: `ComponentContext`, `describeTrigger` (Task 5); `verifyWalkthrough`, `vocabularyOf`, `VerifyFacts`; `generateWalkthrough`; `describe`, `fence` (`llm/prompt.ts`).
- Produces:
  - `componentVerifyFacts(ctx: ComponentContext): VerifyFacts`
  - `COMPONENT_SYSTEM_PROMPT: string`; `renderComponentPrompt(ctx: ComponentContext): string`
  - `explainGrounded(provider, request: GroundedRequest, repoRoot): Promise<FnWalkthrough>`, where `GroundedRequest = { system: string; prompt: string; facts: VerifyFacts; packages: PackageFact[]; unresolved: string[]; scope: FnWalkthrough['scope'] }`.
  - `explainComponent(provider, ctx: ComponentContext, repoRoot): Promise<FnWalkthrough>`; `scope = { file, start, end, symbol: <component name> }`.

- [ ] **Step 1: Write the recorded response**

Create `core/src/llm/__fixtures__/enrollForm.response.json`:

```json
{
  "title": "How EnrollForm works",
  "summary": "EnrollForm keeps the form values in state, renders controlled fields, and on submit calls the mutate function of useEnrollMutation, which posts the values to /api/patients/enroll and reports success back through onSuccess.",
  "stages": [
    {
      "name": "Inputs and state",
      "steps": [
        {
          "id": "s1",
          "code_ref": { "file": "web/components/EnrollForm.tsx", "start": 18, "end": 19 },
          "explanation": "`EnrollForm` receives one prop, `onEnrolled`, typed by `EnrollFormProps`. It owns one piece of state: `values`, created with `useState` from `EMPTY_FORM`, with `setValues` to replace it.",
          "example": {
            "input": "props { onEnrolled: (patient) => showPatient(patient.id) }; the form mounts",
            "state_after": "values = { firstName: '', lastName: '', phone: '', dateOfBirth: '', consentGiven: false }"
          },
          "references": [
            { "file": "web/components/EnrollForm.tsx", "line": 6, "role": "type" },
            { "file": "web/types.ts", "line": 1, "role": "type" }
          ],
          "docs": [{ "package": "react", "symbol": "useState" }],
          "concepts": ["props", "component state"],
          "risks": []
        }
      ]
    },
    {
      "name": "Render",
      "steps": [
        {
          "id": "s2",
          "code_ref": { "file": "web/components/EnrollForm.tsx", "start": 38, "end": 53 },
          "explanation": "`EnrollForm` renders a `form` whose `onSubmit` is `handleSubmit`. Four `FormField` children each get a `label`, a `name`, the matching field of `values` and `handleChange` as `onChange`. A checkbox is bound to `values.consentGiven`, an alert `p` appears only when `error` is set, and the `button` is disabled while `status` is `submitting` or consent is missing.",
          "example": {
            "input": "first render with the empty form",
            "state_after": "four empty FormField inputs, unchecked consent box, no alert, button disabled (no consent yet)"
          },
          "references": [{ "file": "web/components/FormField.tsx", "line": 11, "role": "callee" }],
          "docs": [],
          "concepts": ["controlled inputs", "conditional rendering"],
          "risks": []
        }
      ]
    },
    {
      "name": "Hook: useEnrollMutation",
      "steps": [
        {
          "id": "s3",
          "code_ref": { "file": "web/hooks/useEnrollMutation.ts", "start": 11, "end": 13 },
          "explanation": "`useEnrollMutation` takes an optional `onSuccess` callback and owns two pieces of state: `status`, starting at `idle`, and `error`, starting at `null`.",
          "example": { "input": "useEnrollMutation({ onSuccess }) called by EnrollForm", "state_after": "status = 'idle'; error = null" },
          "references": [{ "file": "web/components/EnrollForm.tsx", "line": 20, "role": "caller" }],
          "docs": [{ "package": "react", "symbol": "useState" }],
          "concepts": ["custom hook"],
          "risks": []
        },
        {
          "id": "s4",
          "code_ref": { "file": "web/hooks/useEnrollMutation.ts", "start": 15, "end": 26 },
          "explanation": "`mutate` sets `status` to `submitting` and clears `error`, then awaits `api.post` with the form `values`. On success it sets `status` to `success` and calls `onSuccess` with the returned `patient`. If the request throws, it sets `status` to `error` and picks a message: an `ApiError` with status 409 means the patient is already enrolled.",
          "example": {
            "input": "mutate({ firstName: 'Asha', lastName: 'Rao', phone: '+91 98765 43210', dateOfBirth: '1990-04-02', consentGiven: true })",
            "state_after": "status = 'success'; error = null; patient = { id: 'p_101', firstName: 'Asha', ... } (server response assumed)"
          },
          "references": [
            { "file": "web/apiClient.ts", "line": 28, "role": "callee" },
            { "file": "web/components/EnrollForm.tsx", "line": 35, "role": "caller" }
          ],
          "docs": [],
          "concepts": ["async request state"],
          "risks": ["A 409 shows 'This patient is already enrolled.'; any other failure shows 'Enrollment failed.'"]
        }
      ]
    },
    {
      "name": "Event handlers",
      "steps": [
        {
          "id": "s5",
          "code_ref": { "file": "web/components/EnrollForm.tsx", "start": 27, "end": 30 },
          "explanation": "`handleChange` reads `name`, `value`, `type` and `checked` from the changed input and updates `values` with `setValues`, using `checked` for the checkbox and `value` for text fields.",
          "example": { "input": "the user types Asha into First name", "state_after": "values.firstName = 'Asha'" },
          "references": [{ "file": "web/components/EnrollForm.tsx", "line": 40, "role": "caller" }],
          "docs": [],
          "concepts": ["controlled inputs"],
          "risks": []
        },
        {
          "id": "s6",
          "code_ref": { "file": "web/components/EnrollForm.tsx", "start": 32, "end": 36 },
          "explanation": "`handleSubmit` stops the browser's own form submission with `preventDefault`, does nothing unless `values.consentGiven` is true, and then calls `mutate` with `values`.",
          "example": { "input": "the user ticks consent and clicks Enroll", "state_after": "mutate(values) called; status = 'submitting'" },
          "references": [{ "file": "web/hooks/useEnrollMutation.ts", "line": 15, "role": "callee" }],
          "docs": [],
          "concepts": ["form submission"],
          "risks": ["Without consent the click does nothing (the button is also disabled)."]
        },
        {
          "id": "s7",
          "code_ref": { "file": "web/components/EnrollForm.tsx", "start": 20, "end": 25 },
          "explanation": "The `onSuccess` callback EnrollForm passes to `useEnrollMutation` resets the form with `setValues` to `EMPTY_FORM` and hands the new `patient` to `onEnrolled`.",
          "example": { "input": "the enroll request succeeded with patient p_101", "state_after": "values = EMPTY_FORM; onEnrolled(patient) called" },
          "references": [{ "file": "web/hooks/useEnrollMutation.ts", "line": 21, "role": "caller" }],
          "docs": [],
          "concepts": ["callback props"],
          "risks": []
        }
      ]
    },
    {
      "name": "Data fetching",
      "steps": [
        {
          "id": "s8",
          "code_ref": { "file": "web/hooks/useEnrollMutation.ts", "start": 19, "end": 19 },
          "explanation": "`api.post` sends `POST /api/patients/enroll` with `values` as the JSON body. It is reached from `onSubmit` on the `form` through `handleSubmit` and `mutate`.",
          "example": {
            "input": "POST /api/patients/enroll with the values above",
            "state_after": "request sent with Content-Type application/json and the bearer token from localStorage"
          },
          "references": [
            { "file": "web/apiClient.ts", "line": 28, "role": "callee" },
            { "file": "web/components/EnrollForm.tsx", "line": 39, "role": "caller" }
          ],
          "docs": [],
          "concepts": ["REST API call"],
          "risks": ["Network errors and non-2xx responses throw ApiError, which mutate turns into an error message."]
        }
      ]
    }
  ],
  "unresolved": []
}
```

- [ ] **Step 2: Write the failing test**

Create `core/src/walkthrough/component.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildComponentContext, type ComponentContext } from '../context/component.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmMessage, LlmProvider } from '../llm/generate.js';
import { openStore, type Store } from '../store/index.js';
import { explainComponent } from './component.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollForm.response.json', import.meta.url), 'utf8');

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

describe('explainComponent on the fixture', () => {
  let store: Store;
  let ctx: ComponentContext;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_cmpw_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    ctx = await buildComponentContext(store, FIXTURE, { file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' }, { depth: 2, maxContextTokens: 60000 });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('keeps every grounded step in the fixed stage order (Phase 4 acceptance)', async () => {
    const { provider, requests } = replay(RECORDED);
    const w = await explainComponent(provider, ctx, FIXTURE);
    expect(w.verification.dropped).toEqual([]);
    expect(w.verification.keptSteps).toBe(8);
    expect(w.stages.map((s) => s.name)).toEqual(['Inputs and state', 'Render', 'Hook: useEnrollMutation', 'Event handlers', 'Data fetching']);
    expect(w.scope).toEqual({ file: 'web/components/EnrollForm.tsx', start: 18, end: 54, symbol: 'EnrollForm' });
    expect(w.stages[0].steps[0].docLinks[0]).toMatchObject({ package: 'react', symbol: 'useState' });
    expect(w.unresolved).toEqual(expect.arrayContaining([expect.stringContaining('`onSuccess` callback EnrollForm passes to useEnrollMutation')]));

    const prompt = requests[0][0].content;
    expect(prompt.split('\n')[0]).toBe('# Component: EnrollForm (web/components/EnrollForm.tsx:18-54)');
    expect(prompt).toContain('## Hook: useEnrollMutation (depth 1, called by EnrollForm at web/components/EnrollForm.tsx:20)');
    expect(prompt).toContain(
      '- POST /api/patients/enroll in useEnrollMutation.mutate (web/hooks/useEnrollMutation.ts:19) ← onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate',
    );
  });

  it('drops a step that names an identifier outside the context', async () => {
    const bad = JSON.parse(RECORDED);
    bad.stages[1].steps[0].explanation = 'It renders `ModalDialog`.';
    const { provider } = replay(JSON.stringify(bad));
    const w = await explainComponent(provider, ctx, FIXTURE);
    expect(w.verification.dropped.map((d) => d.stepId)).toEqual(['s2']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run core/src/walkthrough/component.test.ts`
Expected: FAIL: cannot resolve `./component.js`.

- [ ] **Step 4: Add the verifier facts**

In `core/src/verify/verify.ts`, add `import type { ComponentContext } from '../context/component.js';` and, after `endpointVerifyFacts`, add:

```ts
/** Everything a component walkthrough may name or cite. */
export function componentVerifyFacts(ctx: ComponentContext): VerifyFacts {
  const units = [ctx.component, ...ctx.hooks];
  const symbols = [
    ...units.flatMap((u) => [u.symbol, ...u.inner]),
    ...ctx.callees.flatMap((c) => (c.callee ? [c.callee] : [])),
    ...ctx.types.map((t) => t.symbol),
    ...ctx.children.flatMap((c) => (c.symbol ? [c.symbol] : [])),
  ];
  return {
    files: ctx.files,
    packages: new Set(ctx.packages.map((p) => p.name)),
    vocabulary: vocabularyOf([
      ...units.map((u) => u.code?.lines.join('\n')),
      ...ctx.callees.map((c) => c.code?.lines.join('\n')),
      ...ctx.types.map((t) => t.code?.lines.join('\n')),
      ...ctx.values.flatMap((v) => [v.name, v.code?.lines.join('\n')]),
      ...symbols.flatMap((s) => [s.name, s.signature]),
      ...ctx.callees.map((c) => c.calleeText),
      ...ctx.children.flatMap((c) => [c.element, ...c.props.flatMap((p) => [p.name, p.value])]),
      ...ctx.apiCalls.flatMap((a) => [a.method, a.urlPattern, a.urlText]),
      ...units.flatMap((u) => [u.facts.propsType, ...u.facts.props, ...u.facts.state.flatMap((s) => [s.name, s.setter, s.initial]), ...u.facts.context.map((x) => x.context)]),
      ...ctx.packages.flatMap((p) => [p.name, ...p.importedNames]),
    ]),
  };
}
```

- [ ] **Step 5: Add the prompt**

Create `core/src/llm/componentPrompt.ts`:

```ts
import { describeTrigger, type ComponentContext, type ReactUnit } from '../context/component.js';
import { describe, fence } from './prompt.js';

// Turns a ComponentContext into the prompt. Same contract as `walk fn` (CLAUDE.md §8.2): the model
// sees only these facts and cites only them; the verifier enforces it afterwards.

export const COMPONENT_SYSTEM_PROMPT = `You explain how one React component of a TypeScript frontend works, to a developer who must be able to explain it to someone else afterwards.

You are given facts from static analysis: the component's props, the state it owns, the context it reads, the hooks it calls (custom hooks from the repo are expanded with their code), its render tree, its event handlers, the code those call, and the API calls it can trigger with the handler or effect that leads to each. Explain only what these facts show.

Rules:
- Never invent files, line numbers, symbols or behaviour. If something is not in the facts, say it is unknown or put it in "unresolved".
- Use these stages, in this order, and leave out any with no steps: "Inputs and state" (props, state, context), "Render" (what it renders, the children and props passed down, conditional branches), "Effects and derived values" (useEffect, useMemo, useCallback in the component itself), then one stage per expanded custom hook named exactly "Hook: <hook name>" in the order the hooks are listed, then "Event handlers" (one step per user action or callback: what state changes and what calls fire), then "Data fetching" (one step per API call: its method, URL pattern and the handler or effect that triggers it).
- Each step covers a contiguous group of lines in ONE file: "code_ref" is a file listed under "Files you may cite" and a start/end line inside code shown to you.
- "explanation": what the lines do and why, in plain English. Wrap every identifier and code expression in backticks, and only use identifiers that appear in the given code or facts.
- "example": invent ONE concrete set of props and ONE realistic user interaction (or the first render, if the component has no handlers) at the first step, and trace that same example through every step. "input" names the props, event or call in effect; "state_after" lists the state variables, hook results and requests after the step. Compute values carefully from the code; when a value depends on code you were not shown (a server response, a package, an unresolved call), say what it is assumed to be.
- "references": only file:line locations given in the facts (definitions, call sites, handler attributes), with role "caller", "callee" or "type". Use an empty list when none apply.
- "docs": only for calls into packages listed under "Packages". "package" is the package name exactly as listed and "symbol" is the API used (e.g. "useState", "useEffect"). Never write URLs.
- "concepts": short names of general ideas a reader should know (e.g. "controlled input", "effect dependencies").
- "risks": what can go wrong at this step and what the user then sees (failed requests, missing effect dependencies, stale state). Empty list if none.
- Step ids are unique, e.g. "s1", "s2".
- "unresolved": copy every note listed under "Unresolved", plus anything else you could not determine.`;

export function renderComponentPrompt(ctx: ComponentContext): string {
  const out: string[] = [];
  const c = ctx.component;
  const f = c.facts;
  out.push(`# Component: ${c.symbol.name} (${c.symbol.file}:${c.symbol.startLine}-${c.symbol.endLine})`);

  out.push('## Props');
  out.push(f.props.length ? `${f.props.map((p) => `\`${p}\``).join(', ')}${f.propsType ? ` (type \`${f.propsType}\`)` : ''}` : '(none)');

  out.push('## State, context, hooks and effects');
  pushUnitFacts(out, c);

  out.push('## Render tree (component elements, and elements with handlers or conditions)');
  if (f.render.length === 0) out.push('(no JSX found)');
  for (const r of f.render) {
    const props = r.props.length ? `: ${r.props.map((p) => `${p.name}={${p.value}}`).join(' ')}` : '';
    out.push(`${'  '.repeat(r.depth)}- <${r.element}> at ${c.symbol.file}:${r.line}${r.condition ? ` when \`${r.condition}\`` : ''}${props}`);
  }

  out.push('## Event handlers');
  if (f.handlers.length === 0) out.push('(none)');
  for (const h of f.handlers) out.push(`- ${h.event} on <${h.element}> at ${c.symbol.file}:${h.line} runs \`${h.handler}\``);

  out.push('## Component code');
  if (c.code) out.push(fence(c.code));

  for (const h of ctx.hooks) {
    out.push(`## Hook: ${h.symbol.name} (depth ${h.depth}, called by ${h.usedBy} at ${h.calledAt})`);
    pushUnitFacts(out, h);
    out.push(h.code ? fence(h.code) : '(body left out to fit the context budget)');
  }

  out.push('## Child components (rendered, not expanded)');
  if (ctx.children.length === 0) out.push('(none)');
  for (const ch of ctx.children) {
    const what = ch.symbol ? describe(ch.symbol) : ch.package ? `from package ${ch.package}` : '(not found in the index)';
    out.push(`- <${ch.element}> at ${c.symbol.file}:${ch.line}${ch.condition ? ` when \`${ch.condition}\`` : ''}: ${what}`);
  }

  out.push('## API calls');
  if (ctx.apiCalls.length === 0) out.push('(none found)');
  for (const a of ctx.apiCalls) {
    const triggers = a.triggers.length ? ` ← ${a.triggers.map(describeTrigger).join('; ')}` : ' (no trigger found in this component)';
    out.push(`- ${a.method} ${a.urlPattern} in ${a.symbol.name} (${a.symbol.file}:${a.line})${triggers}`);
  }

  out.push('## Called code');
  if (ctx.callees.length === 0) out.push('(none)');
  for (const k of ctx.callees) {
    const where = `${k.caller.name} at ${k.caller.file}:${k.callLine}`;
    if (k.callee) {
      out.push(`- [depth ${k.depth}] ${where} calls ${describe(k.callee)}`);
      if (k.code) out.push(fence(k.code));
    } else {
      out.push(`- [depth ${k.depth}] ${where} calls \`${k.calleeText}\` (${k.resolved ? 'package or built-in' : 'UNRESOLVED dynamic call'})`);
    }
  }

  out.push('## Types used');
  if (ctx.types.length === 0) out.push('(none)');
  for (const t of ctx.types) {
    out.push(`- ${describe(t.symbol)}`);
    if (t.code) out.push(fence(t.code));
  }

  out.push('## Module-level values used');
  if (ctx.values.length === 0) out.push('(none)');
  for (const v of ctx.values) {
    out.push(`- \`${v.name}\` (${v.file}:${v.startLine})`);
    if (v.code) out.push(fence(v.code));
  }

  out.push('## Packages (imported by the files above)');
  if (ctx.packages.length === 0) out.push('(none)');
  for (const p of ctx.packages) out.push(`- ${p.name}${p.version ? `@${p.version}` : ''} (from "${p.importedPath}"): ${p.importedNames.join(', ')}`);

  if (ctx.unresolved.length > 0) {
    out.push('## Unresolved');
    for (const u of ctx.unresolved) out.push(`- ${u.note}`);
  }
  if (ctx.limits.length > 0) {
    out.push('## Not expanded (depth limits)');
    for (const l of ctx.limits) out.push(`- ${l}`);
  }
  if (ctx.omitted.length > 0) {
    out.push('## Left out to fit the context budget');
    for (const o of ctx.omitted) out.push(`- ${o}`);
  }

  out.push('## Files you may cite (with line counts)');
  for (const [file, lines] of Object.entries(ctx.files)) out.push(`- ${file}: ${lines} lines`);

  out.push(`Write the walkthrough of ${c.symbol.name}.`);
  return out.join('\n\n');
}

function pushUnitFacts(out: string[], u: ReactUnit): void {
  const f = u.facts;
  const file = u.symbol.file;
  const lines = [
    ...(u.symbol.kind === 'hook' && f.props.length ? [`- parameters: ${f.props.map((p) => `\`${p}\``).join(', ')}${f.propsType ? ` (type \`${f.propsType}\`)` : ''}`] : []),
    ...f.state.map((s) => `- state \`${s.name}\`${s.setter ? ` (setter \`${s.setter}\`)` : ''} from ${s.hook}${s.initial !== null ? `, initially \`${s.initial}\`` : ''} at ${file}:${s.line}`),
    ...f.context.map((x) => `- reads context \`${x.context}\` at ${file}:${x.line}`),
    ...f.hooks.map((h) => `- calls hook \`${h.name}\` at ${file}:${h.line}${h.callee ? ' (custom hook from this repo)' : h.package ? ` (from ${h.package})` : ''}`),
    ...f.effects.map(
      (e) =>
        `- ${e.hook} at ${file}:${e.line}-${e.endLine}${e.deps ? ` with deps [${e.deps.join(', ')}]` : ' with no deps array (runs after every render)'}${e.binding ? ` -> \`${e.binding}\`` : ''}`,
    ),
  ];
  out.push(lines.length ? lines.join('\n') : '(no state, context, hooks or effects)');
}
```

In `core/src/llm/index.ts`, append: `export { COMPONENT_SYSTEM_PROMPT, renderComponentPrompt } from './componentPrompt.js';`

- [ ] **Step 6: Extract the shared explain step, then add `explainComponent`**

Create `core/src/walkthrough/explain.ts`:

```ts
import { dirname, join } from 'node:path';
import type { PackageFact } from '../context/fn.js';
import { DocsResolver } from '../docs/resolve.js';
import { generateWalkthrough, type LlmProvider } from '../llm/generate.js';
import { verifyWalkthrough, type VerifyFacts } from '../verify/verify.js';
import { NoVerifiedStepsError, type FnWalkthrough } from './fn.js';

// Generate -> verify -> docs links for walkthroughs whose steps may cite several files (endpoint,
// component). Docs resolve from each step's own file's directory (nearest package.json / node_modules).

export interface GroundedRequest {
  system: string;
  prompt: string;
  facts: VerifyFacts;
  packages: PackageFact[];
  /** Static unresolved notes; always kept, whatever the model returns. */
  unresolved: string[];
  scope: FnWalkthrough['scope'];
}

export async function explainGrounded(provider: LlmProvider, request: GroundedRequest, repoRoot: string): Promise<FnWalkthrough> {
  const { walkthrough, attempts } = await generateWalkthrough(provider, { system: request.system, prompt: request.prompt });
  const verified = verifyWalkthrough(walkthrough, request.facts);
  const keptSteps = verified.walkthrough.stages.reduce((n, s) => n + s.steps.length, 0);
  if (keptSteps === 0) throw new NoVerifiedStepsError(verified.dropped);

  const packages = new Map(request.packages.map((p) => [p.name, p]));
  const resolvers = new Map<string, DocsResolver>();
  const docsFor = (file: string) => {
    const dir = dirname(join(repoRoot, file));
    if (!resolvers.has(dir)) resolvers.set(dir, new DocsResolver(repoRoot, dir));
    return resolvers.get(dir)!;
  };

  return {
    scope: request.scope,
    title: verified.walkthrough.title,
    summary: verified.walkthrough.summary,
    stages: verified.walkthrough.stages.map((stage) => ({
      name: stage.name,
      steps: stage.steps.map((step) => ({ ...step, docLinks: step.docs.map((d) => docsFor(step.code_ref.file).resolve(d, packages.get(d.package)!)) })),
    })),
    unresolved: [...new Set([...request.unresolved, ...verified.walkthrough.unresolved])],
    verification: { attempts, keptSteps, dropped: verified.dropped, removedDocs: verified.removedDocs },
  };
}
```

In `core/src/walkthrough/endpoint.ts`, replace the body of `explainEndpoint` with a call to it (and remove the now-unused imports `dirname`, `join`, `DocsResolver`, `generateWalkthrough`, `verifyWalkthrough`, `NoVerifiedStepsError`; keep `LlmProvider` as a type import from `../llm/generate.js`):

```ts
export async function explainEndpoint(provider: LlmProvider, ctx: EndpointContext, repoRoot: string): Promise<FnWalkthrough> {
  const handler = ctx.chain.at(-1)!;
  return explainGrounded(
    provider,
    {
      system: ENDPOINT_SYSTEM_PROMPT,
      prompt: renderEndpointPrompt(ctx),
      facts: endpointVerifyFacts(ctx),
      packages: ctx.packages,
      unresolved: ctx.unresolved.map((u) => u.note),
      scope: {
        file: handler.symbol?.file ?? handler.registeredAt.file,
        start: handler.symbol?.startLine ?? handler.registeredAt.line,
        end: handler.symbol?.endLine ?? handler.registeredAt.endLine,
        symbol: ctx.scopeRef,
      },
    },
    repoRoot,
  );
}
```

with `import { explainGrounded } from './explain.js';` and `import { endpointVerifyFacts } from '../verify/verify.js';`.

Create `core/src/walkthrough/component.ts` (Task 7 adds more to it):

```ts
import type { ComponentContext } from '../context/component.js';
import { COMPONENT_SYSTEM_PROMPT, renderComponentPrompt } from '../llm/componentPrompt.js';
import type { LlmProvider } from '../llm/generate.js';
import { componentVerifyFacts } from '../verify/verify.js';
import { explainGrounded } from './explain.js';
import type { FnWalkthrough } from './fn.js';

// `walk component` after the facts are gathered: LLM -> verifier -> docs links (CLAUDE.md §6.4, §8.3).

export async function explainComponent(provider: LlmProvider, ctx: ComponentContext, repoRoot: string): Promise<FnWalkthrough> {
  const s = ctx.component.symbol;
  return explainGrounded(
    provider,
    {
      system: COMPONENT_SYSTEM_PROMPT,
      prompt: renderComponentPrompt(ctx),
      facts: componentVerifyFacts(ctx),
      packages: ctx.packages,
      unresolved: ctx.unresolved.map((u) => u.note),
      scope: { file: s.file, start: s.startLine, end: s.endLine, symbol: s.name },
    },
    repoRoot,
  );
}
```

In `core/src/walkthrough/index.ts`, append `export { explainComponent } from './component.js';`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run core/src/walkthrough core/src/verify`
Expected: PASS: the new component tests, plus the existing endpoint tests unchanged after the `explainGrounded` refactor. If a component step is dropped, read its `reasons`. Fix the recorded response only if it cites something that really isn't in the fixture. Never widen the vocabulary to make a step pass.

- [ ] **Step 8: Checkpoint**

Do not commit. `pnpm --filter @codewalk/core exec tsc --noEmit` is clean.

---

### Task 7: Sections, staleness, overview and Markdown for components

**Files:**
- Modify: `core/src/walkthrough/saved.ts`, `core/src/walkthrough/staleness.ts`, `core/src/walkthrough/endpoint.ts`, `core/src/walkthrough/component.ts`, `core/src/walkthrough/index.ts`
- Modify: `core/src/render/markdown.ts`
- Modify: `cli/src/commands/endpoint.ts`, `core/src/walkthrough/endpointSection.test.ts` (rename only)
- Test: `core/src/walkthrough/componentSection.test.ts`

**Interfaces:**
- Consumes: `ComponentContext`, `structureHashOf`, `describeTrigger` (Task 5); `explainComponent` (Task 6); `recordSection`, `hashLines` (existing).
- Produces:
  - `ScopeKind = 'fn' | 'file' | 'endpoint' | 'component'`
  - `ComponentOverview` (shape below); `SavedWalkthrough.component?: ComponentOverview`; `componentNotes(o: ComponentOverview): string[]`
  - `componentBlocks(ctx): BlockRef[]`, with the component first, then hooks, direct callees, types, then values (symbol `null`, relocated by text).
  - `generateComponentSection(provider, ctx, repoRoot, { model, depth }): Promise<Section>`: `blocks` set, `chainHash = ctx.structureHash`.
  - `componentOverviewOf(ctx): ComponentOverview`
  - `reuseMultiBlockSection(prev, current: { blocks: BlockRef[]; chainHash: string }, files, depth): Section | null` (renamed from `reuseEndpointSection`; behaviour unchanged).
  - `checkWalkthrough` applies `chains` to `endpoint` **and** `component` scopes.

- [ ] **Step 1: Write the failing test**

Create `core/src/walkthrough/componentSection.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildComponentContext } from '../context/component.js';
import { indexRepo } from '../indexer/index.js';
import type { LlmProvider } from '../llm/generate.js';
import { renderMarkdown } from '../render/markdown.js';
import { openStore, type Store } from '../store/index.js';
import { componentBlocks, componentOverviewOf, generateComponentSection } from './component.js';
import { reuseMultiBlockSection } from './endpoint.js';
import { codeReader } from './persist.js';
import { componentNotes, SAVED_VERSION, sourceFiles, type SavedWalkthrough, type Section } from './saved.js';
import { checkWalkthrough, filesOf, loadCurrentSource } from './staleness.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../llm/__fixtures__/enrollForm.response.json', import.meta.url), 'utf8');
const recorded: LlmProvider = { generate: async () => RECORDED };
const TARGET = { file: 'web/components/EnrollForm.tsx', name: 'EnrollForm' };
const OPTIONS = { depth: 2, maxContextTokens: 60000 };

describe('component sections and staleness', () => {
  let repo: string;
  let store: Store;
  let section: Section;

  const context = async () => {
    await indexRepo(repo, loadConfig(repo), store);
    return buildComponentContext(store, repo, TARGET, OPTIONS);
  };
  const edit = (file: string, from: string, to: string) => {
    const path = join(repo, file);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(from);
    writeFileSync(path, text.replace(from, to));
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cw-cmp-sec-'));
    cpSync(FIXTURE, repo, { recursive: true });
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_cmps_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    const ctx = await context();
    section = await generateComponentSection(recorded, ctx, repo, { model: 'recorded', depth: 2 });
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('records every explained block, the component first, and the structure hash', async () => {
    const ctx = await context();
    expect(section.blocks!.map((b) => `${b.file}#${b.symbol}`).slice(0, 3)).toEqual([
      'web/components/EnrollForm.tsx#EnrollForm',
      'web/hooks/useEnrollMutation.ts#useEnrollMutation',
      'web/apiClient.ts#api.post',
    ]);
    expect(section.blocks!.some((b) => b.symbol === null && b.file === 'web/components/EnrollForm.tsx' && b.start === 10)).toBe(true);
    expect(section.chainHash).toBe(ctx.structureHash);
  });

  it('builds the overview and its notes from the index', async () => {
    const notes = componentNotes(componentOverviewOf(await context()));
    expect(notes).toEqual(
      expect.arrayContaining([
        'Component: EnrollForm (web/components/EnrollForm.tsx)',
        'Props: onEnrolled — EnrollFormProps',
        'State: values / setValues (useState, initially EMPTY_FORM) at web/components/EnrollForm.tsx:19',
        'Hooks: useState (react), useEnrollMutation (expanded)',
        'Handler: onSubmit on <form> → handleSubmit at web/components/EnrollForm.tsx:39',
        'API call: POST /api/patients/enroll at web/hooks/useEnrollMutation.ts:19 ← onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate',
      ]),
    );
  });

  it('reuses the section while the code is unchanged', async () => {
    const ctx = await context();
    const reused = reuseMultiBlockSection(section, { blocks: componentBlocks(ctx), chainHash: ctx.structureHash }, sourceFiles(repo), 2);
    expect(reused?.walkthrough.stages).toEqual(section.walkthrough.stages);
  });

  it('shifts steps when a line is added above the component, without regenerating', async () => {
    edit('web/components/EnrollForm.tsx', 'export function EnrollForm(', '// Enrollment form.\nexport function EnrollForm(');
    const ctx = await context();
    const reused = reuseMultiBlockSection(section, { blocks: componentBlocks(ctx), chainHash: ctx.structureHash }, sourceFiles(repo), 2);
    expect(reused).not.toBeNull();
    const s1 = reused!.walkthrough.stages[0].steps[0];
    expect(s1.code_ref).toEqual({ file: 'web/components/EnrollForm.tsx', start: 19, end: 20 });
    const s4 = reused!.walkthrough.stages[2].steps[1];
    expect(s4.code_ref).toEqual({ file: 'web/hooks/useEnrollMutation.ts', start: 15, end: 26 });
    section = reused!;
  });

  it('marks only the steps whose code changed stale when the hook changes, and the Markdown has the overview', async () => {
    edit('web/hooks/useEnrollMutation.ts', "setStatus('submitting');", 'setStatus("submitting");');
    const ctx = await context();
    const saved: SavedWalkthrough = {
      version: SAVED_VERSION,
      scopeKind: 'component',
      scopeRef: ctx.scopeRef,
      overview: null,
      component: componentOverviewOf(ctx),
      sections: [section],
    };
    const source = await loadCurrentSource(store, repo, filesOf(saved));
    const status = checkWalkthrough(saved, source, () => ctx.structureHash);
    expect(status.fresh).toBe(false);
    expect(status.chainChanged).toBe(false);
    expect(status.sections[0].changedBlocks).toEqual(['useEnrollMutation']);
    expect(status.staleSteps).toBe(1);
    expect(checkWalkthrough(saved, source, () => 'different').chainChanged).toBe(true);
    expect(checkWalkthrough(saved, source, () => null).routeRemoved).toBe(true);

    const md = renderMarkdown(saved, codeReader(repo));
    expect(md).toContain('# How EnrollForm works');
    expect(md).toContain('## Component');
    expect(md).toContain('- Hooks: useState (react), useEnrollMutation (expanded)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run core/src/walkthrough/componentSection.test.ts`
Expected: FAIL: `componentBlocks`, `reuseMultiBlockSection` and `componentNotes` are not exported.

- [ ] **Step 3: Saved shape and notes**

In `core/src/walkthrough/saved.ts`:

1. `export type ScopeKind = 'fn' | 'file' | 'endpoint' | 'component';`
2. On `Section`, update the two doc comments: `blocks` → `/** Endpoint and component sections: every code block sent to the LLM, \`block\` first. */`; `chainHash` → `/** Endpoint sections: chainHashOf the route; component sections: structureHashOf the component. */`.
3. After `EndpointOverview`, add:

```ts
/** A component's React facts (CLAUDE.md §6.4), from the index alone; rebuilt on every run. */
export interface ComponentOverview {
  file: string;
  name: string;
  propsType: string | null;
  props: string[];
  state: { name: string; setter: string | null; hook: string; initial: string | null; at: string }[];
  context: { context: string; at: string }[];
  /** Hooks the component calls directly. */
  hooks: { name: string; package: string | null; expanded: boolean; at: string }[];
  children: { element: string; condition: string | null; props: string[]; at: string }[];
  handlers: { event: string; element: string; handler: string; at: string }[];
  /** Effects of the component and of every expanded hook. */
  effects: { hook: string; deps: string[] | null; owner: string; at: string }[];
  apiCalls: { method: string; urlPattern: string; at: string; triggers: string[] }[];
  limits: string[];
  warnings: string[];
}
```

4. In `SavedWalkthrough`, change the `scopeRef` comment to `/** "file#symbol" or "file:start-end" for fn, "file" for file, "METHOD /path" for endpoint, "file#Component" for component. */` and add after `endpoint?`:

```ts
  /** Component walkthroughs only. */
  component?: ComponentOverview;
```

5. After `endpointNotes`, add:

```ts
/** The component overview as plain lines, shared by the terminal, the stepper and Markdown. */
export function componentNotes(o: ComponentOverview): string[] {
  const hook = (h: ComponentOverview['hooks'][number]) => `${h.name} (${h.expanded ? 'expanded' : (h.package ?? 'not expanded')})`;
  return [
    `Component: ${o.name} (${o.file})`,
    `Props: ${o.props.join(', ') || 'none'}${o.propsType ? ` — ${o.propsType}` : ''}`,
    ...o.state.map((s) => `State: ${s.name}${s.setter ? ` / ${s.setter}` : ''} (${s.hook}${s.initial !== null ? `, initially ${s.initial}` : ''}) at ${s.at}`),
    ...o.context.map((x) => `Context: ${x.context} at ${x.at}`),
    `Hooks: ${o.hooks.map(hook).join(', ') || 'none'}`,
    ...o.children.map((c) => `Renders: <${c.element}>${c.condition ? ` when ${c.condition}` : ''}${c.props.length ? ` with ${c.props.join(', ')}` : ''} at ${c.at}`),
    ...o.handlers.map((h) => `Handler: ${h.event} on <${h.element}> → ${h.handler} at ${h.at}`),
    ...o.effects.map((e) => `Effect: ${e.hook} ${e.deps ? `[${e.deps.join(', ')}]` : '(every render)'} in ${e.owner} at ${e.at}`),
    ...o.apiCalls.map((a) => `API call: ${a.method} ${a.urlPattern} at ${a.at}${a.triggers.length ? ` ← ${a.triggers.join('; ')}` : ' (no trigger found in this component)'}`),
    ...o.limits.map((l) => `Not expanded: ${l}`),
    ...o.warnings.map((w) => `Warning: ${w}`),
  ];
}
```

- [ ] **Step 4: Rename `reuseEndpointSection` → `reuseMultiBlockSection`**

In `core/src/walkthrough/endpoint.ts`, rename the function and update its doc comment's first line to `The saved endpoint or component section moved to where its blocks are now, or null when it must be regenerated:`. Then update every reference:

```bash
sed -i '' 's/reuseEndpointSection/reuseMultiBlockSection/g' core/src/walkthrough/index.ts core/src/walkthrough/endpointSection.test.ts cli/src/commands/endpoint.ts
grep -rn "reuseEndpointSection" core/src cli/src   # expect no output
```

- [ ] **Step 5: Blocks, section and overview for components**

Append to `core/src/walkthrough/component.ts` (and extend its imports: `describeTrigger` and `ComponentContext` from `../context/component.js`, `CodeBlock` from `../context/fn.js`, `hashLines`, `BlockRef`, `ComponentOverview`, `Section` from `./saved.js`, `recordSection` from `./section.js`):

```ts
/** The blocks a component walkthrough explains: the component first, then hooks, direct callees, types, values. */
export function componentBlocks(ctx: ComponentContext): BlockRef[] {
  const blocks = new Map<string, BlockRef>();
  const add = (symbol: string | null, code: CodeBlock | null) => {
    if (!code) return;
    const key = `${code.file}:${code.start}-${code.end}`;
    if (!blocks.has(key)) blocks.set(key, { file: code.file, symbol, start: code.start, end: code.end, hash: hashLines(code.lines) });
  };
  add(ctx.component.symbol.name, ctx.component.code);
  for (const h of ctx.hooks) add(h.symbol.name, h.code);
  for (const c of ctx.callees) if (c.callee) add(c.callee.name, c.code);
  for (const t of ctx.types) add(t.symbol.name, t.code);
  // Module-level values aren't symbols: they are found again by their exact text.
  for (const v of ctx.values) add(null, v.code);
  return [...blocks.values()];
}

export async function generateComponentSection(
  provider: LlmProvider,
  ctx: ComponentContext,
  repoRoot: string,
  options: { model: string; depth: number },
): Promise<Section> {
  const walkthrough = await explainComponent(provider, ctx, repoRoot);
  const blocks = componentBlocks(ctx);
  return { ...recordSection(walkthrough, blocks[0], Object.keys(ctx.files), repoRoot, options), blocks, chainHash: ctx.structureHash };
}

export function componentOverviewOf(ctx: ComponentContext): ComponentOverview {
  const c = ctx.component;
  const file = c.symbol.file;
  const expanded = new Set(ctx.hooks.map((h) => `${h.symbol.file}#${h.symbol.name}`));
  return {
    file,
    name: c.symbol.name,
    propsType: c.facts.propsType,
    props: c.facts.props,
    state: c.facts.state.map((s) => ({ name: s.name, setter: s.setter, hook: s.hook, initial: s.initial, at: `${file}:${s.line}` })),
    context: c.facts.context.map((x) => ({ context: x.context, at: `${file}:${x.line}` })),
    hooks: c.facts.hooks.map((h) => ({ name: h.name, package: h.package, expanded: h.callee !== null && expanded.has(`${h.callee.file}#${h.callee.name}`), at: `${file}:${h.line}` })),
    children: ctx.children.map((ch) => ({ element: ch.element, condition: ch.condition, props: ch.props.map((p) => p.name), at: `${file}:${ch.line}` })),
    handlers: c.facts.handlers.map((h) => ({ event: h.event, element: h.element, handler: h.handler, at: `${file}:${h.line}` })),
    effects: [c, ...ctx.hooks].flatMap((u) => u.facts.effects.map((e) => ({ hook: e.hook, deps: e.deps, owner: u.symbol.name, at: `${u.symbol.file}:${e.line}` }))),
    apiCalls: ctx.apiCalls.map((a) => ({ method: a.method, urlPattern: a.urlPattern, at: `${a.symbol.file}:${a.line}`, triggers: a.triggers.map(describeTrigger) })),
    limits: ctx.limits,
    warnings: ctx.warnings,
  };
}
```

In `core/src/walkthrough/index.ts`, change the component export line to:

```ts
export { componentBlocks, componentOverviewOf, explainComponent, generateComponentSection } from './component.js';
```

- [ ] **Step 6: Staleness and Markdown**

In `core/src/walkthrough/staleness.ts`:

- Update the `WalkthroughStatus` doc comments: `chainChanged` → `/** Endpoint: the middleware chain resolves differently now. Component: its hooks, children, handlers or API calls changed. */`; `routeRemoved` → `/** Endpoint: the route is gone. Component: the component is gone. */`.
- In `checkWalkthrough`, replace the `const chain = …` line with:

```ts
  const structural = saved.scopeKind === 'endpoint' || saved.scopeKind === 'component';
  const chain = structural && chains ? chains(saved.scopeRef) : undefined;
```

- Update the `chains` parameter doc comment: `` `chains` gives the current chain hash of an endpoint scope or structure hash of a component scope (null: gone). ``

In `core/src/render/markdown.ts`, import `componentNotes`, and add a branch before the final `else`:

```ts
  } else if (saved.scopeKind === 'component') {
    const w = saved.sections[0].walkthrough;
    out.push(`# ${w.title}`, '', `\`${saved.scopeRef}\``, '', w.summary, '', '## Component', '', ...componentNotes(saved.component!).map((n) => `- ${n}`));
    renderStages(out, w, 2, codeLines);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run core/src`
Expected: PASS, including the renamed `endpointSection.test.ts`.

- [ ] **Step 8: Checkpoint**

Do not commit. `pnpm typecheck` is clean (the CLI now imports the renamed function).

---

### Task 8: CLI `walk component`, `walk list`, formatters

**Files:**
- Create: `cli/src/commands/component.ts`
- Modify: `cli/src/index.ts`, `cli/src/commands/list.ts`, `cli/src/ui/format.ts`, `cli/src/ui/output.ts`
- Test: `cli/src/commands/component.test.ts`

**Interfaces:**
- Consumes: everything from `@codewalk/core` produced above (`buildComponentContext`, `parseComponentTarget`, `componentBlocks`, `componentOverviewOf`, `generateComponentSection`, `reuseMultiBlockSection`, `currentStructureHash`, `describeTrigger`, `componentNotes`, `ComponentContext`).
- Produces: `runComponent(cwd, targetArg, options: ComponentOptions, io, deps?): Promise<number>`; `formatComponentFacts(ctx: ComponentContext): string`.

- [ ] **Step 1: Write the failing test**

Create `cli/src/commands/component.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, openStore, type LlmProvider } from '@codewalk/core';
import { runComponent, type ComponentOptions } from './component.js';
import { runList } from './list.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;
const RECORDED = readFileSync(new URL('../../../core/src/llm/__fixtures__/enrollForm.response.json', import.meta.url), 'utf8');
const TARGET = 'web/components/EnrollForm.tsx#EnrollForm';

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
const opts = (o: Partial<ComponentOptions> = {}): ComponentOptions => ({ llm: true, depth: 2, out: 'terminal', refresh: false, ...o });

describe('walk component', () => {
  let repo: string;
  let schema: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-component-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_cmpcli_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  });

  afterAll(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('--no-llm prints props, state, hooks, render tree, handlers and the API call with its trigger (Phase 4 acceptance)', async () => {
    const { io, out } = captureIO();
    expect(await runComponent(repo, TARGET, opts({ llm: false }), io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('component EnrollForm — web/components/EnrollForm.tsx:18-54');
    expect(text).toContain('onEnrolled  : EnrollFormProps');
    expect(text).toContain('values / setValues  useState(EMPTY_FORM)  line 19');
    expect(text).toContain('useEnrollMutation  web/hooks/useEnrollMutation.ts:11  (used by EnrollForm at web/components/EnrollForm.tsx:20)');
    expect(text).toContain('  <FormField>  line 40');
    expect(text).toContain('onSubmit on <form> → handleSubmit  line 39');
    expect(text).toContain('POST /api/patients/enroll  useEnrollMutation.mutate web/hooks/useEnrollMutation.ts:19');
    expect(text).toContain('← onSubmit on <form> (web/components/EnrollForm.tsx:39) → EnrollForm.handleSubmit → useEnrollMutation.mutate');
    expect(text).toContain('Not expanded');
  });

  it('a file with one component needs no name; a hook is rejected with the right command', async () => {
    const one = captureIO();
    expect(await runComponent(repo, 'web/components/PatientSummary.tsx', opts({ llm: false }), one.io)).toBe(0);
    expect(one.out.join('\n')).toContain('GET /api/patients/:id  usePatient web/hooks/usePatient.ts:13');

    const hook = captureIO();
    expect(await runComponent(repo, 'web/hooks/usePatient.ts#usePatient', opts({ llm: false }), hook.io)).toBe(1);
    expect(hook.err.join('\n')).toContain('use `walk fn web/hooks/usePatient.ts#usePatient` instead');
  });

  it('explains, saves, and reuses the saved walkthrough while the code is unchanged', async () => {
    const first = captureIO();
    expect(await runComponent(repo, TARGET, opts(), first.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(first.out.join('\n')).toContain('How EnrollForm works');
    expect(first.err.join('\n')).toContain('Saved .walkthrough/walkthroughs/component--');

    const second = captureIO();
    expect(await runComponent(repo, TARGET, opts({ out: 'md' }), second.io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(1);
    expect(second.err.join('\n')).toContain('Code unchanged');
    expect(second.out.join('\n')).toContain('## Component');
  });

  it('walk list marks the component stale after its hook changes, and the next run regenerates', async () => {
    const path = join(repo, 'web/hooks/useEnrollMutation.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace("setStatus('submitting');", 'setStatus("submitting");'));

    const list = captureIO();
    expect(await runList(repo, { out: 'terminal' }, list.io)).toBe(0);
    expect(list.out.join('\n')).toMatch(/stale {2}component {2}web\/components\/EnrollForm\.tsx#EnrollForm .*changed: useEnrollMutation/);

    expect(await runComponent(repo, TARGET, opts(), captureIO().io, { provider: recorded, interactive: false })).toBe(0);
    expect(generated).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run cli/src/commands/component.test.ts`
Expected: FAIL: cannot resolve `./component.js`.

- [ ] **Step 3: The command**

Create `cli/src/commands/component.ts`:

```ts
import {
  AnthropicProvider,
  buildComponentContext,
  componentBlocks,
  componentOverviewOf,
  generateComponentSection,
  indexRepo,
  loadSavedWalkthrough,
  parseComponentTarget,
  persistWalkthrough,
  reuseMultiBlockSection,
  SAVED_VERSION,
  sourceFiles,
  type LlmProvider,
  type SavedWalkthrough,
} from '@codewalk/core';
import { formatComponentFacts } from '../ui/format.js';
import { printWalkthrough, type OutFormat } from '../ui/output.js';
import { connectStore, loadRepo, reportError, type IO } from './shared.js';

export interface ComponentOptions {
  /** False with --no-llm: print only the static facts. */
  llm: boolean;
  depth: number;
  out: OutFormat;
  /** Ignore the saved walkthrough and regenerate (--refresh). */
  refresh: boolean;
}

export interface ComponentDeps {
  /** Overrides the configured Anthropic provider (tests use recorded responses). */
  provider?: LlmProvider;
  /** Use the Ink stepper; defaults to true when stdin and stdout are terminals. */
  interactive?: boolean;
}

/** `walk component <file>[#<Component>]`. Returns an exit code. */
export async function runComponent(cwd: string, targetArg: string, options: ComponentOptions, io: IO, deps: ComponentDeps = {}): Promise<number> {
  let target;
  try {
    target = parseComponentTarget(targetArg);
  } catch (err) {
    return reportError(err, io);
  }

  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;

  let saved: SavedWalkthrough;
  try {
    // Facts first: bring the index (React facts and API calls included) up to date.
    await store.migrate();
    await indexRepo(repo.repoRoot, repo.config, store);

    const ctx = await buildComponentContext(store, repo.repoRoot, target, {
      depth: options.depth,
      maxContextTokens: repo.config.llm.maxContextTokens,
    });
    for (const warning of ctx.warnings) io.error(`! ${warning}`);

    if (!options.llm) {
      io.log(options.out === 'json' ? JSON.stringify(ctx, null, 2) : formatComponentFacts(ctx));
      return 0;
    }

    // Cached by the content of every explained block and the component's structure (CLAUDE.md §9).
    const previous = options.refresh ? null : await loadSavedWalkthrough(store, 'component', ctx.scopeRef);
    const current = { blocks: componentBlocks(ctx), chainHash: ctx.structureHash };
    let section = previous && reuseMultiBlockSection(previous.sections[0], current, sourceFiles(repo.repoRoot), options.depth);
    if (section) {
      io.error(`Code unchanged since ${section.generatedAt}: showing the saved walkthrough (--refresh to regenerate).`);
    } else {
      io.error(`Explaining ${ctx.scopeRef} with ${repo.config.llm.model}…`);
      const provider = deps.provider ?? new AnthropicProvider(repo.config.llm.model);
      section = await generateComponentSection(provider, ctx, repo.repoRoot, { model: repo.config.llm.model, depth: options.depth });
    }
    saved = { version: SAVED_VERSION, scopeKind: 'component', scopeRef: ctx.scopeRef, overview: null, component: componentOverviewOf(ctx), sections: [section] };
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

In `cli/src/index.ts`, import `runComponent, type ComponentOptions` from `./commands/component.js` and register it after `endpoint`:

```ts
program
  .command('component')
  .description('walkthrough of a React component: props, state, render tree, hooks, handlers, API calls')
  .argument('<target>', 'e.g. web/components/EnrollForm.tsx#EnrollForm (the name is optional when the file has one component)')
  .option('--no-llm', 'print only the static facts')
  .option('--depth <n>', 'how many levels of custom hooks and calls to expand', parseDepth, 2)
  .option('--refresh', 'ignore the saved walkthrough and regenerate', false)
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json', 'md']).default('terminal'))
  .action(async (target: string, opts: ComponentOptions) => {
    process.exitCode = await runComponent(process.cwd(), target, opts, io);
  });
```

- [ ] **Step 4: Formatters, output and list**

In `cli/src/ui/format.ts`, add `describeTrigger` and `type ComponentContext` to the `@codewalk/core` import, and add after `formatEndpointFacts`:

```ts
export function formatComponentFacts(ctx: ComponentContext): string {
  const c = ctx.component;
  const f = c.facts;
  const out = [`component ${c.symbol.name} — ${c.symbol.file}:${c.symbol.startLine}-${c.symbol.endLine}`];
  if (c.symbol.signature) out.push(`  ${c.symbol.signature}`);
  section(out, 'Props', f.props.length || f.propsType ? [`${f.props.join(', ') || '(not destructured)'}${f.propsType ? `  : ${f.propsType}` : ''}`] : []);
  section(out, 'State', f.state.map((s) => `${s.name}${s.setter ? ` / ${s.setter}` : ''}  ${s.hook}(${s.initial ?? ''})  line ${s.line}`));
  section(out, 'Context', f.context.map((x) => `${x.context}  line ${x.line}`));
  section(out, 'Hooks called', f.hooks.map((h) => `${h.name}  line ${h.line}  ${h.callee ? '(custom)' : h.package ? `(${h.package})` : ''}`.trimEnd()));
  section(out, 'Custom hooks (expanded)', ctx.hooks.map((h) => `${'  '.repeat(h.depth - 1)}${h.symbol.name}  ${h.symbol.file}:${h.symbol.startLine}  (used by ${h.usedBy} at ${h.calledAt})`));
  section(
    out,
    'Render tree',
    f.render.map((r) => `${'  '.repeat(r.depth)}<${r.element}>  line ${r.line}${r.condition ? `  when ${r.condition}` : ''}${r.props.length ? `  ${r.props.map((p) => `${p.name}=${p.value}`).join(' ')}` : ''}`),
  );
  section(out, 'Event handlers', f.handlers.map((h) => `${h.event} on <${h.element}> → ${h.handler}  line ${h.line}`));
  section(
    out,
    'Effects and derived values',
    [c, ...ctx.hooks].flatMap((u) => u.facts.effects.map((e) => `${e.hook} ${e.deps ? `[${e.deps.join(', ')}]` : '(every render)'}  ${u.symbol.name} ${u.symbol.file}:${e.line}`)),
  );
  section(
    out,
    'API calls',
    ctx.apiCalls.flatMap((a) => [
      `${a.method} ${a.urlPattern}  ${a.symbol.name} ${a.symbol.file}:${a.line}`,
      ...(a.triggers.length ? a.triggers.map((t) => `  ← ${describeTrigger(t)}`) : ['  ← no trigger found in this component']),
    ]),
  );
  section(
    out,
    'Calls',
    ctx.callees.map((k) => {
      const target = k.callee ? `${k.callee.name}  ${k.callee.file}:${k.callee.startLine}` : `${k.calleeText}  ${k.resolved ? '(package / built-in)' : '(unresolved)'}`;
      return `${'  '.repeat(k.depth - 1)}${k.caller.name} → ${target}`;
    }),
  );
  section(out, 'Unresolved', ctx.unresolved.map((u) => u.note));
  section(out, 'Not expanded', ctx.limits);
  section(out, 'Omitted (context budget)', ctx.omitted);
  section(out, 'Warnings', ctx.warnings);
  return out.join('\n');
}
```

In the same file, update the list formatting: change the empty message to ``'No saved walkthroughs yet. Run `walk fn`, `walk file`, `walk endpoint` or `walk component` to create one.'``. Change `staleDetail(s)` to `staleDetail(r.scopeKind, s)` at its call site, and change its signature and the two lines:

```ts
function staleDetail(kind: ScopeKind, s: WalkthroughStatus): string {
```

```ts
  if (s.routeRemoved) parts.push(kind === 'component' ? 'component removed' : 'route removed');
  if (s.chainChanged) parts.push(kind === 'component' ? 'structure changed' : 'middleware chain changed');
```

In `cli/src/ui/output.ts`, import `componentNotes`, and replace the `notes` and JSON lines:

```ts
  const notes = saved.overview
    ? overviewNotes(saved.overview)
    : saved.endpoint
      ? endpointNotes(saved.endpoint)
      : saved.component
        ? componentNotes(saved.component)
        : [];
  if (out === 'json') {
    io.log(JSON.stringify({ ...walkthrough, overview: saved.overview, endpoint: saved.endpoint ?? null, component: saved.component ?? null }, null, 2));
```

In `cli/src/commands/list.ts`, import `currentStructureHash`, and extend the loop that fills `chains`:

```ts
    for (const { saved } of entries) {
      if (saved.scopeKind === 'endpoint') chains.set(saved.scopeRef, await currentChainHash(store, saved.scopeRef));
      if (saved.scopeKind === 'component') {
        chains.set(saved.scopeRef, await currentStructureHash(store, repo.repoRoot, saved.scopeRef, saved.sections[0]?.depth ?? 2));
      }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run cli/src`
Expected: PASS, including the existing `list.test.ts` and `format.test.ts`. If a format test asserts the old empty-list message, update the expected string to the new one: the message is meant to change.

- [ ] **Step 6: Full verification**

Run: `pnpm test && pnpm typecheck`
Expected: every test passes and typecheck is clean.

Then a manual run on the fixture (needs `ANTHROPIC_API_KEY` for the LLM part; the `--no-llm` part needs none):

```bash
cd fixture && pnpm --filter @codewalk/cli exec tsx ../cli/src/index.ts component web/components/EnrollForm.tsx#EnrollForm --no-llm
```

Expected: the facts output from Step 1, ending with the `Not expanded` section.

- [ ] **Step 7: Checkpoint (end of Phase 4)**

Do not commit. Stop for review (CLAUDE.md §12, §15): report the test counts against the baseline and paste the `--no-llm` output for `EnrollForm`.

---

## Self-review notes

- **Spec coverage:** §1.1 → Task 2; §1.2 → Task 3; §1.3/§1.4 → Task 4; Decision 2 → Task 1; §2/§3 → Task 5; §4 → Task 6; §5 → Task 7; §6 → Task 8; §7 tests are spread across all tasks.
- **Type consistency:** `ReactFact`/`ReactFactRecord` field names (`state`, `hooks`, `context`, `effects`, `render`, `handlers`) are the same in the indexer, store, context and overview. `chainHash` on `Section` carries `structureHash` for components. `reuseMultiBlockSection` is the only reuse function for multi-block sections.
- **Known limits, stated in output, not guessed:** inline callbacks passed by identifier (`onSuccess: handleSuccess`) aren't listed as hook callbacks; class components aren't detected; child internals aren't expanded.
