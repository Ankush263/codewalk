import { describe, expect, it } from 'vitest';
import type { FnContext } from '../context/fn.js';
import type { Step, Walkthrough } from '../llm/schema.js';
import { codeSpans, identifiers, verifyFnWalkthrough, verifyWalkthrough, vocabularyOf } from './verify.js';

const sym = (id: number, file: string, name: string, startLine: number, endLine: number) => ({
  id, file, name, kind: 'function' as const, startLine, endLine, exported: true, signature: null,
});

const ctx: FnContext = {
  target: {
    file: 'api/service.ts',
    start: 3,
    end: 6,
    symbol: sym(1, 'api/service.ts', 'normalizePhone', 3, 6),
    code: {
      file: 'api/service.ts',
      start: 3,
      end: 6,
      lines: [
        'export function normalizePhone(phone: string): string {',
        "  const digits = phone.replace(/\\D/g, '');",
        '  return digits.slice(-10);',
        '}',
      ],
    },
  },
  innerSymbols: [],
  callers: [{ symbol: sym(2, 'api/controller.ts', 'handle', 1, 5), callLine: 3, code: { file: 'api/controller.ts', start: 2, end: 3, lines: ['  const raw = req.body.phone;', '  normalizePhone(raw);'] } }],
  callees: [],
  types: [],
  values: [],
  packages: [{ name: 'express', version: '4.19.2', importedPath: 'express', importedNames: ['Request'] }],
  unresolved: [],
  files: { 'api/service.ts': 10, 'api/controller.ts': 5 },
  omitted: [],
  warnings: [],
};

const step = (overrides: Partial<Step> = {}): Step => ({
  id: 's1',
  code_ref: { file: 'api/service.ts', start: 4, end: 4 },
  explanation: '`phone.replace(/\\D/g, "")` strips every non-digit and stores the result in `digits`.',
  example: { input: 'phone = "+91 98765-43210"', state_after: 'digits = "919876543210"' },
  references: [{ file: 'api/controller.ts', line: 3, role: 'caller' }],
  docs: [],
  concepts: ['regular expressions'],
  risks: [],
  ...overrides,
});

const walkthrough = (...steps: Step[]): Walkthrough => ({
  title: 'normalizePhone',
  summary: 'Normalizes a phone number.',
  stages: [{ name: 'Normalize', steps }],
  unresolved: [],
});

describe('verifyFnWalkthrough', () => {
  it('keeps a step whose citations and identifiers are all grounded', () => {
    const result = verifyFnWalkthrough(walkthrough(step()), ctx);
    expect(result.dropped).toEqual([]);
    expect(result.walkthrough.stages[0].steps).toHaveLength(1);
  });

  it('drops a step whose code_ref is outside the file', () => {
    const result = verifyFnWalkthrough(walkthrough(step(), step({ id: 's2', code_ref: { file: 'api/service.ts', start: 9, end: 42 } })), ctx);
    expect(result.dropped).toEqual([{ stepId: 's2', reasons: ['code_ref api/service.ts:9-42 is outside the file\'s lines 1-10'] }]);
    expect(result.walkthrough.stages[0].steps.map((s) => s.id)).toEqual(['s1']);
  });

  it('drops a step citing a file that is not in the context', () => {
    const result = verifyFnWalkthrough(walkthrough(step({ code_ref: { file: 'api/invented.ts', start: 1, end: 2 } })), ctx);
    expect(result.dropped[0].reasons[0]).toMatch(/api\/invented\.ts, which is not part of the indexed context/);
    expect(result.walkthrough.stages).toEqual([]);
  });

  it('drops a step whose reference line does not exist', () => {
    const result = verifyFnWalkthrough(walkthrough(step({ references: [{ file: 'api/controller.ts', line: 6, role: 'caller' }] })), ctx);
    expect(result.dropped[0].reasons).toEqual(["reference api/controller.ts:6 is outside the file's lines 1-5"]);
  });

  it('drops a step that names an identifier found nowhere in the context', () => {
    const result = verifyFnWalkthrough(walkthrough(step({ explanation: 'Then `validatePhoneNumber(digits)` checks the country code.' })), ctx);
    expect(result.dropped[0].reasons).toEqual(['explanation names identifiers not found in the code or index: `validatePhoneNumber`']);
  });

  it('accepts names from callers, packages and plain language words', () => {
    const explanation = 'Called by `handle` with `req.body.phone`; returns `digits.slice(-10)`, never `null`. Uses `Request` from `express`.';
    expect(verifyFnWalkthrough(walkthrough(step({ explanation })), ctx).dropped).toEqual([]);
  });

  it('removes docs for packages the target does not import, keeping the step', () => {
    const docs = [
      { package: 'express', symbol: 'Request' },
      { package: 'lodash', symbol: 'trim' },
    ];
    const result = verifyFnWalkthrough(walkthrough(step({ docs })), ctx);
    expect(result.walkthrough.stages[0].steps[0].docs).toEqual([{ package: 'express', symbol: 'Request' }]);
    expect(result.removedDocs).toEqual([{ stepId: 's1', package: 'lodash', symbol: 'trim' }]);
  });
});

describe('identifier extraction', () => {
  it('reads code spans and skips escapes and numbers', () => {
    expect(codeSpans('use `a.b(c)` then `x < 18`')).toEqual(['a.b(c)', 'x < 18']);
    expect(identifiers("phone.replace(/\\D/g, '') + 10")).toEqual(['phone', 'replace', 'g']);
  });
});

describe('verifyWalkthrough with explicit facts', () => {
  const step = (id: string, file: string, explanation: string) => ({
    id, code_ref: { file, start: 1, end: 2 }, explanation, example: { input: 'x', state_after: 'y' },
    references: [], docs: [{ package: 'express', symbol: 'Router' }], concepts: [], risks: [],
  });

  it('accepts code_refs into any cited file and checks identifiers against the given vocabulary', () => {
    const facts = { files: { 'a.ts': 10, 'b.ts': 5 }, vocabulary: vocabularyOf(['const total = add(a, b)']), packages: new Set<string>() };
    const result = verifyWalkthrough(
      { title: 't', summary: 's', unresolved: [], stages: [{ name: 'S', steps: [step('s1', 'a.ts', 'Calls `add`.'), step('s2', 'b.ts', 'Uses `missing`.')] }] },
      facts,
    );
    expect(result.walkthrough.stages[0].steps.map((s) => s.id)).toEqual(['s1']);
    expect(result.dropped[0].reasons[0]).toContain('`missing`');
    expect(result.removedDocs).toEqual([{ stepId: 's1', package: 'express', symbol: 'Router' }]);
  });
});
