// Shapes that cross the store boundary. Facts flow in from the indexer; records flow
// out to the context builder. Row ids are BIGSERIAL in Postgres and numbers here.

export type SymbolKind = 'function' | 'method' | 'class' | 'component' | 'hook' | 'route_handler' | 'type';

/** Identifies a symbol without its database id: repo-relative file + name + first line. */
export interface SymbolKey {
  file: string;
  name: string;
  startLine: number;
}

export interface SymbolFact {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  exported: boolean;
  signature: string | null;
}

export interface CallFact {
  /** The calling symbol, which always lives in the same file as the call. */
  caller: Pick<SymbolKey, 'name' | 'startLine'>;
  /** The called symbol when it is part of this repo; null for package and dynamic calls. */
  callee: SymbolKey | null;
  /** Source text of the callee expression, e.g. "pool.query" or "handlers[name]". */
  calleeText: string;
  line: number;
  /** False when the target can't be determined statically (dynamic dispatch, DI, callbacks). */
  resolved: boolean;
}

export type SideEffectKind = 'db_read' | 'db_write' | 'redis' | 'http_out' | 'queue' | 'throws';

/** Something a symbol does beyond computing a value, found statically (CLAUDE.md §6.3 item 4). */
export interface SideEffectFact {
  symbol: Pick<SymbolKey, 'name' | 'startLine'>;
  kind: SideEffectKind;
  /** e.g. "INSERT consents", "GET session:${token}", "ConflictError (409)". */
  detail: string;
  line: number;
}

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

export interface ImportFact {
  importedPath: string;
  /** Repo-relative file the import resolves to; null for packages. */
  resolvedPath: string | null;
  importedNames: string[];
  packageName: string | null;
  packageVersion: string | null;
}

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

/** Everything the indexer extracted from one file. Replaces all prior facts for that file. */
export interface FileFacts {
  path: string;
  hash: string;
  language: string;
  symbols: SymbolFact[];
  calls: CallFact[];
  imports: ImportFact[];
  /** Express registrations in this file (Phase 3). */
  routerCalls?: RouterCallFact[];
  sideEffects?: SideEffectFact[];
  reactFacts?: ReactFact[];
  apiCalls?: ApiCallFact[];
}

export interface IndexChanges {
  files?: FileFacts[];
  removedPaths?: string[];
  /** Unchanged files whose outgoing calls are rebuilt (their symbols are kept). */
  callRefreshes?: { path: string; calls: CallFact[]; routerCalls?: RouterCallFact[]; sideEffects?: SideEffectFact[]; reactFacts?: ReactFact[]; apiCalls?: ApiCallFact[] }[];
}

export interface IndexStats {
  files: number;
  symbols: number;
  calls: number;
  unresolved: number;
}

export interface SymbolRecord {
  id: number;
  file: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  exported: boolean;
  signature: string | null;
}

export interface FileRecord {
  path: string;
  hash: string;
}

export interface ImportRecord {
  importedPath: string;
  resolvedPath: string | null;
  importedNames: string[];
  packageName: string | null;
  packageVersion: string | null;
}

export interface CallerRecord {
  caller: SymbolRecord;
  callLine: number;
}

export interface CalleeRecord {
  /** 1 for direct callees of the starting symbol, 2 for their callees, and so on. */
  depth: number;
  callerId: number;
  /** Null for package calls and unresolved dynamic calls. */
  callee: SymbolRecord | null;
  calleeText: string;
  callLine: number;
  resolved: boolean;
}

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
