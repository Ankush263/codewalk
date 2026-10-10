import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { indexRepo, type LlmProvider } from '@codewalk/core';
import { createServeServer } from '../serve/server.js';
import { connectStore, findWebRoot, loadRepo, printIndexResult, type IO } from './shared.js';

export interface ServeOptions {
  port: number;
}

export interface ServeDeps {
  provider?: LlmProvider;
  /** Overrides web/dist discovery; null serves the API only. */
  webRoot?: string | null;
  /** Called once listening (tests use it to make requests and close the server). */
  onListening?: (url: string, server: Server) => void;
}

/** `walk serve`: runs until Ctrl-C (or until the server is closed). Returns an exit code. */
export async function runServe(cwd: string, options: ServeOptions, io: IO, deps: ServeDeps = {}): Promise<number> {
  const repo = loadRepo(cwd, io);
  if (!repo) return 1;
  const store = await connectStore(repo.config, io);
  if (!store) return 1;
  try {
    await store.migrate();
    printIndexResult(await indexRepo(repo.repoRoot, repo.config, store), io);
    const webRoot = deps.webRoot !== undefined ? deps.webRoot : findWebRoot();
    if (!webRoot) io.error('! The web UI is not built: run `pnpm --filter @codewalk/web build` in the codewalk checkout. The API still works.');

    const server = createServeServer({ repoRoot: repo.repoRoot, config: repo.config, store, webRoot, provider: deps.provider });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, '127.0.0.1', () => resolve());
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        io.error(`✖ Port ${options.port} is in use; pass --port <n>.`);
        return 1;
      }
      throw err;
    }
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    io.log(`✔ Serving walkthroughs of ${repo.repoRoot} at ${url} (Ctrl-C to stop)`);
    const closed = new Promise<void>((resolve) => server.on('close', () => resolve()));
    const stop = () => {
      server.closeAllConnections();
      server.close();
    };
    process.once('SIGINT', stop);
    deps.onListening?.(url, server);
    await closed;
    process.off('SIGINT', stop);
    return 0;
  } finally {
    await store.close();
  }
}
