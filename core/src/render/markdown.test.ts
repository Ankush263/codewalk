import { describe, expect, it } from 'vitest';
import { sectionFor } from '../walkthrough/__fixtures__/sections.js';
import { SAVED_VERSION, type SavedWalkthrough } from '../walkthrough/saved.js';
import type { QuestionRecord } from '../store/types.js';
import { renderMarkdown } from './markdown.js';

const SOURCE = ['function helper() {', '  return 1;', '}', '', 'function main() {', '  const x = helper();', '  return x + 1;', '}'];
const code = () => SOURCE;

describe('renderMarkdown', () => {
  it('renders a fn walkthrough with numbered code, examples and verification', () => {
    const section = sectionFor(SOURCE, 'a.ts', 'main', 5, 8);
    section.walkthrough.stages[0].steps[1].references = [{ file: 'a.ts', line: 1, role: 'callee' }];
    section.walkthrough.stages[0].steps[1].docLinks = [{ package: 'pg', symbol: 'Pool', version: '8.0.0', url: 'https://node-postgres.com/apis/pool', source: 'curated' }];
    section.walkthrough.unresolved = ['unresolved: likely handlers[name]'];
    const saved: SavedWalkthrough = { version: SAVED_VERSION, scopeKind: 'fn', scopeRef: 'a.ts#main', overview: null, sections: [section] };

    const md = renderMarkdown(saved, code);
    expect(md).toMatch(/^# Walkthrough of main\n\n`a\.ts:5-8`\n\nSummary\./);
    expect(md).toContain('## Body');
    expect(md).toContain('### Step 2 · `a.ts:6-6`');
    expect(md).toContain('```ts\n6 |   const x = helper();\n```');
    expect(md).toContain('**Example:** in  \n**After:** out');
    expect(md).toContain('- callee `a.ts:1`');
    expect(md).toContain('- [pg Pool](https://node-postgres.com/apis/pool)');
    expect(md).toContain('## Verification\n\nVerified: 4 step(s) kept, 0 dropped.');
    expect(md).toContain('## Unresolved\n\n- unresolved: likely handlers[name]');
  });

  it('renders a file walkthrough with its overview and one numbered section per function', () => {
    const saved: SavedWalkthrough = {
      version: SAVED_VERSION,
      scopeKind: 'file',
      scopeRef: 'a.ts',
      overview: { file: 'a.ts', lineCount: 8, importers: [], exports: [], helpers: [], order: ['helper', 'main'], cycleBreaks: [], failed: [] },
      sections: [sectionFor(SOURCE, 'a.ts', 'helper', 1, 3), sectionFor(SOURCE, 'a.ts', 'main', 5, 8)],
    };
    const md = renderMarkdown(saved, code);
    expect(md).toContain('# How a.ts works\n\n## Overview\n\n- Imported by: no indexed file');
    expect(md).toContain('- Walk order (helpers first): helper → main');
    expect(md).toContain('## 1. helper (`a.ts:1-3`)');
    expect(md).toContain('## 2. main (`a.ts:5-8`)');
    expect(md).toContain('#### Step 1 · `a.ts:5-5`');
    expect(md).toContain('Verified: 7 step(s) kept, 0 dropped.');
  });
});

describe('renderMarkdown: questions', () => {
  const step = { id: 's1', code_ref: { file: 'a.ts', start: 1, end: 1 }, explanation: 'It adds.', example: { input: 'x', state_after: 'y' }, references: [], docs: [], docLinks: [], concepts: [], risks: [] };
  const saved: SavedWalkthrough = {
    version: SAVED_VERSION,
    scopeKind: 'fn',
    scopeRef: 'a.ts#f',
    overview: null,
    sections: [
      {
        block: { file: 'a.ts', symbol: 'f', start: 1, end: 1, hash: 'h' },
        stepHashes: { s1: 'h' },
        fileHashes: {},
        refLines: {},
        generatedAt: '2026-10-10T00:00:00Z',
        model: 'm',
        depth: 2,
        walkthrough: {
          scope: { file: 'a.ts', start: 1, end: 1, symbol: 'f' },
          title: 'How f works',
          summary: 'S.',
          stages: [{ name: 'Do', steps: [step] }],
          unresolved: [],
          verification: { attempts: 1, keptSteps: 1, dropped: [], removedDocs: [] },
        },
      },
    ],
  };
  const question: QuestionRecord = {
    id: 1, scopeKind: 'fn', scopeRef: 'a.ts#f', stepId: 's1', question: 'Why add?', stepHash: 'h', model: 'm', createdAt: new Date(),
    answer: { answer: 'Because `f` sums.', references: [], warnings: [] },
  };

  it('lists each step’s questions under it', () => {
    const md = renderMarkdown(saved, () => ['const f = 1;'], [question]);
    expect(md).toContain('**Questions**\n- **Q:** Why add?\n  **A:** Because `f` sums.');
    expect(renderMarkdown(saved, () => ['const f = 1;'])).not.toContain('**Questions**');
  });
});

describe('renderMarkdown: question details (review minors)', () => {
  const base = (over: Partial<QuestionRecord>): QuestionRecord => ({
    id: 1, scopeKind: 'fn', scopeRef: 'a.ts#f', stepId: 's1', question: 'Q?', stepHash: 'h', model: 'm', createdAt: new Date('2026-10-10T01:00:00Z'),
    answer: { answer: 'A.', references: [], warnings: [] }, ...over,
  });
  const step = { id: 's1', code_ref: { file: 'a.ts', start: 1, end: 1 }, explanation: 'It adds.', example: { input: 'x', state_after: 'y' }, references: [], docs: [], docLinks: [], concepts: [], risks: [] };
  const saved: SavedWalkthrough = {
    version: SAVED_VERSION, scopeKind: 'fn', scopeRef: 'a.ts#f', overview: null,
    sections: [{
      block: { file: 'a.ts', symbol: 'f', start: 1, end: 1, hash: 'h' }, stepHashes: { s1: 'h' }, fileHashes: {}, refLines: {},
      generatedAt: '2026-10-10T00:00:00Z', model: 'm', depth: 2,
      walkthrough: { scope: { file: 'a.ts', start: 1, end: 1, symbol: 'f' }, title: 'How f works', summary: 'S.', stages: [{ name: 'Do', steps: [step] }], unresolved: [], verification: { attempts: 1, keptSteps: 1, dropped: [], removedDocs: [] } },
    }],
  };

  it('keeps multi-line answers inside the list item, shows warnings, and marks outdated answers', () => {
    const md = renderMarkdown(saved, () => ['const f = 1;'], [
      base({ id: 1, question: 'And then?', answer: { answer: 'First line.\nSecond line.', references: [], warnings: ['Names identifiers not found in the code or index: `g`'] } }),
      base({ id: 2, question: 'Old?', stepHash: 'other', answer: { answer: 'Was.', references: [], warnings: [] } }),
      base({ id: 3, question: 'Before?', createdAt: new Date('2026-10-09T00:00:00Z'), answer: { answer: 'Earlier.', references: [], warnings: [] } }),
    ]);
    expect(md).toContain(
      [
        '**Questions**',
        '- **Q:** And then?',
        '  **A:** First line.',
        '  Second line.',
        '  ⚠ Names identifiers not found in the code or index: `g`',
        '- **Q:** Old? *(stale: asked about an earlier explanation)*',
        '  **A:** Was.',
        '- **Q:** Before? *(stale: asked about an earlier explanation)*',
        '  **A:** Earlier.',
      ].join('\n'),
    );
  });
});

