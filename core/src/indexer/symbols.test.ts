import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';

describe('inline route handlers', () => {
  const { facts } = snippetProject({
    'api/r.ts': [
      "import { Router } from 'express';",
      'export const r = Router();',
      "r.get('/items/:id', (req, res) => {",
      '  res.json(load(req.params.id));',
      '});',
      "r.route('/x').post(async function (req, res, next) { next(); });",
      'r.use((req, res, next) => next());',
      "new Map<string, number>().get('k');",
      '[1, 2].map((a, b) => a + b);',
      'function load(id: string) { return id; }',
    ].join('\n'),
  });

  it('registers inline handlers of route registrations as route_handler symbols', () => {
    const handlers = facts('api/r.ts').symbols.filter((s) => s.kind === 'route_handler');
    expect(handlers.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ['r.get /items/:id', 3, 5],
      ['r.post /x', 6, 6],
      ['r.use', 7, 7],
    ]);
  });

  it('attributes calls inside an inline handler to it', () => {
    const calls = facts('api/r.ts').calls.filter((c) => c.caller.name === 'r.get /items/:id');
    expect(calls.map((c) => c.calleeText)).toEqual(['load', 'res.json']);
    expect(calls[0].callee).toMatchObject({ file: 'api/r.ts', name: 'load' });
  });
});

describe('inline route handler edge cases', () => {
  const { facts } = snippetProject({
    'api/two.ts': [
      "import { Router } from 'express';",
      'export const r = Router();',
      'r.use((req, res, next) => next(), (req, res, next) => next());',
      "r.get('/a', (req, res) => res.end()); r.get('/a', (req, res) => res.end());",
    ].join('\n'),
    'db.ts': [
      "import sqlite3 from 'sqlite3';",
      "const db = new sqlite3.Database(':memory:');",
      'export function load(id: string) {',
      "  db.get('SELECT 1', [id], (err: unknown, row: unknown) => {",
      '    helper(row);',
      '  });',
      '}',
      'function helper(row: unknown) { return row; }',
    ].join('\n'),
  });

  it('gives two inline handlers on one line distinct names', () => {
    const handlers = facts('api/two.ts').symbols.filter((s) => s.kind === 'route_handler');
    expect(handlers.map((s) => s.name)).toEqual(['r.use', 'r.use#2', 'r.get /a', 'r.get /a#2']);
  });

  it('leaves callbacks of non-Express .get/.post calls to their enclosing function', () => {
    expect(facts('db.ts').symbols.filter((s) => s.kind === 'route_handler')).toEqual([]);
    expect(facts('db.ts').calls.find((c) => c.calleeText === 'helper')?.caller.name).toBe('load');
  });
});
