import type { WalkthroughStep } from '../fn.js';
import { hashLines, type Section } from '../saved.js';

// Builds saved sections straight from source text, one step per line, for staleness and reuse tests.

export function lineStep(id: string, file: string, line: number): WalkthroughStep {
  return {
    id,
    code_ref: { file, start: line, end: line },
    explanation: `Line ${line}.`,
    example: { input: 'in', state_after: 'out' },
    references: [],
    docs: [],
    concepts: [],
    risks: [],
    docLinks: [],
  };
}

export function sectionFor(lines: string[], file: string, symbol: string | null, start: number, end: number): Section {
  const steps = Array.from({ length: end - start + 1 }, (_, i) => lineStep(`s${i + 1}`, file, start + i));
  return {
    block: { file, symbol, start, end, hash: hashLines(lines.slice(start - 1, end)) },
    stepHashes: Object.fromEntries(steps.map((s) => [s.id, hashLines(lines.slice(s.code_ref.start - 1, s.code_ref.end))])),
    fileHashes: { [file]: 'file-hash-at-generation' },
    refLines: {},
    model: 'm',
    depth: 2,
    generatedAt: '2026-10-09T00:00:00.000Z',
    walkthrough: {
      scope: { file, start, end, symbol },
      title: `Walkthrough of ${symbol}`,
      summary: 'Summary.',
      stages: [{ name: 'Body', steps }],
      unresolved: [],
      verification: { attempts: 1, keptSteps: steps.length, dropped: [], removedDocs: [] },
    },
  };
}
