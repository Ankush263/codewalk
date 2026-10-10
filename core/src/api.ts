import type { Reference } from './llm/schema.js';
import type { FnWalkthrough } from './walkthrough/fn.js';
import type { ScopeKind } from './walkthrough/saved.js';

// The JSON `walk serve` sends to the web UI. Types only: the web app imports these, never core's code.

export interface WalkthroughListItem {
  scopeKind: ScopeKind;
  scopeRef: string;
  title: string;
  /** ISO time the content last changed. */
  savedAt: string;
  fresh: boolean;
  staleSteps: number;
  totalSteps: number;
  /** describeStaleness, when stale. */
  staleSummary: string | null;
}

/** Where a step's lines are now (fresh) or were when explained (stale). */
export interface StepState {
  fresh: boolean;
  /** When the step's section was explained (ISO); changes when it is regenerated. */
  explainedAt: string;
  file: string;
  start: number;
  end: number;
}

export interface QuestionView {
  id: number;
  stepId: string;
  question: string;
  answer: string;
  references: Reference[];
  warnings: string[];
  model: string;
  createdAt: string;
  /** The step's code changed (or was re-explained) since the question was answered. */
  stale: boolean;
}

export interface WalkthroughDetail {
  scopeKind: ScopeKind;
  scopeRef: string;
  savedAt: string;
  /** Flattened: a file walkthrough's steps have ids "<symbol>/<id>". */
  walkthrough: FnWalkthrough;
  notes: string[];
  /** Mermaid source for endpoints and traces. */
  diagram: string | null;
  fresh: boolean;
  staleSummary: string | null;
  steps: Record<string, StepState>;
  /** Current lines of every file a step or reference cites (missing files are left out). */
  files: Record<string, string[]>;
  questions: QuestionView[];
}
