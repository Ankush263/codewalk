import { describe, expect, it } from 'vitest';
import { candidateRoutes, computeCrossEdges } from './crossEdges.js';

const routes = [
  { id: 1, method: 'POST', fullPath: '/api/patients/enroll' },
  { id: 2, method: 'GET', fullPath: '/api/patients/:id' },
  { id: 3, method: 'GET', fullPath: '/api/patients/me' },
  { id: 4, method: 'ALL', fullPath: '/api/health' },
  { id: 5, method: 'GET', fullPath: '/api/health' },
];
const best = (method: string, urlPattern: string) =>
  candidateRoutes({ method, urlPattern }, routes).map((c) => `${c.route.id} ${c.match} ${c.confidence}`);
const call = (id: number, method: string, urlPattern: string) => ({ id, method, urlPattern, caller: { file: 'web/a.ts', name: `f${id}` } });

describe('candidateRoutes', () => {
  it('matches literal and param segments exactly', () => {
    expect(best('POST', '/api/patients/enroll')).toEqual(['1 exact 1']);
    expect(best('GET', '/api/patients/:id')).toEqual(['2 exact 1']);
  });

  it('prefers a literal route over a param route for a literal URL', () => {
    expect(best('GET', '/api/patients/me')).toEqual(['3 exact 1', '2 param 0.9']);
  });

  it('prefers a specific method over ALL', () => {
    expect(best('GET', '/api/health')).toEqual(['5 exact 1', '4 exact 0.95']);
  });

  it('offers a route whose path ends with the URL as a loose suffix match', () => {
    expect(best('POST', '/patients/enroll')).toEqual(['1 suffix 0.6']);
  });

  it('caps a call with an unknown method (a route of any method may be the one)', () => {
    expect(best('UNKNOWN', '/api/patients/enroll')).toEqual(['2 method 0.5', '1 method 0.5']);
  });

  it('never matches a call param against a route literal, or a different method', () => {
    expect(best('DELETE', '/api/patients/:id')).toEqual([]);
    expect(best('POST', '/api/patients/:id')).toEqual([]);
  });
});

describe('computeCrossEdges', () => {
  it('resolves a call only to a confident, unique best route', () => {
    const { edges, warnings } = computeCrossEdges([call(10, 'GET', '/api/patients/me'), call(11, 'POST', '/patients/enroll')], routes, []);
    expect(edges).toEqual([
      { apiCallId: 10, routeId: 3, match: 'exact', confidence: 1, pinned: false, resolved: true },
      { apiCallId: 10, routeId: 2, match: 'param', confidence: 0.9, pinned: false, resolved: false },
      { apiCallId: 11, routeId: 1, match: 'suffix', confidence: 0.6, pinned: false, resolved: false },
    ]);
    expect(warnings).toEqual([]);
  });

  it('leaves equally good candidates unresolved', () => {
    const twice = [...routes, { id: 6, method: 'POST', fullPath: '/api/patients/enroll' }];
    const { edges } = computeCrossEdges([call(10, 'POST', '/api/patients/enroll')], twice, []);
    expect(edges.map((e) => `${e.routeId} ${e.resolved}`)).toEqual(['1 false', '6 false']);
  });

  it('a pin overrides matching; stale pins warn and are ignored', () => {
    const pins = [
      { caller: 'web/a.ts#f11', method: 'POST', url: '/patients/enroll', route: 'POST /api/patients/enroll' },
      { caller: 'web/a.ts#f12', method: 'GET', url: '/x', route: 'GET /api/gone' },
      { caller: 'web/gone.ts#g', method: 'GET', url: '/y', route: 'GET /api/health' },
    ];
    const { edges, warnings } = computeCrossEdges([call(11, 'POST', '/patients/enroll'), call(12, 'GET', '/x')], routes, pins);
    expect(edges).toEqual([
      { apiCallId: 11, routeId: 1, match: 'pinned', confidence: 1, pinned: true, resolved: true },
    ]);
    expect(warnings).toEqual([
      'Pinned edge web/a.ts#f12 GET /x → GET /api/gone: no such route; the pin is ignored.',
      'Pinned edge web/gone.ts#g GET /y → GET /api/health: no such API call in the index; remove it from pinnedEdges.',
    ]);
  });
});

describe('candidateRoutes: generic routes and loose suffixes (review fixes)', () => {
  const generic = [
    { id: 7, method: 'GET', fullPath: '*' },
    { id: 8, method: 'GET', fullPath: '/:code' },
    { id: 9, method: 'GET', fullPath: '/api/health' },
    { id: 10, method: 'GET', fullPath: '/api/users/:id' },
  ];
  const loose = (method: string, urlPattern: string) =>
    candidateRoutes({ method, urlPattern }, generic).map((c) => `${c.route.id} ${c.match} ${c.confidence}`);

  it('never lets a catch-all or all-param route resolve a call whose literals it does not share', () => {
    expect(loose('GET', '/health')).toEqual(['7 wildcard 0.6', '8 wildcard 0.6', '9 suffix 0.6']);
    const { edges } = computeCrossEdges([call(20, 'GET', '/health')], generic, []);
    expect(edges.every((e) => !e.resolved)).toBe(true);
  });

  it('a suffix match needs at least one literal segment in common', () => {
    expect(loose('GET', '/patients')).toEqual(['7 wildcard 0.6', '8 wildcard 0.6']);
    expect(loose('GET', '/users/42')).toEqual(['10 suffix 0.6']);
  });
});
