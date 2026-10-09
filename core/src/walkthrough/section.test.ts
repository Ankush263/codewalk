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
  const hashes: Record<string, string> = { 'a.ts': 'a-now', 'b.ts': 'b-same', 'c.ts': 'c-now' };
  const current: Record<string, string[]> = { 'a.ts': ['// x', '// y', ...SOURCE] };
  const files = { hash: (f: string) => hashes[f] ?? null, lines: (f: string) => current[f] ?? null };

  it('returns null when the block text changed', () => {
    const prev = sectionFor(SOURCE, 'a.ts', 'main', 5, 8);
    const edited = ['function main() {', '  const x = helper() * 2;', '  return x + 1;', '}'];
    expect(reuseSection(prev, { start: 5, end: 8, lines: edited }, files, 2)).toBeNull();
  });

  it('moves steps and references with the code, and notes references it could not find', () => {
    const prev = sectionFor(SOURCE, 'a.ts', 'main', 5, 8);
    prev.fileHashes = { 'a.ts': 'a-then', 'b.ts': 'b-same', 'c.ts': 'c-then' };
    prev.refLines = { 'a.ts:1': 'function helper() {', 'c.ts:9': 'type Gone = string;' };
    prev.walkthrough.stages[0].steps[1].references = [
      { file: 'a.ts', line: 6, role: 'callee' }, // inside the block: shifts with it
      { file: 'a.ts', line: 1, role: 'callee' }, // outside the block in a changed file: found again by its text
      { file: 'b.ts', line: 4, role: 'caller' }, // b.ts unchanged: kept as is
      { file: 'c.ts', line: 9, role: 'type' }, // c.ts changed and the line is gone: dropped, and noted
    ];

    const moved = reuseSection(prev, { start: 7, end: 10, lines: SOURCE.slice(4, 8) }, files, 2)!;
    expect(moved.block).toMatchObject({ start: 7, end: 10, hash: prev.block.hash });
    expect(moved.walkthrough.scope).toMatchObject({ start: 7, end: 10 });
    expect(moved.walkthrough.stages[0].steps.map((s) => s.code_ref.start)).toEqual([7, 8, 9, 10]);
    expect(moved.walkthrough.stages[0].steps[1].references).toEqual([
      { file: 'a.ts', line: 8, role: 'callee' },
      { file: 'a.ts', line: 3, role: 'callee' },
      { file: 'b.ts', line: 4, role: 'caller' },
    ]);
    // Each kept reference keeps its line text under its new location.
    expect(moved.refLines).toEqual({ 'a.ts:3': 'function helper() {' });
    expect(moved.walkthrough.unresolved).toEqual(['1 reference dropped because the code it pointed to changed: c.ts:9']);
    expect(moved.fileHashes).toEqual({ 'a.ts': 'a-now', 'b.ts': 'b-same', 'c.ts': 'c-now' });
    expect(moved.stepHashes).toEqual(prev.stepHashes);
  });

  it('returns null when the walkthrough was built with a different --depth', () => {
    const prev = sectionFor(SOURCE, 'a.ts', 'main', 5, 8);
    expect(reuseSection(prev, { start: 5, end: 8, lines: SOURCE.slice(4, 8) }, files, 3)).toBeNull();
    expect(reuseSection(prev, { start: 5, end: 8, lines: SOURCE.slice(4, 8) }, files, 2)?.model).toBe('m');
  });

  it('refuses a section with a step outside its block', () => {
    const prev = sectionFor(SOURCE, 'a.ts', 'main', 5, 8);
    prev.walkthrough.stages[0].steps.push(lineStep('s9', 'a.ts', 2));
    expect(reuseSection(prev, { start: 5, end: 8, lines: SOURCE.slice(4, 8) }, files, 2)).toBeNull();
  });
});

describe('flattenWalkthrough', () => {
  it('turns a file walkthrough into one stepper walkthrough with prefixed stages and ids', () => {
    const saved: SavedWalkthrough = {
      version: SAVED_VERSION,
      scopeKind: 'file',
      scopeRef: 'a.ts',
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
