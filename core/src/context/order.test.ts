import { describe, expect, it } from 'vitest';
import type { SymbolKind } from '../store/types.js';
import { dependencyOrder, walkableSymbols } from './order.js';

let nextId = 1;
const sym = (name: string, startLine: number, endLine: number, kind: SymbolKind = 'function') => ({
  id: nextId++,
  name,
  kind,
  startLine,
  endLine,
});
const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe('walkableSymbols', () => {
  it('keeps top-level code symbols and class methods, skips types, classes and nested functions', () => {
    const symbols = [
      sym('Props', 1, 3, 'type'),
      sym('EnrollForm', 5, 20, 'component'),
      sym('EnrollForm.handleSubmit', 8, 12),
      sym('Repo', 22, 30, 'class'),
      sym('Repo.find', 23, 25, 'method'),
      sym('helper', 32, 34),
    ];
    expect(names(walkableSymbols(symbols))).toEqual(['EnrollForm', 'Repo.find', 'helper']);
  });
});

describe('dependencyOrder', () => {
  it('puts helpers before the functions that call them, even when declared below', () => {
    const main = sym('main', 1, 5);
    const helper = sym('helper', 7, 9);
    const { order, cycleBreaks } = dependencyOrder([main, helper], [main, helper], [{ callerId: main.id, calleeId: helper.id }]);
    expect(names(order)).toEqual(['helper', 'main']);
    expect(cycleBreaks).toEqual([]);
  });

  it('attributes calls made by nested functions to their walkable parent', () => {
    const form = sym('EnrollForm', 1, 20, 'component');
    const handler = sym('EnrollForm.handleSubmit', 5, 10);
    const submit = sym('submitHelper', 22, 25);
    const { order } = dependencyOrder([form, submit], [form, handler, submit], [{ callerId: handler.id, calleeId: submit.id }]);
    expect(names(order)).toEqual(['submitHelper', 'EnrollForm']);
  });

  it('keeps source order for unrelated functions', () => {
    const a = sym('a', 1, 2);
    const b = sym('b', 4, 5);
    expect(names(dependencyOrder([b, a], [a, b], []).order)).toEqual(['a', 'b']);
  });

  it('terminates on mutual recursion and notes where the cycle was broken', () => {
    const entry = sym('entry', 1, 3);
    const ping = sym('ping', 5, 7);
    const pong = sym('pong', 9, 11);
    const edges = [
      { callerId: entry.id, calleeId: ping.id },
      { callerId: ping.id, calleeId: pong.id },
      { callerId: pong.id, calleeId: ping.id },
    ];
    const { order, cycleBreaks } = dependencyOrder([entry, ping, pong], [entry, ping, pong], edges);
    expect(names(order)).toEqual(['ping', 'pong', 'entry']);
    expect(cycleBreaks).toEqual(['ping and pong call each other; walked in source order']);
  });

  it('names only the functions in the cycle, not other functions waiting downstream', () => {
    const a = sym('a', 1, 2);
    const b = sym('b', 4, 5);
    const c = sym('c', 7, 8);
    const d = sym('d', 10, 11);
    const edges = [
      { callerId: a.id, calleeId: b.id },
      { callerId: b.id, calleeId: a.id },
      { callerId: a.id, calleeId: c.id },
      { callerId: c.id, calleeId: d.id },
      { callerId: d.id, calleeId: c.id },
    ];
    const { order, cycleBreaks } = dependencyOrder([a, b, c, d], [a, b, c, d], edges);
    expect(names(order)).toEqual(['c', 'd', 'a', 'b']);
    expect(cycleBreaks).toEqual(['c and d call each other; walked in source order', 'a and b call each other; walked in source order']);
  });

  it('terminates on a three-function cycle', () => {
    const a = sym('a', 1, 2);
    const b = sym('b', 4, 5);
    const c = sym('c', 7, 8);
    const edges = [
      { callerId: a.id, calleeId: b.id },
      { callerId: b.id, calleeId: c.id },
      { callerId: c.id, calleeId: a.id },
    ];
    const { order, cycleBreaks } = dependencyOrder([a, b, c], [a, b, c], edges);
    expect(names(order)).toEqual(['a', 'b', 'c']);
    expect(cycleBreaks).toEqual(['a, b and c call each other; walked in source order']);
  });
});
