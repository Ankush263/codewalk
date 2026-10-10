import type { QuestionView, StepState, WalkthroughDetail, WalkthroughListItem } from '../api.js';
import type { Store } from '../store/index.js';
import type { QuestionRecord } from '../store/types.js';
import { loadSavedWalkthrough } from './persist.js';
import { explainedSteps, flattenWalkthrough, questionOutdated, readLines, walkthroughNotes, type ScopeKind, type Section } from './saved.js';
import { describeStaleness } from './staleness.js';
import { walkthroughStatus, walkthroughStatuses } from './status.js';

// The view model `walk serve` returns. Built from the saved walkthrough, the current code and the index;
// the index must be current.

export async function walkthroughList(store: Store, repoRoot: string): Promise<WalkthroughListItem[]> {
  return (await walkthroughStatuses(store, repoRoot)).map(({ saved, savedAt, status }) => ({
    scopeKind: saved.scopeKind,
    scopeRef: saved.scopeRef,
    title: flattenWalkthrough(saved).title,
    savedAt: savedAt.toISOString(),
    fresh: status.fresh,
    staleSteps: status.staleSteps,
    totalSteps: status.totalSteps,
    staleSummary: status.fresh ? null : describeStaleness(saved.scopeKind, status),
  }));
}

export async function walkthroughDetail(store: Store, repoRoot: string, kind: ScopeKind, ref: string): Promise<WalkthroughDetail | null> {
  const [saved, record] = await Promise.all([loadSavedWalkthrough(store, kind, ref), store.getWalkthrough(kind, ref)]);
  if (!saved || !record) return null;
  const status = await walkthroughStatus(store, repoRoot, saved);
  const keyOf = (section: Section, id: string) => (saved.scopeKind === 'file' ? `${section.block.symbol ?? 'block'}/${id}` : id);

  const steps: Record<string, StepState> = {};
  saved.sections.forEach((section, i) => {
    for (const s of status.sections[i]?.steps ?? []) {
      steps[keyOf(section, s.stepId)] = { fresh: s.fresh, explainedAt: section.generatedAt, file: s.file, start: s.start, end: s.end };
    }
  });
  const walkthrough = flattenWalkthrough(saved);
  const cited = new Set(walkthrough.stages.flatMap((stage) => stage.steps.flatMap((s) => [s.code_ref.file, ...s.references.map((r) => r.file)])));
  const files = Object.fromEntries(
    [...cited].sort().flatMap((file) => {
      const lines = readLines(repoRoot, file);
      return lines ? [[file, lines] as const] : [];
    }),
  );
  const explained = explainedSteps(saved);
  const questions = (await store.listQuestions(kind, ref)).map((q) => toQuestionView(q, !(steps[q.stepId]?.fresh ?? false) || questionOutdated(explained, q)));

  return {
    scopeKind: kind,
    scopeRef: ref,
    savedAt: record.createdAt.toISOString(),
    walkthrough,
    notes: walkthroughNotes(saved),
    diagram: saved.endpoint?.diagram ?? saved.trace?.diagram ?? null,
    fresh: status.fresh,
    staleSummary: status.fresh ? null : describeStaleness(kind, status),
    steps,
    files,
    questions,
  };
}

export function toQuestionView(q: QuestionRecord, stale: boolean): QuestionView {
  return {
    id: q.id,
    stepId: q.stepId,
    question: q.question,
    answer: q.answer.answer,
    references: q.answer.references,
    warnings: q.answer.warnings,
    model: q.model,
    createdAt: q.createdAt.toISOString(),
    stale,
  };
}
