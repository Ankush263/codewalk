import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import type { FnWalkthrough, WalkthroughStep } from '@codewalk/core';

// Terminal stepper for `walk fn`: an overview screen, then one screen per verified step.
// ←/→ (or h/l, p/n) move between screens; q or Esc quits.

const CONTEXT_LINES = 3;

export interface StepperProps {
  walkthrough: FnWalkthrough;
  codeLines: (file: string) => string[];
  /** Extra overview lines, e.g. a file's importers and exports. */
  notes?: string[];
}

interface Screen {
  stage: string;
  step: WalkthroughStep;
}

export function screensOf(w: FnWalkthrough): Screen[] {
  return w.stages.flatMap((stage) => stage.steps.map((step) => ({ stage: stage.name, step })));
}

/** Screen index after a key press; 0 is the overview, 1..n are steps. Null means quit. */
export function navigate(index: number, count: number, input: string, key: { leftArrow?: boolean; rightArrow?: boolean; escape?: boolean; return?: boolean }): number | null {
  if (input === 'q' || key.escape) return null;
  if (key.rightArrow || key.return || input === 'l' || input === 'n' || input === ' ') return Math.min(index + 1, count);
  if (key.leftArrow || input === 'h' || input === 'p') return Math.max(index - 1, 0);
  return index;
}

export function Stepper({ walkthrough, codeLines, notes = [] }: StepperProps) {
  const { exit } = useApp();
  const screens = screensOf(walkthrough);
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    const next = navigate(index, screens.length, input, key);
    if (next === null) exit();
    else setIndex(next);
  });

  return (
    <Box flexDirection="column">
      {index === 0 ? (
        <Overview walkthrough={walkthrough} notes={notes} />
      ) : (
        <StepView screen={screens[index - 1]} number={index} total={screens.length} codeLines={codeLines} />
      )}
      <Text dimColor>
        {index === 0 ? 'overview' : `step ${index}/${screens.length}`} · ← prev · → next · q quit
      </Text>
    </Box>
  );
}

export function Overview({ walkthrough: w, notes = [] }: { walkthrough: FnWalkthrough; notes?: string[] }) {
  const v = w.verification;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{w.title}</Text>
      <Text dimColor>
        {w.scope.file}:{w.scope.start}-{w.scope.end}
      </Text>
      <Box marginTop={1}>
        <Text>{w.summary}</Text>
      </Box>
      {notes.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {notes.map((n, i) => (
            <Text key={i} dimColor>
              {n}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {w.stages.map((s, i) => (
          <Text key={i}>
            {i + 1}. {s.name} <Text dimColor>({s.steps.length} steps)</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={v.dropped.length ? 'yellow' : 'green'}>
          Verified: {v.keptSteps} step(s) kept, {v.dropped.length} dropped
        </Text>
        {v.dropped.map((d) => (
          <Text key={d.stepId} dimColor>
            {'  '}dropped {d.stepId}: {d.reasons.join('; ')}
          </Text>
        ))}
      </Box>
      {w.unresolved.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">Unresolved</Text>
          {w.unresolved.map((u, i) => (
            <Text key={i}>  ? {u}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

export function StepView({ screen, number, total, codeLines }: { screen: Screen; number: number; total: number; codeLines: (file: string) => string[] }) {
  const { step, stage } = screen;
  const { file, start, end } = step.code_ref;
  const lines = codeLines(file);
  const first = Math.max(1, start - CONTEXT_LINES);
  const last = Math.min(lines.length, end + CONTEXT_LINES);
  const width = String(last).length;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold>{stage}</Text>
        <Text dimColor>
          {' '}· step {number}/{total} · {file}:{start}-{end}
        </Text>
      </Text>

      <Box flexDirection="column" marginY={1} borderStyle="round" borderDimColor paddingX={1}>
        {lines.slice(first - 1, last).map((line, i) => {
          const n = first + i;
          const active = n >= start && n <= end;
          return (
            <Text key={n} dimColor={!active} wrap="truncate-end">
              <Text color={active ? 'cyan' : undefined}>{String(n).padStart(width)} │ </Text>
              {line}
            </Text>
          );
        })}
      </Box>

      <Text>{step.explanation}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="magenta">Example </Text>
          {step.example.input}
        </Text>
        <Text>
          <Text color="magenta">  after </Text>
          {step.example.state_after}
        </Text>
      </Box>

      {step.references.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>References</Text>
          {step.references.map((r, i) => (
            <Text key={i}>
              {'  '}
              <Text dimColor>{r.role.padEnd(6)}</Text> {r.file}:{r.line}
            </Text>
          ))}
        </Box>
      )}

      {step.docLinks.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Docs</Text>
          {step.docLinks.map((d, i) => (
            <Text key={i}>
              {'  '}
              {d.package} {d.symbol} <Text color="blue">{d.url}</Text>
            </Text>
          ))}
        </Box>
      )}

      {step.concepts.length > 0 && (
        <Box marginTop={1}>
          <Text>
            <Text bold>Concepts </Text>
            {step.concepts.join(' · ')}
          </Text>
        </Box>
      )}

      {step.risks.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="red">
            Risks
          </Text>
          {step.risks.map((r, i) => (
            <Text key={i}>  ! {r}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
