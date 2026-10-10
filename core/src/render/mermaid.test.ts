import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildEndpointContext } from '../context/endpoint.js';
import { indexRepo } from '../indexer/index.js';
import { openStore, type Store } from '../store/index.js';
import { endpointDiagram } from './mermaid.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codewalk:codewalk@localhost:5432/codewalk';
const FIXTURE = new URL('../../../fixture', import.meta.url).pathname;

describe('endpointDiagram', () => {
  let store: Store;
  let diagram: string;

  beforeAll(async () => {
    store = await openStore({ url: DATABASE_URL, schema: `cw_test_mmd_${Math.random().toString(16).slice(2, 10)}` });
    await store.migrate();
    await indexRepo(FIXTURE, loadConfig(FIXTURE), store);
    const ctx = await buildEndpointContext(store, FIXTURE, { method: 'POST', path: '/api/patients/enroll' }, { depth: 3, maxContextTokens: 60000 });
    diagram = endpointDiagram(ctx);
  });

  afterAll(async () => {
    await store?.dropSchema();
    await store?.close();
  });

  it('draws the chain in order from the client', () => {
    const lines = diagram.split('\n');
    expect(lines[0]).toBe('sequenceDiagram');
    expect(lines).toContain('  participant Client');
    expect(lines).toContain('  participant P1 as express.json()');
    expect(lines).toContain('  participant P5 as enrollHandler');
    expect(lines).toContain('  Client->>P1: POST /api/patients/enroll');
    expect(lines).toContain('  P1->>P2: next()');
    expect(lines).toContain('  P4->>P5: next()');
    expect(lines.at(-1)).toBe('  P5-->>Client: response');
  });

  it('draws calls into modules, side effects on stores, and error statuses back to the client', () => {
    expect(diagram).toMatch(/ {2}P2->>P\d+: GET session:\$\{token\}/);
    expect(diagram).toMatch(/ {2}P5->>P\d+: enrollPatient\(\)/);
    expect(diagram).toMatch(/->>P\d+: INSERT consents/);
    expect(diagram).toMatch(/ {2}alt ConflictError\n {4}P\d+-->>Client: 409\n {2}end/);
    expect(diagram).toMatch(/participant P\d+ as Postgres/);
    expect(diagram).toMatch(/participant P\d+ as Redis/);
  });
});
