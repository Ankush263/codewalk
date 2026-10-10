import { buildComponentContext } from '../context/component.js';
import { buildEndpointContext } from '../context/endpoint.js';
import { buildFnContext } from '../context/fn.js';
import { parseComponentTarget, parseFnTarget, TargetError, type FnTarget } from '../context/target.js';
import { buildTraceContext } from '../context/trace.js';
import { generateAnswer } from '../llm/answer.js';
import { renderComponentPrompt } from '../llm/componentPrompt.js';
import { renderEndpointPrompt } from '../llm/endpointPrompt.js';
import type { LlmProvider } from '../llm/generate.js';
import { renderFnPrompt } from '../llm/prompt.js';
import { renderTracePrompt } from '../llm/tracePrompt.js';
import { parseEndpointTarget } from '../routes/match.js';
import type { Store } from '../store/index.js';
import type { QuestionRecord } from '../store/types.js';
import { checkAnswer, componentVerifyFacts, endpointVerifyFacts, fnVerifyFacts, traceVerifyFacts, type VerifyFacts } from '../verify/verify.js';
import type { WalkthroughStep } from './fn.js';
import { refreshMirror } from './persist.js';
import { readLines, type SavedWalkthrough, type Section } from './saved.js';
import { walkthroughStatus } from './status.js';

// Drill-down Q&A (CLAUDE.md §12 Phase 6): rebuild the walkthrough's facts from the current index with the
// builder its CLI command uses, answer from them, verify, save, and refresh the Markdown mirror.

const MAX_QUESTION = 2000;

export function locateStep(saved: SavedWalkthrough, stepId: string): { section: Section; step: WalkthroughStep; localId: string } {
  let section: Section | undefined;
  let localId = stepId;
  if (saved.scopeKind === 'file') {
    const slash = stepId.indexOf('/');
    localId = stepId.slice(slash + 1);
    const symbol = stepId.slice(0, slash);
    section = slash > 0 ? saved.sections.find((s) => (s.block.symbol ?? 'block') === symbol) : undefined;
  } else {
    section = saved.sections[0];
  }
  const step = section?.walkthrough.stages.flatMap((s) => s.steps).find((s) => s.id === localId);
  if (!section || !step) throw new TargetError(`No step "${stepId}" in the ${saved.scopeKind} walkthrough ${saved.scopeRef}.`);
  return { section, step, localId };
}

export async function askQuestion(
  provider: LlmProvider,
  store: Store,
  repoRoot: string,
  saved: SavedWalkthrough,
  stepId: string,
  question: string,
  options: { model: string; maxContextTokens: number },
): Promise<QuestionRecord> {
  const text = question.trim();
  if (text === '') throw new TargetError('Ask a question first.');
  if (text.length > MAX_QUESTION) throw new TargetError(`Questions are limited to ${MAX_QUESTION} characters.`);
  const { section, step, localId } = locateStep(saved, stepId);
  // Answer about the step's lines where they are now (they move when code above them changes); a step whose
  // own code changed has no grounded explanation left to ask about.
  const status = await walkthroughStatus(store, repoRoot, saved);
  const state = status.sections[saved.sections.indexOf(section)]?.steps.find((s) => s.stepId === localId);
  if (!state?.fresh) throw new TargetError(`Step ${stepId}'s code changed since it was explained; regenerate the walkthrough before asking about it.`);
  const { prompt, verify } = await factsFor(store, repoRoot, saved, section, options.maxContextTokens);
  const { file, start, end } = state;
  const code = { file, start, end, lines: (readLines(repoRoot, file) ?? []).slice(start - 1, end) };
  const current = { ...step, code_ref: { file, start, end } };
  const answer = await generateAnswer(provider, { facts: withoutInstruction(prompt), step: current, code, question: text });
  const checked = checkAnswer(answer, verify);
  const record = await store.saveQuestion({
    scopeKind: saved.scopeKind,
    scopeRef: saved.scopeRef,
    stepId,
    question: text,
    answer: { answer: answer.answer, ...checked },
    stepHash: section.stepHashes[localId] ?? '',
    model: options.model,
  });
  await refreshMirror(store, repoRoot, saved.scopeKind, saved.scopeRef);
  return record;
}

/** The prompt a walkthrough of this scope is written from, and what an answer may cite. */
async function factsFor(store: Store, repoRoot: string, saved: SavedWalkthrough, section: Section, maxContextTokens: number): Promise<{ prompt: string; verify: VerifyFacts }> {
  const options = { depth: section.depth, maxContextTokens };
  switch (saved.scopeKind) {
    case 'fn':
    case 'file': {
      const { block } = section;
      const target: FnTarget =
        saved.scopeKind === 'fn'
          ? parseFnTarget(saved.scopeRef)
          : block.symbol
            ? { kind: 'symbol', file: block.file, name: block.symbol }
            : { kind: 'range', file: block.file, start: block.start, end: block.end };
      const ctx = await buildFnContext(store, repoRoot, target, options);
      return { prompt: renderFnPrompt(ctx), verify: fnVerifyFacts(ctx) };
    }
    case 'endpoint': {
      const ctx = await buildEndpointContext(store, repoRoot, parseEndpointTarget(saved.scopeRef), options);
      return { prompt: renderEndpointPrompt(ctx), verify: endpointVerifyFacts(ctx) };
    }
    case 'component': {
      const ctx = await buildComponentContext(store, repoRoot, parseComponentTarget(saved.scopeRef), options);
      return { prompt: renderComponentPrompt(ctx), verify: componentVerifyFacts(ctx) };
    }
    case 'trace': {
      const [route, from] = saved.scopeRef.split(' <- ');
      const ctx = await buildTraceContext(store, repoRoot, { endpoint: parseEndpointTarget(route), from: parseComponentTarget(from) }, options);
      return { prompt: renderTracePrompt(ctx), verify: traceVerifyFacts(ctx) };
    }
  }
}

/** Every walkthrough prompt ends with a "Write …" instruction; Q&A replaces it with the question. */
function withoutInstruction(prompt: string): string {
  const cut = prompt.lastIndexOf('\n\nWrite ');
  return cut > 0 ? prompt.slice(0, cut) : prompt;
}
