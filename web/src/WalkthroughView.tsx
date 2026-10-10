import type { QuestionView, ScopeKind, WalkthroughDetail } from '@codewalk/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Api } from './api';
import { CodePanel } from './CodePanel';
import { Diagram } from './Diagram';
import { QuestionPanel } from './QuestionPanel';
import { StepPanel } from './StepPanel';
import type { PredictionStore } from './storage';

export interface WalkthroughViewProps {
  api: Api;
  kind: ScopeKind;
  scopeRef: string;
  storage: PredictionStore;
  renderDiagram?: (source: string) => Promise<string>;
}

export function WalkthroughView({ api, kind, scopeRef, storage, renderDiagram }: WalkthroughViewProps) {
  const [detail, setDetail] = useState<WalkthroughDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [focus, setFocus] = useState<{ file: string; line: number } | null>(null);
  const [predict, setPredict] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [asked, setAsked] = useState<QuestionView[]>([]);
  // Unsent questions per step, so moving between steps doesn't lose what was typed.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    api.detail(kind, scopeRef).then(setDetail, (e: Error) => setError(e.message));
  }, [api, kind, scopeRef]);

  const steps = useMemo(() => (detail ? detail.walkthrough.stages.flatMap((stage) => stage.steps.map((step) => ({ stage: stage.name, step }))) : []), [detail]);
  const go = useCallback(
    (i: number) => {
      setIndex(Math.max(0, Math.min(steps.length - 1, i)));
      setFocus(null);
    },
    [steps.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
      // Modified arrows belong to the browser and OS (Alt+← is Back on Windows and Linux).
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowRight') go(index + 1);
      if (e.key === 'ArrowLeft') go(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index]);

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!detail) return <p>Loading…</p>;

  const regenerate = async () => {
    setRegenerating(true);
    setRegenError(null);
    try {
      setDetail(await api.regenerate(kind, scopeRef));
      setAsked([]);
      go(0);
    } catch (e) {
      // Keep the reader: a failed regeneration leaves the saved walkthrough as it was.
      setRegenError((e as Error).message);
    } finally {
      setRegenerating(false);
    }
  };

  const w = detail.walkthrough;
  const current = steps[index];
  const state = current ? detail.steps[current.step.id] : undefined;
  const codeAt = focus
    ? { file: focus.file, start: focus.line, end: focus.line }
    : current
      ? { file: state?.file ?? current.step.code_ref.file, start: state?.start ?? current.step.code_ref.start, end: state?.end ?? current.step.code_ref.end }
      : null;

  return (
    <div className="walkthrough">
      <header>
        <h1>{w.title}</h1>
        <div className="ref">
          {kind} · {scopeRef}
        </div>
        <p>{w.summary}</p>
        {!detail.fresh && (
          <div className="stale-banner">
            <span>Stale: {detail.staleSummary}</span>
            <button onClick={regenerate} disabled={regenerating}>
              {regenerating ? 'Regenerating…' : 'Regenerate'}
            </button>
            {regenError && (
              <span role="alert" className="error">
                {regenError}
              </span>
            )}
          </div>
        )}
        <label className="toggle">
          <input type="checkbox" checked={predict} onChange={(e) => setPredict(e.target.checked)} /> Predict first, then reveal
        </label>
        {detail.notes.length > 0 && (
          <details className="notes">
            <summary>Facts from the index</summary>
            <ul>
              {detail.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        )}
        {detail.diagram && <Diagram source={detail.diagram} render={renderDiagram} />}
      </header>

      {current && codeAt ? (
        <>
          <nav className="steps" aria-label="Steps">
            {steps.map((s, i) => (
              <button key={s.step.id} aria-current={i === index ? 'step' : undefined} title={s.stage} onClick={() => go(i)}>
                {i + 1}
              </button>
            ))}
          </nav>
          <div className="stepnav">
            <button onClick={() => go(index - 1)} disabled={index === 0}>
              ← Prev
            </button>
            <span>
              Step {index + 1} of {steps.length} · {current.stage}
            </span>
            <button onClick={() => go(index + 1)} disabled={index === steps.length - 1}>
              Next →
            </button>
          </div>
          <div className="columns">
            <CodePanel files={detail.files} file={codeAt.file} start={codeAt.start} end={codeAt.end} />
            <div>
              <StepPanel
                key={`${current.step.id}:${state?.explainedAt ?? ''}`}
                step={current.step}
                state={state}
                predict={predict}
                predictionKey={`codewalk:predict:${kind}:${scopeRef}:${current.step.id}:${state?.explainedAt ?? ''}`}
                storage={storage}
                onReference={(file, line) => setFocus({ file, line })}
              />
              <QuestionPanel
                key={`q:${current.step.id}`}
                api={api}
                kind={kind}
                scopeRef={scopeRef}
                stepId={current.step.id}
                questions={[...detail.questions, ...asked].filter((q) => q.stepId === current.step.id)}
                onAsked={(q) => setAsked((list) => [...list, q])}
                draft={drafts[current.step.id] ?? ''}
                onDraft={(text) => setDrafts((d) => ({ ...d, [current.step.id]: text }))}
              />
            </div>
          </div>
        </>
      ) : (
        <p>This walkthrough has no steps.</p>
      )}
    </div>
  );
}
