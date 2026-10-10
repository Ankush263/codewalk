import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, openStore } from '@codewalk/core';
import { runServe } from './serve.js';
import { parsePort } from './shared.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;

describe('walk serve', () => {
  let repo: string;
  let schema: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cw-servecmd-'));
    cpSync(FIXTURE, repo, { recursive: true });
    schema = `cw_test_srvc_${Math.random().toString(16).slice(2, 10)}`;
    const config = JSON.parse(readFileSync(join(repo, CONFIG_FILE), 'utf8'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ ...config, database: { url: DATABASE_URL, schema } }));
  });

  afterAll(async () => {
    const store = await openStore({ url: DATABASE_URL, schema });
    await store.dropSchema();
    await store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('indexes, serves the API on 127.0.0.1 and stops cleanly', async () => {
    const out: string[] = [];
    const err: string[] = [];
    let status = 0;
    const code = await runServe(repo, { port: 0 }, { log: (l) => out.push(l), error: (l) => err.push(l) }, {
      webRoot: null,
      onListening: async (url, server) => {
        status = (await fetch(`${url}/api/walkthroughs`)).status;
        server.closeAllConnections();
        server.close();
      },
    });
    expect(code).toBe(0);
    expect(status).toBe(200);
    expect(out.join('\n')).toMatch(/Serving walkthroughs of .* at http:\/\/127\.0\.0\.1:\d+/);
    expect(err.join('\n')).toContain('The web UI is not built');
  });

  it('exits 1 with advice when the port is taken', async () => {
    const busy: Server = createServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const { port } = busy.address() as AddressInfo;
    const err: string[] = [];
    try {
      expect(await runServe(repo, { port }, { log: () => {}, error: (l) => err.push(l) }, { webRoot: null })).toBe(1);
      expect(err.join('\n')).toContain(`Port ${port} is in use; pass --port <n>.`);
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });
});

describe('--port', () => {
  it('accepts 0-65535 and explains anything else', () => {
    expect(parsePort('0')).toBe(0);
    expect(parsePort('4321')).toBe(4321);
    for (const bad of ['70000', '-1', '4.5', 'abc']) expect(() => parsePort(bad)).toThrow('must be a port number from 0 to 65535');
  });
});

