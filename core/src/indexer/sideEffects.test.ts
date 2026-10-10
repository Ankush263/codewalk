import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';
import { sqlEffects } from './sideEffects.js';

describe('sqlEffects', () => {
  it('reads tables from FROM/JOIN and writes from INSERT/UPDATE/DELETE', () => {
    expect(sqlEffects('SELECT * FROM unnest($1::int[]) AS x JOIN patients p ON true')).toEqual([{ kind: 'db_read', detail: 'SELECT patients' }]);
    expect(sqlEffects('UPDATE "public"."patients" SET a = 1 FROM consents WHERE x')).toEqual([
      { kind: 'db_write', detail: 'UPDATE public.patients' },
      { kind: 'db_read', detail: 'SELECT consents' },
    ]);
    expect(sqlEffects('INSERT INTO patients (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET id = $1')).toEqual([{ kind: 'db_write', detail: 'INSERT patients' }]);
  });

  it('ignores row locks, FROM inside function calls, and CTE names, but keeps subqueries', () => {
    expect(sqlEffects('SELECT * FROM jobs WHERE id = $1 FOR UPDATE SKIP LOCKED')).toEqual([{ kind: 'db_read', detail: 'SELECT jobs' }]);
    expect(sqlEffects('SELECT * FROM jobs j FOR NO KEY UPDATE OF j')).toEqual([{ kind: 'db_read', detail: 'SELECT jobs' }]);
    expect(sqlEffects("SELECT trim(both ' ' FROM name), extract(epoch FROM created_at) FROM patients")).toEqual([{ kind: 'db_read', detail: 'SELECT patients' }]);
    expect(sqlEffects('WITH moved AS (DELETE FROM queue RETURNING *) INSERT INTO archive SELECT * FROM moved')).toEqual([
      { kind: 'db_write', detail: 'DELETE queue' },
      { kind: 'db_write', detail: 'INSERT archive' },
    ]);
    expect(sqlEffects('SELECT * FROM a WHERE id IN (SELECT a_id FROM b) AND exists(SELECT 1 FROM c)')).toEqual([
      { kind: 'db_read', detail: 'SELECT a' },
      { kind: 'db_read', detail: 'SELECT b' },
      { kind: 'db_read', detail: 'SELECT c' },
    ]);
  });

  it('ignores transaction control and empty text', () => {
    expect(sqlEffects('BEGIN')).toEqual([]);
    expect(sqlEffects('  commit')).toEqual([]);
    expect(sqlEffects('')).toEqual([]);
  });
});

describe('collectSideEffects', () => {
  const { facts } = snippetProject({
    'db.ts': "import { Pool } from 'pg';\nimport Redis from 'ioredis';\nexport const pool = new Pool();\nexport const redis = new Redis();",
    'errors.ts': [
      'export class HttpError extends Error {',
      '  constructor(public status: number, message: string) { super(message); }',
      '}',
      'export class Conflict extends HttpError {',
      '  constructor(message: string) { super(409, message); }',
      '}',
      'export class DuplicatePhone extends Conflict {}',
    ].join('\n'),
    'svc.ts': [
      "import { pool, redis } from './db';",
      "import { Conflict, DuplicatePhone } from './errors';",
      "import { EventEmitter } from 'node:events';",
      'const bus = new EventEmitter();',
      'const FIND = `SELECT * FROM patients p JOIN consents c ON c.patient_id = p.id WHERE p.id = $1`;',
      'export async function enroll(id: string, next: (err?: unknown) => void) {',
      '  await pool.query(FIND, [id]);',
      '  const client = await pool.connect();',
      "  await client.query('BEGIN');",
      '  await client.query(`INSERT INTO patients (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET id = $1`, [id]);',
      "  await client.query('DELETE FROM sessions WHERE id = $1', [id]);",
      "  await redis.set(`patient:${id}`, '1', 'EX', 60);",
      "  redis.on('error', () => {});",
      "  bus.emit('patient.enrolled', id);",
      "  await fetch(`https://sms.example.com/v1/${id}`, { method: 'post' });",
      "  if (!id) throw new Conflict('dup');",
      "  if (id === 'x') throw new DuplicatePhone('again');",
      "  try { await fetch('https://a.example.com'); } catch (err) { throw err; }",
      "  next(new Conflict('via next'));",
      '  next();',
      '}',
    ].join('\n'),
    'other.ts': [
      "import knex from 'knex';",
      "import axios from 'axios';",
      "import { PrismaClient } from '@prisma/client';",
      "import https from 'node:https';",
      "import { Queue } from 'bullmq';",
      "const db = knex({ client: 'pg' });",
      'const prisma = new PrismaClient();',
      "const emails = new Queue('emails');",
      'export async function sync() {',
      "  await db('orders').where({ id: 1 }).first();",
      "  await db.insert({ id: 1 }).into('audit');",
      '  await prisma.patient.findMany();',
      '  await prisma.patient.upsert({});',
      "  await axios.post('https://api.example.com/hooks', {});",
      "  https.get('https://status.example.com');",
      "  await emails.add('welcome', {});",
      '}',
    ].join('\n'),
  });
  const summary = (path: string) => facts(path).sideEffects.map((e) => `${e.line} ${e.kind} ${e.detail}`);

  it('tags pg SQL, Redis, events, fetch and thrown or forwarded errors with their HTTP status', () => {
    expect(summary('svc.ts')).toEqual([
      '7 db_read SELECT consents',
      '7 db_read SELECT patients',
      '10 db_write INSERT patients',
      '11 db_write DELETE sessions',
      '12 redis SET patient:${id}',
      '14 queue emit patient.enrolled (in-process)',
      '15 http_out POST https://sms.example.com/v1/${id}',
      '16 throws Conflict (409)',
      '17 throws DuplicatePhone (409)',
      '18 http_out GET https://a.example.com',
      '18 throws rethrows err',
      '19 throws Conflict (409)',
    ]);
    expect(new Set(facts('svc.ts').sideEffects.map((e) => `${e.symbol.name}:${e.symbol.startLine}`))).toEqual(new Set(['enroll:6']));
  });

  it('tags knex, prisma, axios, node https and bullmq', () => {
    expect(summary('other.ts')).toEqual([
      '10 db_read SELECT orders',
      '11 db_write INSERT audit',
      '12 db_read SELECT patient',
      '13 db_write UPSERT patient',
      '14 http_out POST https://api.example.com/hooks',
      '15 http_out GET https://status.example.com',
      '16 queue add welcome (bullmq)',
    ]);
  });
});
