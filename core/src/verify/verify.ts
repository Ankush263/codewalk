import type { ComponentContext } from '../context/component.js';
import type { EndpointContext } from '../context/endpoint.js';
import type { TraceContext } from '../context/trace.js';
import type { FnContext } from '../context/fn.js';
import type { Step, Walkthrough } from '../llm/schema.js';

// The verifier (CLAUDE.md §8.3). Every location a step cites must be a real line of a file in the
// context, and every identifier its explanation names in backticks must appear in the context's
// code or facts. Failing steps are dropped and reported; docs for packages the target doesn't
// import are removed.

export interface DroppedStep {
  stepId: string;
  reasons: string[];
}

export interface VerifyResult {
  walkthrough: Walkthrough;
  dropped: DroppedStep[];
  /** Docs entries removed because their package is not imported by the target file. */
  removedDocs: { stepId: string; package: string; symbol: string }[];
}

// Words that can appear in an explanation's code spans without being declared anywhere.
const LANGUAGE_WORDS = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this', 'super',
  'await', 'async', 'return', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of', 'void', 'delete',
  'const', 'let', 'var', 'function', 'class', 'if', 'else', 'try', 'catch', 'finally', 'for', 'while',
  'switch', 'case', 'break', 'continue', 'import', 'export', 'default', 'from', 'as', 'type', 'interface',
]);

/** What a walkthrough may cite: files with their line counts, identifiers, and imported packages. */
export interface VerifyFacts {
  files: Record<string, number>;
  vocabulary: Set<string>;
  packages: Set<string>;
}

export function verifyFnWalkthrough(walkthrough: Walkthrough, ctx: FnContext): VerifyResult {
  return verifyWalkthrough(walkthrough, { files: ctx.files, vocabulary: buildVocabulary(ctx), packages: new Set(ctx.packages.map((p) => p.name)) });
}

export function verifyWalkthrough(walkthrough: Walkthrough, facts: VerifyFacts): VerifyResult {
  const dropped: DroppedStep[] = [];
  const removedDocs: VerifyResult['removedDocs'] = [];

  const stages = walkthrough.stages
    .map((stage) => ({
      ...stage,
      steps: stage.steps.flatMap((step): Step[] => {
        const reasons = checkStep(step, facts.files, facts.vocabulary);
        if (reasons.length > 0) {
          dropped.push({ stepId: step.id, reasons });
          return [];
        }
        const docs = step.docs.filter((d) => {
          if (facts.packages.has(d.package)) return true;
          removedDocs.push({ stepId: step.id, ...d });
          return false;
        });
        return [{ ...step, docs }];
      }),
    }))
    .filter((stage) => stage.steps.length > 0);

  return { walkthrough: { ...walkthrough, stages }, dropped, removedDocs };
}

/** Language words plus every identifier in `texts`. */
export function vocabularyOf(texts: Iterable<string | null | undefined>): Set<string> {
  const vocabulary = new Set(LANGUAGE_WORDS);
  for (const text of texts) if (text) for (const id of identifiers(text)) vocabulary.add(id);
  return vocabulary;
}

/** Everything an endpoint walkthrough may name or cite. */
export function endpointVerifyFacts(ctx: EndpointContext): VerifyFacts {
  const nodes = [...ctx.chain, ...ctx.errorHandlers];
  const symbols = [...nodes.flatMap((n) => (n.symbol ? [n.symbol] : [])), ...ctx.callees.flatMap((c) => (c.callee ? [c.callee] : []))];
  return {
    files: ctx.files,
    packages: new Set(ctx.packages.map((p) => p.name)),
    vocabulary: vocabularyOf([
      ...ctx.registrations.map((b) => b.lines.join('\n')),
      ...nodes.map((n) => n.code?.lines.join('\n')),
      ...ctx.callees.map((c) => c.code?.lines.join('\n')),
      ...nodes.map((n) => n.label),
      ...symbols.flatMap((s) => [s.name, s.signature]),
      ...ctx.callees.map((c) => c.calleeText),
      ...ctx.sideEffects.map((e) => e.detail),
      ...ctx.errorPaths.map((p) => p.error),
      ...ctx.packages.flatMap((p) => [p.name, ...p.importedNames]),
      ctx.route.fullPath,
    ]),
  };
}

