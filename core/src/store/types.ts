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

export interface ImportFact {
  importedPath: string;
  /** Repo-relative file the import resolves to; null for packages. */
  resolvedPath: string | null;
  importedNames: string[];
  packageName: string | null;
  packageVersion: string | null;
}

/** Everything the indexer extracted from one file. Replaces all prior facts for that file. */
export interface FileFacts {
  path: string;
  hash: string;
  language: string;
  symbols: SymbolFact[];
  calls: CallFact[];
  imports: ImportFact[];
}

export interface IndexChanges {
  files?: FileFacts[];
  removedPaths?: string[];
  /** Unchanged files whose outgoing calls are rebuilt (their symbols are kept). */
  callRefreshes?: { path: string; calls: CallFact[] }[];
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
