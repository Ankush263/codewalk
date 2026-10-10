import type { QuestionView, WalkthroughDetail, WalkthroughListItem } from '@codewalk/core';
import { vi } from 'vitest';
import type { Api } from '../api';

const step = (id: string, file: string, start: number, end: number, explanation: string, extra: Partial<WalkthroughDetail['walkthrough']['stages'][number]['steps'][number]> = {}) => ({
  id,
  code_ref: { file, start, end },
  explanation,
  example: { input: `input ${id}`, state_after: `after ${id}` },
  references: [],
  docs: [],
  docLinks: [],
  concepts: ['middleware chain'],
  risks: [`risk ${id}`],
  ...extra,
});

export const EXPLAINED = '2026-10-10T09:00:00.000Z';
export const REEXPLAINED = '2026-10-11T09:00:00.000Z';

export const detail: WalkthroughDetail = {
  scopeKind: 'endpoint',
  scopeRef: 'POST /api/patients/enroll',
  savedAt: '2026-10-10T10:00:00.000Z',
  walkthrough: {
    scope: { file: 'api/app.ts', start: 1, end: 4, symbol: 'POST /api/patients/enroll' },
    title: 'How POST /api/patients/enroll works',
    summary: 'Enrolls a patient.',
    stages: [
      {
        name: 'Request',
        steps: [
          step('s1', 'api/app.ts', 2, 3, '`express.json` parses the body.', {
            references: [{ file: 'api/routes.ts', line: 2, role: 'callee' }],
            docLinks: [{ package: 'express', symbol: 'express.json', version: '4.19.2', url: 'https://expressjs.com/en/api.html#express.json', source: 'curated' }],
          }),
        ],
      },
      { name: 'Persistence', steps: [step('s2', 'api/service.ts', 4, 4, 'Writes the patient.')] },
    ],
    unresolved: [],
    verification: { attempts: 1, keptSteps: 2, dropped: [], removedDocs: [] },
  },
  notes: ['Route: POST /api/patients/enroll'],
  diagram: 'sequenceDiagram\n  Client->>P1: POST /api/patients/enroll',
  fresh: false,
  staleSummary: '1/2 steps stale · changed: insertPatient',
  steps: {
    s1: { fresh: true, explainedAt: EXPLAINED, file: 'api/app.ts', start: 2, end: 3 },
    s2: { fresh: false, explainedAt: EXPLAINED, file: 'api/service.ts', start: 4, end: 4 },
  },
  files: {
    'api/app.ts': ['const app = express();', 'app.use(express.json());', "app.use('/api', apiRouter);", 'export default app;'],
    'api/routes.ts': ['const r = Router();', "r.use('/patients', patients);"],
    'api/service.ts': ['a', 'b', 'c', 'await insertPatient(client, row);', 'e'],
  },
  questions: [
    { id: 1, stepId: 's1', question: 'Why json?', answer: 'Because `express.json` parses bodies.', references: [], warnings: [], model: 'm', createdAt: '2026-10-10T10:01:00.000Z', stale: true },
  ],
};

export const listItems: WalkthroughListItem[] = [
  { scopeKind: 'endpoint', scopeRef: 'POST /api/patients/enroll', title: 'How POST /api/patients/enroll works', savedAt: '2026-10-10T10:00:00.000Z', fresh: false, staleSteps: 1, totalSteps: 2, staleSummary: '1/2 steps stale · changed: insertPatient' },
  { scopeKind: 'fn', scopeRef: 'api/a.ts#f', title: 'How f works', savedAt: '2026-10-09T09:00:00.000Z', fresh: true, staleSteps: 0, totalSteps: 3, staleSummary: null },
];

export const answer: QuestionView = {
  id: 2, stepId: 's1', question: 'What does it parse?', answer: 'It parses `JSON` bodies.', references: [{ file: 'api/app.ts', line: 2, role: 'callee' }],
  warnings: ['Removed reference x.ts:1: not part of the indexed context.'], model: 'm', createdAt: '2026-10-10T10:02:00.000Z', stale: false,
};

export function fakeApi(overrides: Partial<Api> = {}) {
  const api = {
    list: vi.fn(async () => listItems),
    detail: vi.fn(async () => detail),
    ask: vi.fn(async (_kind: string, _ref: string, stepId: string, question: string) => ({ ...answer, stepId, question })),
    regenerate: vi.fn(async () => ({
      ...detail,
      fresh: true,
      staleSummary: null,
      steps: { s1: { ...detail.steps.s1, explainedAt: REEXPLAINED }, s2: { ...detail.steps.s2, fresh: true, explainedAt: REEXPLAINED } },
    })),
    ...overrides,
  };
  return api as typeof api & Api;
}

export const renderDiagram = async (source: string) => `<svg data-testid="diagram"><text>${source.split('\n')[0]}</text></svg>`;
