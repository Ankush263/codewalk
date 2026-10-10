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
