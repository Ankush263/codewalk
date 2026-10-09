import { describe, expect, it } from 'vitest';
import { lineStep, sectionFor } from './__fixtures__/sections.js';
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

describe('steps outside their block', () => {
  it('make an unchanged section stale, matching what reuse would do', () => {
    const main = sectionFor(SOURCE, 'a.ts', 'main', 5, 8);
    main.walkthrough.stages[0].steps.push(lineStep('s5', 'a.ts', 2));
    const status = checkSection(main, only({ lines: SOURCE, symbols: [fn('helper', 1, 3), fn('main', 5, 8)] }));
    expect(status.state).toBe('changed');
    expect(status.steps.filter((s) => !s.fresh).map((s) => s.stepId)).toEqual(['s5']);
  });
});

describe('checkWalkthrough', () => {
  it('reports a file walkthrough as stale once its file is deleted, even with no sections', () => {
    const saved: SavedWalkthrough = { version: SAVED_VERSION, scopeKind: 'file', scopeRef: 'a.ts', overview: null, sections: [] };
    expect(checkWalkthrough(saved, only(null))).toMatchObject({ fresh: false, fileRemoved: true });
    expect(checkWalkthrough(saved, only({ lines: ['type T = 1;'], symbols: [] }))).toMatchObject({ fresh: true, fileRemoved: false });
  });

  it('reports functions a file walkthrough does not cover', () => {
    const saved: SavedWalkthrough = {
      version: SAVED_VERSION,
      scopeKind: 'file',
      scopeRef: 'a.ts',
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
      overview: null,
      sections: [sectionFor(SOURCE, 'a.ts', 'helper', 1, 3), sectionFor(SOURCE, 'a.ts', 'main', 5, 8)],
    };
    const status = checkWalkthrough(saved, only({ lines: edited, symbols: [fn('helper', 1, 3), fn('main', 5, 8)] }));
    expect(status).toMatchObject({ fresh: false, uncovered: [], staleSteps: 1, totalSteps: 7 });
    expect(status.sections.map((s) => s.state)).toEqual(['changed', 'fresh']);
  });
});
