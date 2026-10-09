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