/** Everything a component walkthrough may name or cite. */
export function componentVerifyFacts(ctx: ComponentContext): VerifyFacts {
  const units = [ctx.component, ...ctx.hooks];
  const symbols = [
    ...units.flatMap((u) => [u.symbol, ...u.inner]),
    ...ctx.callees.flatMap((c) => (c.callee ? [c.callee] : [])),
    ...ctx.types.map((t) => t.symbol),
    ...ctx.children.flatMap((c) => (c.symbol ? [c.symbol] : [])),
  ];
  return {
    files: ctx.files,
    packages: new Set(ctx.packages.map((p) => p.name)),
    vocabulary: vocabularyOf([
      ...units.map((u) => u.code?.lines.join('\n')),
      ...ctx.callees.map((c) => c.code?.lines.join('\n')),
      ...ctx.types.map((t) => t.code?.lines.join('\n')),
      ...ctx.values.flatMap((v) => [v.name, v.code?.lines.join('\n')]),
      ...symbols.flatMap((s) => [s.name, s.signature]),
      ...ctx.callees.map((c) => c.calleeText),
      ...ctx.children.flatMap((c) => [c.element, ...c.props.flatMap((p) => [p.name, p.value])]),
      ...ctx.apiCalls.flatMap((a) => [a.method, a.urlPattern, a.urlText]),
      ...units.flatMap((u) => [u.facts.propsType, ...u.facts.props, ...u.facts.state.flatMap((s) => [s.name, s.setter, s.initial]), ...u.facts.context.map((x) => x.context)]),
      ...ctx.packages.flatMap((p) => [p.name, ...p.importedNames]),
    ]),
  };
}

/** A trace may cite and name anything its component or endpoint context may. */
export function traceVerifyFacts(ctx: TraceContext): VerifyFacts {
  const front = componentVerifyFacts(ctx.component);
  const back = endpointVerifyFacts(ctx.endpoint);
  return { files: ctx.files, packages: new Set([...front.packages, ...back.packages]), vocabulary: new Set([...front.vocabulary, ...back.vocabulary]) };
}

function checkStep(step: Step, files: Record<string, number>, vocabulary: Set<string>): string[] {
  const reasons: string[] = [];
  const { file, start, end } = step.code_ref;
  const lines = files[file];
  if (lines === undefined) {
    reasons.push(`code_ref cites ${file}, which is not part of the indexed context`);
  } else if (start < 1 || end < start || end > lines) {
    reasons.push(`code_ref ${file}:${start}-${end} is outside the file's lines 1-${lines}`);
  }

  for (const ref of step.references) {
    const refLines = files[ref.file];
    if (refLines === undefined) {
      reasons.push(`reference ${ref.file}:${ref.line} cites a file that is not part of the indexed context`);
    } else if (ref.line < 1 || ref.line > refLines) {
      reasons.push(`reference ${ref.file}:${ref.line} is outside the file's lines 1-${refLines}`);
    }
  }

  const unknown = [...new Set(codeSpans(step.explanation).flatMap(identifiers))].filter((id) => !vocabulary.has(id));
  if (unknown.length > 0) {
    reasons.push(`explanation names identifiers not found in the code or index: ${unknown.map((u) => `\`${u}\``).join(', ')}`);
  }
  return reasons;
}

/** Every identifier that appears in the context's code and facts. */
export function buildVocabulary(ctx: FnContext): Set<string> {
  const vocabulary = new Set(LANGUAGE_WORDS);
  const add = (text: string | null | undefined) => {
    if (text) for (const id of identifiers(text)) vocabulary.add(id);
  };

  const blocks = [
    ctx.target.code,
    ...ctx.callers.map((c) => c.code),
    ...ctx.callees.map((c) => c.code),
    ...ctx.types.map((t) => t.code),
    ...ctx.values.map((v) => v.code),
  ];
  for (const block of blocks) if (block) add(block.lines.join('\n'));

  const symbols = [
    ...(ctx.target.symbol ? [ctx.target.symbol] : []),
    ...ctx.innerSymbols,
    ...ctx.callers.map((c) => c.symbol),
    ...ctx.callees.flatMap((c) => (c.callee ? [c.callee] : [])),
    ...ctx.types.map((t) => t.symbol),
  ];
  for (const s of symbols) {
    add(s.name);
    add(s.signature);
  }
  for (const c of ctx.callees) add(c.calleeText);
  for (const v of ctx.values) add(v.name);
  for (const p of ctx.packages) {
    add(p.name);
    for (const name of p.importedNames) add(name);
  }
  return vocabulary;
}

/** Contents of `inline code` spans. */
export function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** Identifiers in a code fragment. Escapes (\D, \n) are skipped; string contents count as code. */
export function identifiers(code: string): string[] {
  return code.replace(/\\./g, ' ').match(/[A-Za-z_$][\w$]*/g) ?? [];
}
