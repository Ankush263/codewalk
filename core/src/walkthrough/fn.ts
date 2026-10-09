import { dirname, join } from 'node:path';
import type { FnContext } from '../context/fn.js';
import { DocsResolver, type DocLink } from '../docs/resolve.js';
import { generateFnWalkthrough, type LlmProvider } from '../llm/generate.js';
import type { Step } from '../llm/schema.js';
import { verifyFnWalkthrough, type DroppedStep, type VerifyResult } from '../verify/verify.js';

// `walk fn` after the facts are gathered: LLM -> verifier -> docs links.

export interface WalkthroughStep extends Step {
  docLinks: DocLink[];
}

export interface FnWalkthrough {
  scope: { file: string; start: number; end: number; symbol: string | null };
  title: string;
  summary: string;
  stages: { name: string; steps: WalkthroughStep[] }[];
  unresolved: string[];
  verification: {
    /** LLM requests needed to get schema-valid output (1 = first try). */
    attempts: number;
    keptSteps: number;
    dropped: DroppedStep[];
    removedDocs: VerifyResult['removedDocs'];
  };
}

export class NoVerifiedStepsError extends Error {
  constructor(public readonly dropped: DroppedStep[]) {
    super(`All ${dropped.length} steps failed verification; nothing reliable to show.`);
    this.name = 'NoVerifiedStepsError';
  }
}

export async function explainFn(provider: LlmProvider, ctx: FnContext, repoRoot: string): Promise<FnWalkthrough> {
  const { walkthrough, attempts } = await generateFnWalkthrough(provider, ctx);
  const verified = verifyFnWalkthrough(walkthrough, ctx);
  const keptSteps = verified.walkthrough.stages.reduce((n, s) => n + s.steps.length, 0);
  if (keptSteps === 0) throw new NoVerifiedStepsError(verified.dropped);

  const docs = new DocsResolver(repoRoot, dirname(join(repoRoot, ctx.target.file)));
  const packages = new Map(ctx.packages.map((p) => [p.name, p]));

  // The verifier's "unresolved" list must include every statically unresolved call, whatever the model returned.
  const unresolved = [...new Set([...ctx.unresolved.map((u) => u.note), ...verified.walkthrough.unresolved])];

  return {
    scope: { file: ctx.target.file, start: ctx.target.start, end: ctx.target.end, symbol: ctx.target.symbol?.name ?? null },
    title: verified.walkthrough.title,
    summary: verified.walkthrough.summary,
    stages: verified.walkthrough.stages.map((stage) => ({
      name: stage.name,
      steps: stage.steps.map((step) => ({ ...step, docLinks: step.docs.map((d) => docs.resolve(d, packages.get(d.package)!)) })),
    })),
    unresolved,
    verification: { attempts, keptSteps, dropped: verified.dropped, removedDocs: verified.removedDocs },
  };
}
