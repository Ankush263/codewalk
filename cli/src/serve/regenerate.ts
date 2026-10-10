import type { LlmProvider, SavedWalkthrough } from '@codewalk/core';
import { runComponent } from '../commands/component.js';
import { runEndpoint } from '../commands/endpoint.js';
import { runFile } from '../commands/file.js';
import { runFn } from '../commands/fn.js';
import { runTrace } from '../commands/trace.js';

/**
 * Re-runs the command that made `saved`, with its depth and without --refresh: fresh sections are reused,
 * only stale code is re-explained. Returns the exit code and the command's error lines.
 */
export async function regenerate(repoRoot: string, saved: SavedWalkthrough, deps: { provider?: LlmProvider }): Promise<{ code: number; errors: string[] }> {
  const errors: string[] = [];
  const io = { log: () => {}, error: (line: string) => errors.push(line) };
  const options = { llm: true, depth: saved.sections[0]?.depth ?? 2, out: 'json' as const, refresh: false };
  const d = { provider: deps.provider, interactive: false };
  const ref = saved.scopeRef;
  let code: number;
  switch (saved.scopeKind) {
    case 'fn':
      code = await runFn(repoRoot, ref, options, io, d);
      break;
    case 'file':
      code = await runFile(repoRoot, ref, options, io, d);
      break;
    case 'endpoint':
      code = await runEndpoint(repoRoot, ref, options, io, d);
      break;
    case 'component':
      code = await runComponent(repoRoot, ref, options, io, d);
      break;
    case 'trace': {
      const [route, from] = ref.split(' <- ');
      code = await runTrace(repoRoot, route, { ...options, from }, io, d);
      break;
    }
  }
  return { code, errors: errors.filter((line) => line.startsWith('✖') || line.startsWith('  ')) };
}
