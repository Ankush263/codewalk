import { useState } from 'react';
import type { StepState, WalkthroughDetail } from '@codewalk/core';
import { Inline } from './Inline';
import type { PredictionStore } from './storage';

export type Step = WalkthroughDetail['walkthrough']['stages'][number]['steps'][number];

export interface StepPanelProps {
  step: Step;
  state: StepState | undefined;
  predict: boolean;
  predictionKey: string;
  storage: PredictionStore;
  onReference: (file: string, line: number) => void;
}

export function StepPanel({ step, state, predict, predictionKey, storage, onReference }: StepPanelProps) {
  const [prediction, setPrediction] = useState(() => storage.get(predictionKey) ?? '');
  const [revealed, setRevealed] = useState(() => storage.get(`${predictionKey}:revealed`) === '1');
  const hidden = predict && !revealed;
  return (
    <section className="step" aria-label="Explanation">
      {state && !state.fresh && <p className="badge stale">This step's code changed since it was explained.</p>}
      {predict && (
        <div className="predict">
          <label htmlFor={`prediction-${step.id}`}>Your prediction: what do these lines do?</label>
          <textarea
            id={`prediction-${step.id}`}
            value={prediction}
            readOnly={revealed}
            onChange={(e) => {
              setPrediction(e.target.value);
              storage.set(predictionKey, e.target.value);
            }}
          />
          {!revealed && (
            <button
              disabled={prediction.trim() === ''}
              onClick={() => {
                setRevealed(true);
                storage.set(`${predictionKey}:revealed`, '1');
              }}
            >
              Reveal
            </button>
          )}
        </div>
      )}
      {!hidden && <Explanation step={step} onReference={onReference} />}
    </section>
  );
}

export function Explanation({ step, onReference }: { step: Step; onReference: (file: string, line: number) => void }) {
  return (
    <>
      <p className="explanation">
        <Inline text={step.explanation} />
      </p>
      <dl className="example">
        <dt>Example</dt>
        <dd>{step.example.input}</dd>
        <dt>After this step</dt>
        <dd>{step.example.state_after}</dd>
      </dl>
      {step.references.length > 0 && (
        <>
          <h3>References</h3>
          <ul>
            {step.references.map((r) => (
              <li key={`${r.file}:${r.line}:${r.role}`}>
                <button className="link" onClick={() => onReference(r.file, r.line)}>
                  {r.role} {r.file}:{r.line}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {step.docLinks.length > 0 && (
        <>
          <h3>Docs</h3>
          <ul>
            {step.docLinks.map((d) => (
              <li key={`${d.package}:${d.symbol}`}>
                <a href={d.url} target="_blank" rel="noreferrer">
                  {d.package} {d.symbol}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      {step.concepts.length > 0 && (
        <p className="chips">
          {step.concepts.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </p>
      )}
      {step.risks.length > 0 && (
        <>
          <h3>What can go wrong</h3>
          <ul>
            {step.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
