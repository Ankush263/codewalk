import { readFileSync } from 'node:fs';
import { loadConfig } from '../../config.js';
import { buildEndpointContext } from '../../context/endpoint.js';
import { indexRepo } from '../../indexer/index.js';
import type { LlmProvider } from '../../llm/generate.js';
import type { Store } from '../../store/index.js';
import { endpointOverviewOf, generateEndpointSection } from '../endpoint.js';
import { persistWalkthrough } from '../persist.js';
import { SAVED_VERSION, type SavedWalkthrough } from '../saved.js';

// Saves the recorded walkthrough of POST /api/patients/enroll into a temp copy of the fixture, exactly
// as `walk endpoint` would. Never call it on the fixture itself: it writes .walkthrough/walkthroughs/.

export const ENDPOINT_REF = 'POST /api/patients/enroll';
const RECORDED = readFileSync(new URL('../../llm/__fixtures__/enrollEndpoint.response.json', import.meta.url), 'utf8');
export const recordedEndpoint: LlmProvider = { generate: async () => RECORDED };

export async function seedEndpointWalkthrough(store: Store, repo: string): Promise<SavedWalkthrough> {
  await indexRepo(repo, loadConfig(repo), store);
  const ctx = await buildEndpointContext(store, repo, { method: 'POST', path: '/api/patients/enroll' }, { depth: 3, maxContextTokens: 60000 });
  const section = await generateEndpointSection(recordedEndpoint, ctx, repo, { model: 'recorded', depth: 3 });
  const saved: SavedWalkthrough = { version: SAVED_VERSION, scopeKind: 'endpoint', scopeRef: ctx.scopeRef, overview: null, endpoint: endpointOverviewOf(ctx), sections: [section] };
  await persistWalkthrough(store, repo, saved);
  return saved;
}
