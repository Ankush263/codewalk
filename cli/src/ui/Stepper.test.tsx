import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import type { FnWalkthrough, WalkthroughStep } from '@codewalk/core';
import { navigate, Overview, screensOf, StepView } from './Stepper.js';

const step = (id: string, start: number, end: number): WalkthroughStep => ({
  id,
  code_ref: { file: 'api/x.ts', start, end },
  explanation: `Explains ${id}.`,
  example: { input: 'phone = "+91 98765-43210"', state_after: 'digits = "9876543210"' },
  references: [{ file: 'api/y.ts', line: 4, role: 'caller' }],
  docs: [{ package: 'express', symbol: 'res.json' }],
  docLinks: [{ package: 'express', symbol: 'res.json', version: '4.19.2', url: 'https://expressjs.com/en/4x/api.html#res.json', source: 'curated' }],
  concepts: ['regular expressions'],
  risks: ['throws on empty input'],
});

const walkthrough: FnWalkthrough = {
  scope: { file: 'api/x.ts', start: 1, end: 10, symbol: 'normalize' },
  title: 'How normalize works',
  summary: 'Strips formatting.',
  stages: [
    { name: 'Clean', steps: [step('s1', 2, 3)] },
    { name: 'Return', steps: [step('s2', 9, 9)] },
  ],
  unresolved: ['unresolved: likely handlers[name]'],
  verification: { attempts: 1, keptSteps: 2, dropped: [{ stepId: 's3', reasons: ['code_ref api/x.ts:40-41 is outside the file'] }], removedDocs: [] },
};

const code = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);

describe('Stepper', () => {
  it('flattens stages into screens', () => {
    expect(screensOf(walkthrough).map((s) => `${s.stage}/${s.step.id}`)).toEqual(['Clean/s1', 'Return/s2']);
  });

  it('navigates between the overview and the steps', () => {
    expect(navigate(0, 2, '', { rightArrow: true })).toBe(1);
    expect(navigate(2, 2, '', { rightArrow: true })).toBe(2);
    expect(navigate(1, 2, '', { leftArrow: true })).toBe(0);
    expect(navigate(0, 2, '', { leftArrow: true })).toBe(0);
    expect(navigate(1, 2, 'q', {})).toBeNull();
  });

  it('renders the overview with verification and unresolved notes', () => {
    const text = renderToString(<Overview walkthrough={walkthrough} />, { columns: 100 });
    expect(text).toContain('How normalize works');
    expect(text).toContain('1. Clean (1 steps)');
    expect(text).toContain('Verified: 2 step(s) kept, 1 dropped');
    expect(text).toContain('dropped s3');
    expect(text).toContain('? unresolved: likely handlers[name]');
  });

  it('renders a step with its code window, example, references and docs', () => {
    const screen = screensOf(walkthrough)[0];
    const text = renderToString(<StepView screen={screen} number={1} total={2} codeLines={() => code} />, { columns: 100 });
    expect(text).toContain('Clean · step 1/2 · api/x.ts:2-3');
    // Three lines of context after the highlighted lines, none before line 1.
    expect(text).toContain(' 1 │ line1');
    expect(text).toContain(' 6 │ line6');
    expect(text).not.toContain('line7');
    expect(text).toContain('Example phone = "+91 98765-43210"');
    expect(text).toContain('caller api/y.ts:4');
    expect(text).toContain('https://expressjs.com/en/4x/api.html#res.json');
    expect(text).toContain('! throws on empty input');
  });

  it('renders overview notes under the summary', () => {
    const text = renderToString(<Overview walkthrough={walkthrough} notes={['Imported by: api/y.ts (normalize)']} />, { columns: 100 });
    expect(text).toContain('Imported by: api/y.ts (normalize)');
  });
});
