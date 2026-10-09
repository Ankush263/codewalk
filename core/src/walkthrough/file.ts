import type { FileContext } from '../context/file.js';
import { buildFnContext } from '../context/fn.js';
import { TargetError } from '../context/target.js';
import { LlmRequestError } from '../llm/anthropic.js';
import { LlmOutputError, type LlmProvider } from '../llm/generate.js';
import type { Store } from '../store/index.js';
import type { SymbolRecord } from '../store/types.js';
import { NoVerifiedStepsError } from './fn.js';
import { readLines, SAVED_VERSION, sourceFiles, type FileOverview, type SavedWalkthrough, type Section, type SymbolSummary } from './saved.js';
import { generateSection, reuseSection } from './section.js';

// `walk file` (CLAUDE.md §6.2): each function in dependency order, explained in condensed `walk fn`
// form. A function whose code is unchanged since the previous run reuses its saved section; only
// changed or new functions go to the LLM (CLAUDE.md §9).

export interface ExplainFileOptions {
  depth: number;
  maxContextTokens: number;
  model: string;
  /** Regenerate every function even if its saved section is still fresh. */
  refresh: boolean;
  onProgress?: (line: string) => void;
}

export interface ExplainFileResult {
  saved: SavedWalkthrough;
  generated: string[];
  reused: string[];
  /** A request or output error that stopped generation. Finished sections are still in `saved`. */
  aborted: Error | null;
}

export async function explainFile(
  store: Store,
  provider: LlmProvider,
  repoRoot: string,
  fileCtx: FileContext,
  previous: SavedWalkthrough | null,
  options: ExplainFileOptions,
): Promise<ExplainFileResult> {
  const lines = readLines(repoRoot, fileCtx.file) ?? [];
  const files = sourceFiles(repoRoot);
  const sections: Section[] = [];
  const generated: string[] = [];
  const reused: string[] = [];
  const failed: FileOverview['failed'] = [];
  let aborted: Error | null = null;

  for (const [i, symbol] of fileCtx.order.entries()) {
    const label = `[${i + 1}/${fileCtx.order.length}] ${symbol.name}`;
    const prev = previous?.sections.find((s) => s.block.symbol === symbol.name);
    const block = { start: symbol.startLine, end: symbol.endLine, lines: lines.slice(symbol.startLine - 1, symbol.endLine) };
    // Still valid for the current code. Used unless --refresh, and as a fallback when regenerating fails,
    // so a failed refresh never loses a walkthrough that was already paid for.
    const kept = prev ? reuseSection(prev, block, files, options.depth) : null;
    const keepOr = (reason: string) => {
      if (kept) {
        sections.push(kept);
        reused.push(symbol.name);
        options.onProgress?.(`${label}: ${reason}; kept the saved walkthrough`);
      } else {
        failed.push({ symbol: symbol.name, reason });
      }
    };
    if (kept && !options.refresh) {
      sections.push(kept);
      reused.push(symbol.name);
      options.onProgress?.(`${label}: unchanged, reused`);
      continue;
    }
    if (aborted) {
      keepOr('skipped after an earlier error');
      continue;
    }

    try {
      const target = { kind: 'range' as const, file: fileCtx.file, start: symbol.startLine, end: symbol.endLine };
      const ctx = await buildFnContext(store, repoRoot, target, options);
      options.onProgress?.(`${label}: explaining…`);
      sections.push(await generateSection(provider, ctx, repoRoot, { symbol: symbol.name, condensed: true, model: options.model, depth: options.depth }));
      generated.push(symbol.name);
    } catch (err) {
      if (err instanceof NoVerifiedStepsError || err instanceof TargetError) {
        keepOr(err.message);
      } else if (err instanceof LlmRequestError || err instanceof LlmOutputError) {
        // Likely to fail the same way for every function (auth, rate limit): stop asking.
        aborted = err;
        keepOr(err.message);
      } else {
        throw err;
      }
    }
  }

  const overview: FileOverview = {
    file: fileCtx.file,
    lineCount: fileCtx.lineCount,
    importers: fileCtx.importers,
    exports: fileCtx.exports.map(summary),
    helpers: fileCtx.helpers.map(summary),
    order: fileCtx.order.map((s) => s.name),
    cycleBreaks: fileCtx.cycleBreaks,
    failed,
  };
  return {
    saved: { version: SAVED_VERSION, scopeKind: 'file', scopeRef: fileCtx.file, overview, sections },
    generated,
    reused,
    aborted,
  };
}

function summary(s: SymbolRecord): SymbolSummary {
  return { name: s.name, kind: s.kind, line: s.startLine };
}
