import type { QuestionView, ScopeKind } from '@codewalk/core';
import { useState, type FormEvent } from 'react';
import type { Api } from './api';
import { Inline } from './Inline';

export interface QuestionPanelProps {
  api: Api;
  kind: ScopeKind;
  scopeRef: string;
  stepId: string;
  questions: QuestionView[];
  onAsked: (question: QuestionView) => void;
  /** The unsent question for this step, kept by the parent across step changes. */
  draft: string;
  onDraft: (text: string) => void;
}

/** Questions on this step, answered from the index's facts and verified like steps (spec Decision 1). */
export function QuestionPanel({ api, kind, scopeRef, stepId, questions, onAsked, draft: text, onDraft: setText }: QuestionPanelProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const question = text.trim();
    if (!question) return;
    setPending(true);
    setError(null);
    try {
      onAsked(await api.ask(kind, scopeRef, stepId, question));
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="questions" aria-label="Questions">
      <h3>Ask about this step</h3>
      {questions.map((q) => (
        <div key={q.id} className="qa">
          <p>
            <strong>Q:</strong> {q.question} {q.stale && <span className="badge stale">stale</span>}
          </p>
          <p>
            <strong>A:</strong> <Inline text={q.answer} />
          </p>
          {q.references.length > 0 && <p className="ref">{q.references.map((r) => `${r.file}:${r.line}`).join(', ')}</p>}
          {q.warnings.map((w) => (
            <p key={w} className="warning">
              ⚠ {w}
            </p>
          ))}
        </div>
      ))}
      <form onSubmit={ask}>
        <textarea aria-label="Question" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. What happens if the session is missing?" />
        <button type="submit" disabled={pending || text.trim() === ''}>
          {pending ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
