import { Node } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';
import { moduleOf, packageOf } from './calls.js';

describe('moduleOf', () => {
  it('normalises import specifiers to module names', () => {
    expect(moduleOf('node:events')).toBe('events');
    expect(moduleOf('@prisma/client/runtime')).toBe('@prisma/client');
    expect(moduleOf('axios/lib/core')).toBe('axios');
    expect(moduleOf('pg')).toBe('pg');
  });
});

describe('packageOf', () => {
  const { extractor, findCall } = snippetProject({
    'db/pool.ts': "import { Pool } from 'pg';\nexport const pool = new Pool();",
    'db/redis.ts': "import Redis from 'ioredis';\nexport const redis = new Redis();",
    'svc.ts': [
      "import { pool } from './db/pool';",
      "import { redis } from './db/redis';",
      "import { EventEmitter } from 'node:events';",
      "import type { PoolClient } from 'pg';",
      'const bus = new EventEmitter();',
      'export async function run(client: PoolClient) {',
      '  const c = await pool.connect();',
      "  await c.query('x');",
      "  await client.query('y');",
      "  await redis.get('k');",
      "  bus.emit('e');",
      "  fetch('u');",
      '  local();',
      '}',
      'function local() {}',
    ].join('\n'),
  });
  const receiverOf = (text: string) => {
    const callee = findCall('svc.ts', text).getExpression();
    return Node.isPropertyAccessExpression(callee) ? callee.getExpression() : callee;
  };

  it('traces a value through variables, awaits, imports and parameter types to its module', () => {
    expect(packageOf(receiverOf('c.query'), extractor.repo)).toBe('pg');
    expect(packageOf(receiverOf('client.query'), extractor.repo)).toBe('pg');
    expect(packageOf(receiverOf('redis.get'), extractor.repo)).toBe('ioredis');
    expect(packageOf(receiverOf('bus.emit'), extractor.repo)).toBe('events');
  });

  it('returns null for globals and repo functions', () => {
    expect(packageOf(receiverOf('fetch'), extractor.repo)).toBeNull();
    expect(packageOf(receiverOf('local'), extractor.repo)).toBeNull();
  });
});
