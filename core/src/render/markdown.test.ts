import { describe, expect, it } from 'vitest';
import { sectionFor } from '../walkthrough/__fixtures__/sections.js';
import { SAVED_VERSION, type SavedWalkthrough } from '../walkthrough/saved.js';
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
