import { describe, expect, it } from 'vitest';
import { formatList, type ListRow } from './format.js';

const row = (status: Partial<ListRow['status']>): ListRow => ({
  scopeKind: 'file',
  scopeRef: 'web/types.ts',
  savedAt: new Date('2026-10-09T10:00:00Z'),
  status: { fresh: false, sections: [], uncovered: [], fileRemoved: false, staleSteps: 0, totalSteps: 0, ...status },
});

describe('formatList', () => {
  it('says when the file of a file walkthrough was deleted', () => {
    expect(formatList([row({ fileRemoved: true })])).toBe('stale  file  web/types.ts  0/0 steps stale · file removed · saved 2026-10-09 10:00');
  });
});
