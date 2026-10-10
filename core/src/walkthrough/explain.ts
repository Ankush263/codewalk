import { dirname, join } from 'node:path';
import type { PackageFact } from '../context/fn.js';
import { DocsResolver } from '../docs/resolve.js';
import { generateWalkthrough, type LlmProvider } from '../llm/generate.js';
import { verifyWalkthrough, type VerifyFacts } from '../verify/verify.js';
import { NoVerifiedStepsError, type FnWalkthrough } from './fn.js';

// Generate -> verify -> docs links for walkthroughs whose steps may cite several files (endpoint,
// component). Docs resolve from each step's own file's directory (nearest package.json / node_modules).

export interface GroundedRequest {
  system: string;
  prompt: string;
  facts: VerifyFacts;
  packages: PackageFact[];
  /** Static unresolved notes; always kept, whatever the model returns. */
  unresolved: string[];
  scope: FnWalkthrough['scope'];
}

export async function explainGrounded(provider: LlmProvider, request: GroundedRequest, repoRoot: string): Promise<FnWalkthrough> {
  const { walkthrough, attempts } = await generateWalkthrough(provider, { system: request.system, prompt: request.prompt });
  const verified = verifyWalkthrough(walkthrough, request.facts);
  const keptSteps = verified.walkthrough.stages.reduce((n, s) => n + s.steps.length, 0);
  if (keptSteps === 0) throw new NoVerifiedStepsError(verified.dropped);

  const packages = new Map(request.packages.map((p) => [p.name, p]));
  const resolvers = new Map<string, DocsResolver>();
  const docsFor = (file: string) => {
    const dir = dirname(join(repoRoot, file));
    if (!resolvers.has(dir)) resolvers.set(dir, new DocsResolver(repoRoot, dir));
    return resolvers.get(dir)!;
  };

  return {
    scope: request.scope,
    title: verified.walkthrough.title,
    summary: verified.walkthrough.summary,
    stages: verified.walkthrough.stages.map((stage) => ({
      name: stage.name,
      steps: stage.steps.map((step) => ({ ...step, docLinks: step.docs.map((d) => docsFor(step.code_ref.file).resolve(d, packages.get(d.package)!)) })),
    })),
    unresolved: [...new Set([...request.unresolved, ...verified.walkthrough.unresolved])],
    verification: { attempts, keptSteps, dropped: verified.dropped, removedDocs: verified.removedDocs },
  };
}
