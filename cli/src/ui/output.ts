import { createElement } from 'react';
import { render } from 'ink';
import { codeReader, endpointNotes, flattenWalkthrough, overviewNotes, renderMarkdown, type SavedWalkthrough } from '@codewalk/core';
import type { IO } from '../commands/shared.js';
import { Stepper } from './Stepper.js';
import { formatWalkthrough } from './format.js';

// Prints a saved walkthrough in the format `--out` asks for. Shared by `walk fn` and `walk file`,
// so both commands give the same JSON shape: the stepper walkthrough plus the file overview (null for fn).

export type OutFormat = 'terminal' | 'json' | 'md';

export async function printWalkthrough(saved: SavedWalkthrough, out: OutFormat, repoRoot: string, io: IO, interactive: boolean): Promise<void> {
  const codeLines = codeReader(repoRoot);
  const walkthrough = flattenWalkthrough(saved);
  const notes = saved.overview ? overviewNotes(saved.overview) : saved.endpoint ? endpointNotes(saved.endpoint) : [];
  if (out === 'json') {
    io.log(JSON.stringify({ ...walkthrough, overview: saved.overview, endpoint: saved.endpoint ?? null }, null, 2));
  } else if (out === 'md') {
    io.log(renderMarkdown(saved, codeLines));
  } else if (interactive) {
    const app = render(createElement(Stepper, { walkthrough, codeLines, notes }));
    await app.waitUntilExit();
  } else {
    io.log(formatWalkthrough(walkthrough, codeLines, notes));
  }
}
