import { describe, expect, it } from 'vitest';
import { TargetError } from '../context/target.js';
import { closestRoutes, matchRoutes, parseEndpointTarget, pathMatches } from './match.js';

const routes = [
  { method: 'POST', fullPath: '/api/patients/enroll' },
  { method: 'GET', fullPath: '/api/patients/:id' },
  { method: 'GET', fullPath: '/api/patients/search' },
  { method: 'ALL', fullPath: '/api/health' },
];
const show = (rs: typeof routes) => rs.map((r) => `${r.method} ${r.fullPath}`);

describe('parseEndpointTarget', () => {
  it('upper-cases the method and normalises the path', () => {
    expect(parseEndpointTarget('post /api/patients/enroll/')).toEqual({ method: 'POST', path: '/api/patients/enroll' });
    expect(parseEndpointTarget('GET /api/patients/42?full=1')).toEqual({ method: 'GET', path: '/api/patients/42' });
    expect(parseEndpointTarget('  get   //api//x ')).toEqual({ method: 'GET', path: '/api/x' });
  });

  it('rejects unknown methods and paths without a leading slash', () => {
    expect(() => parseEndpointTarget('FETCH /x')).toThrow(TargetError);
    expect(() => parseEndpointTarget('/x')).toThrow(TargetError);
    expect(() => parseEndpointTarget('GET api/x')).toThrow(TargetError);
  });
});

describe('matchRoutes', () => {
  it('matches a concrete path to a :param pattern', () => {
    expect(pathMatches('/api/patients/:id', '/api/patients/42')).toBe(true);
    expect(pathMatches('/api/patients/:id', '/api/patients')).toBe(false);
    expect(show(matchRoutes(routes, { method: 'GET', path: '/api/patients/42' }))).toEqual(['GET /api/patients/:id']);
  });

  it('prefers an exact path over a pattern, and ALL matches any method', () => {
    expect(show(matchRoutes(routes, { method: 'GET', path: '/api/patients/search' }))).toEqual(['GET /api/patients/search']);
    expect(show(matchRoutes(routes, { method: 'DELETE', path: '/api/health' }))).toEqual(['ALL /api/health']);
    expect(matchRoutes(routes, { method: 'PUT', path: '/api/patients/enroll' })).toEqual([]);
  });

  it('suggests the closest routes for a typo', () => {
    expect(show(closestRoutes(routes, { method: 'POST', path: '/api/patient/enroll' }, 2))[0]).toBe('POST /api/patients/enroll');
  });
});
