import { dirname, relative } from 'node:path';
import { Node, type Project, type SourceFile } from 'ts-morph';
import type { ApiClientWrapper } from '../config.js';
import type { ApiCallFact, CallFact, ImportFact, ReactFact, RouterCallFact, SideEffectFact, SymbolFact, SymbolKey } from '../store/types.js';
import { collectApiCalls } from './apiCalls.js';
import { collectCalls, type RepoLookup } from './calls.js';
import { toPosix } from './discover.js';
import { PackageVersions, packageNameOf } from './packages.js';
import { collectReactFacts } from './react.js';
import { collectRouterCalls, isExpressValue } from './routers.js';
import { collectSideEffects } from './sideEffects.js';
import { collectSymbols, type FileSymbols } from './symbols.js';

export interface ExtractOptions {
  /** CLAUDE.md §10: custom API clients recognised as API calls. */
  apiClientWrappers?: ApiClientWrapper[];
}

export interface ExtractedFacts {
  symbols: SymbolFact[];
  calls: CallFact[];
  imports: ImportFact[];
  routerCalls: RouterCallFact[];
  sideEffects: SideEffectFact[];
  reactFacts: ReactFact[];
  apiCalls: ApiCallFact[];
}

/** Extracts facts for repo files from one ts-morph project, caching per-file symbol registries. */
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
    private readonly options: ExtractOptions = {},
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
      routerCalls: collectRouterCalls(sourceFile, this.repo),
      sideEffects: collectSideEffects(sourceFile, registry.byNode, this.repo),
      reactFacts: collectReactFacts(sourceFile, registry, this.repo),
      apiCalls: collectApiCalls(sourceFile, registry.byNode, this.repo, this.options.apiClientWrappers ?? []),
    };
  }

  private keyFor(node: Node): SymbolKey | null {
    const sym = this.registry(node.getSourceFile()).byNode.get(node.compilerNode);
    return sym ? { file: this.relPath(node.getSourceFile()), name: sym.name, startLine: sym.startLine } : null;
  }

  private imports(sourceFile: SourceFile): ImportFact[] {
    const fromDir = dirname(sourceFile.getFilePath());
    const facts: ImportFact[] = [];
    const declarations = [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()];

    for (const decl of declarations) {
      const importedPath = decl.getModuleSpecifierValue();
      if (importedPath === undefined) continue; // `export { x }` without a module

      const target = decl.getModuleSpecifierSourceFile();
      const targetPath = target ? this.relPath(target) : null;
      const resolvedPath = targetPath && this.repoPaths.has(targetPath) ? targetPath : null;
      const packageName = resolvedPath ? null : packageNameOf(importedPath);

      facts.push({
        importedPath,
        resolvedPath,
        importedNames: importedNames(decl),
        packageName,
        packageVersion: packageName ? this.versions.versionOf(packageName, fromDir) : null,
      });
    }
    return facts;
  }

  private registry(sourceFile: SourceFile): FileSymbols {
    const key = sourceFile.getFilePath();
    let registry = this.registries.get(key);
    if (!registry) {
      registry = collectSymbols(sourceFile, (receiver) => isExpressValue(receiver, this.repo));
      this.registries.set(key, registry);
    }
    return registry;
  }

  private sourceFile(path: string): SourceFile {
    const sf = this.project.getSourceFile(`${this.repoRoot}/${path}`);
    if (!sf) throw new Error(`File ${path} is not loaded in the project`);
    return sf;
  }

  private relPath(sourceFile: SourceFile): string {
    return toPosix(relative(this.repoRoot, sourceFile.getFilePath()));
  }
}

function importedNames(decl: Node): string[] {
  const names: string[] = [];
  if (Node.isImportDeclaration(decl)) {
    const def = decl.getDefaultImport();
    if (def) names.push('default');
    const ns = decl.getNamespaceImport();
    if (ns) names.push('*');
    for (const spec of decl.getNamedImports()) names.push(spec.getName());
  } else if (Node.isExportDeclaration(decl)) {
    const named = decl.getNamedExports();
    if (named.length === 0) names.push('*');
    for (const spec of named) names.push(spec.getName());
  }
  return names;
}
