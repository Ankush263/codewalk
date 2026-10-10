// Parses the argument of `walk fn`: "<file>#<symbolName>" or "<file>:<startLine>-<endLine>".

export type FnTarget =
  | { kind: 'symbol'; file: string; name: string }
  | { kind: 'range'; file: string; start: number; end: number };

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

const RANGE = /^(.+):(\d+)-(\d+)$/;

export function parseFnTarget(arg: string): FnTarget {
  const hash = arg.lastIndexOf('#');
  if (hash > 0) {
    const name = arg.slice(hash + 1).trim();
    if (!name) throw new TargetError(`Missing symbol name after "#" in "${arg}"`);
    return { kind: 'symbol', file: normalizeFile(arg.slice(0, hash)), name };
  }

  const range = RANGE.exec(arg);
  if (range) {
    const start = Number(range[2]);
    const end = Number(range[3]);
    if (start < 1 || end < start) throw new TargetError(`Invalid line range ${start}-${end} in "${arg}"`);
    return { kind: 'range', file: normalizeFile(range[1]), start, end };
  }

  throw new TargetError(`Expected <file>#<symbolName> or <file>:<startLine>-<endLine>, got "${arg}"`);
}

/** Repo-relative, forward slashes, no leading "./". */
function normalizeFile(file: string): string {
  return file.trim().split('\\').join('/').replace(/^\.\//, '');
}

/** Parses the argument of `walk file`: a repo-relative path. */
export function parseFileTarget(arg: string): string {
  const file = normalizeFile(arg);
  if (!file) throw new TargetError('Expected a file path, e.g. api/services/enrollService.ts');
  if (file.includes('#') || RANGE.test(file)) {
    throw new TargetError(`"${arg}" names a function or line range; use \`walk fn ${arg}\` instead.`);
  }
  return file;
}

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
