import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import {
  AnthropicProvider,
  askQuestion,
  indexRepo,
  LlmOutputError,
  LlmRequestError,
  loadSavedWalkthrough,
  NoVerifiedStepsError,
  PinNeededError,
  TargetError,
  toQuestionView,
  walkthroughDetail,
  walkthroughList,
  type LlmProvider,
  type ScopeKind,
  type Store,
  type WalkConfig,
} from '@codewalk/core';
import { regenerate } from './regenerate.js';

// `walk serve` (CLAUDE.md §5): the JSON API and the built web app, for this machine only. Every request
// must name 127.0.0.1/localhost as its Host (blocks DNS rebinding); POSTs, which can spend LLM credits,
// also need `X-Codewalk: 1` and a JSON body, which a cross-site page can't send without a CORS preflight
// this server never answers.

export interface ServeContext {
  repoRoot: string;
  config: WalkConfig;
  store: Store;
  /** The built web app (web/dist); null when it hasn't been built. */
  webRoot: string | null;
  provider?: LlmProvider;
  /** One index pass (tests count them); defaults to indexRepo for this repo. */
  index?: () => Promise<unknown>;
  /** Page views reuse an index pass this recent (ms); questions always reindex. Default 2000. */
  reindexWindowMs?: number;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const KINDS: ReadonlySet<string> = new Set(['fn', 'file', 'endpoint', 'component', 'trace']);
const MAX_BODY = 64 * 1024;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>codewalk</title><h1>codewalk</h1>
<p>The web UI is not built yet. In the codewalk checkout run <code>pnpm --filter @codewalk/web build</code>, then restart <code>walk serve</code>.</p>`;

export function createServeServer(ctx: ServeContext): Server {
  let provider: LlmProvider | undefined = ctx.provider;
  const llm = () => (provider ??= new AnthropicProvider(ctx.config.llm.model));
  // Index passes and regenerations write to the same schema: run them one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };
  const index = ctx.index ?? (() => indexRepo(ctx.repoRoot, ctx.config, ctx.store));
  const window = ctx.reindexWindowMs ?? 2000;
  let lastIndexed = 0;
  let regenerating = 0;
  /**
   * Brings the index up to date. Page views skip it during a regeneration (which indexes on its own) and
   * reuse a pass from the last `window` ms; a question forces one, since it checks the step is still fresh.
   */
  const reindex = async (force = false): Promise<void> => {
    if (!force && regenerating > 0) return;
    await exclusive(async () => {
      if (!force && Date.now() - lastIndexed < window) return;
      await index();
      lastIndexed = Date.now();
    });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => sendError(res, err));
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { port } = server.address() as AddressInfo;
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, `Refusing a request for host "${host}"; open http://127.0.0.1:${port} instead.`);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, ctx.webRoot, url.pathname);

    if (req.method === 'POST') {
      if (req.headers['x-codewalk'] !== '1') throw new HttpError(403, 'POST requests need the header X-Codewalk: 1.');
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'POST requests must send JSON.');
    }

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/walkthroughs':
        await reindex();
        return sendJson(res, 200, await walkthroughList(ctx.store, ctx.repoRoot));
      case 'GET /api/walkthrough': {
        const { kind, ref } = scope(url.searchParams.get('kind'), url.searchParams.get('ref'));
        await reindex();
        const detail = await walkthroughDetail(ctx.store, ctx.repoRoot, kind, ref);
        if (!detail) throw new HttpError(404, `No saved ${kind} walkthrough ${ref}.`);
        return sendJson(res, 200, detail);
      }
      case 'POST /api/questions': {
        const body = await readJson(req);
        const { kind, ref } = scope(body.kind, body.ref);
        const stepId = field(body.stepId, 'stepId');
        const question = field(body.question, 'question');
        await reindex(true);
        const saved = await loadSavedWalkthrough(ctx.store, kind, ref);
        if (!saved) throw new HttpError(404, `No saved ${kind} walkthrough ${ref}.`);
        const record = await askQuestion(llm(), ctx.store, ctx.repoRoot, saved, stepId, question, {
          model: ctx.config.llm.model,
          maxContextTokens: ctx.config.llm.maxContextTokens,
        });
        return sendJson(res, 200, toQuestionView(record, false));
      }
      case 'POST /api/regenerate': {
        const body = await readJson(req);
        const { kind, ref } = scope(body.kind, body.ref);
        const saved = await loadSavedWalkthrough(ctx.store, kind, ref);
        if (!saved) throw new HttpError(404, `No saved ${kind} walkthrough ${ref}.`);
        // Rows the command writes get a newer created_at (database time) than any row before it.
        const before = Math.max(0, ...(await ctx.store.listWalkthroughs()).map((w) => w.createdAt.getTime()));
        regenerating++;
        let result: { code: number; errors: string[] };
        try {
          result = await exclusive(() => regenerate(ctx.repoRoot, saved, { provider }));
          lastIndexed = Date.now(); // the command indexed before regenerating
        } finally {
          regenerating--;
        }
        if (result.code !== 0) throw new HttpError(502, result.errors.join('\n') || 'Regenerating the walkthrough failed.');
        // e.g. a renamed route param: the command matched the route and saved it under the route's new name,
        // leaving this walkthrough as it was. Say where it went instead of showing the old one as if refreshed.
        const written = (await ctx.store.listWalkthroughs()).filter((w) => w.scopeKind === kind && w.createdAt.getTime() > before);
        if (written.length > 0 && !written.some((w) => w.scopeRef === ref)) {
          throw new HttpError(409, `Regenerated, but it is now saved as "${written[0].scopeRef}"; reopen it from the list.`);
        }
        const detail = await walkthroughDetail(ctx.store, ctx.repoRoot, kind, ref);
        if (!detail) throw new HttpError(404, `No saved ${kind} walkthrough ${ref} after regenerating; reopen it from the list.`);
        return sendJson(res, 200, detail);
      }
      default:
        throw new HttpError(404, `No route ${req.method} ${url.pathname}.`);
    }
  };

  return server;
}

function scope(kind: unknown, ref: unknown): { kind: ScopeKind; ref: string } {
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw new HttpError(400, 'kind must be one of fn, file, endpoint, component, trace.');
  return { kind: kind as ScopeKind, ref: field(ref, 'ref') };
}

function field(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${name} is required.`);
  return value;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, `Request bodies are limited to ${MAX_BODY / 1024} KB.`);
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'The request body must be a JSON object.');
  }
}

function serveStatic(res: ServerResponse, webRoot: string | null, pathname: string): void {
  if (!webRoot) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(NOT_BUILT);
    return;
  }
  let relative: string;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    throw new HttpError(400, 'Malformed path.');
  }
  const root = resolve(webRoot);
  const file = resolve(root, relative);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'Not found.');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  createReadStream(file).pipe(res);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown): void {
  const status =
    err instanceof HttpError
      ? err.status
      : err instanceof PinNeededError
        ? 409
        : err instanceof TargetError
          ? 400
          : err instanceof LlmRequestError || err instanceof LlmOutputError || err instanceof NoVerifiedStepsError
            ? 502
            : 500;
  if (status === 500) console.error(err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, status, { error: status === 500 ? 'Internal error; see the walk serve output.' : (err as Error).message });
}
