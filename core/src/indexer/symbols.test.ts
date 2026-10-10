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

describe('functions a hook returns', () => {
  const files = {
    'hooks/useCounter.ts': `import { useState } from 'react';
export function useCounter() {
  const [n, setN] = useState(0);
  return {
    n,
    increment: () => setN(n + 1),
    reset() { setN(0); },
  };
}
export const useToggle = () => ({ toggle: () => {} });
`,
    'components/Counter.tsx': `import { useCounter } from '../hooks/useCounter';
export function Counter() {
  const { increment } = useCounter();
  return <button onClick={() => increment()}>+</button>;
}
`,
  };

  it('become <hook>.<name> symbols, for `return { ... }` and for an arrow returning an object', () => {
    const { facts } = snippetProject(files);
    expect(facts('hooks/useCounter.ts').symbols.map((s) => `${s.kind} ${s.name}:${s.startLine}`)).toEqual(
      expect.arrayContaining(['hook useCounter:2', 'method useCounter.increment:6', 'method useCounter.reset:7', 'hook useToggle:10', 'method useToggle.toggle:10']),
    );
  });

  it('resolve when a caller destructures them from the hook', () => {
    const { facts } = snippetProject(files);
    expect(facts('components/Counter.tsx').calls).toContainEqual(
      expect.objectContaining({ calleeText: 'increment', callee: { file: 'hooks/useCounter.ts', name: 'useCounter.increment', startLine: 6 }, resolved: true }),
    );
  });

  it('leaves shorthand properties alone (the declared function is already a symbol)', () => {
    const { facts } = snippetProject({ 'h.ts': 'export function useX() {\n  function go() {}\n  return { go };\n}\n' });
    expect(facts('h.ts').symbols.map((s) => s.name)).toEqual(['useX', 'useX.go']);
  });
});
