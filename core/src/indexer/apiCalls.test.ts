import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';
import { toUrlPattern } from './apiCalls.js';

const FIXTURE = new URL('../../../fixture/', import.meta.url);
const WEB = ['web/apiClient.ts', 'web/types.ts', 'web/hooks/useEnrollMutation.ts', 'web/hooks/usePatient.ts'];
const WRAPPERS = [
  { name: 'api.get', method: 'GET' as const, urlArgIndex: 0 },
  { name: 'api.post', method: 'POST' as const, urlArgIndex: 0 },
];
const web = (apiClientWrappers = WRAPPERS) =>
  snippetProject(Object.fromEntries(WEB.map((p) => [p, readFileSync(new URL(p, FIXTURE), 'utf8')])), { apiClientWrappers });

describe('toUrlPattern', () => {
  it('turns substitutions into params and drops base URLs, hosts and queries', () => {
    expect(toUrlPattern(['/patients/', ''], ['id'])).toBe('/patients/:id');
    expect(toUrlPattern(['', '/patients'], ['API_URL'])).toBe('/patients');
    expect(toUrlPattern(['https://x.example.com/v1/items?page=1'])).toBe('/v1/items');
    expect(toUrlPattern(['/a//b/'])).toBe('/a/b');
  });
});

describe('API calls on the fixture', () => {
  it('finds wrapper calls, with literal and template URLs', () => {
    const p = web();
    expect(p.facts('web/hooks/useEnrollMutation.ts').apiCalls).toEqual([
      { symbol: { name: 'useEnrollMutation.mutate', startLine: 15 }, method: 'POST', urlPattern: '/api/patients/enroll', urlText: "'/api/patients/enroll'", line: 19 },
    ]);
    expect(p.facts('web/hooks/usePatient.ts').apiCalls).toEqual([
      { symbol: { name: 'usePatient', startLine: 5 }, method: 'GET', urlPattern: '/api/patients/:id', urlText: '`/api/patients/${id}`', line: 13 },
    ]);
  });

  it("skips the wrapper's own plumbing (fetch with a non-literal URL)", () => {
    expect(web().facts('web/apiClient.ts').apiCalls).toEqual([]);
  });

  it('finds nothing for a custom client that is not configured', () => {
    expect(web([]).facts('web/hooks/useEnrollMutation.ts').apiCalls).toEqual([]);
  });
});

describe('API calls on snippets', () => {
  it('handles fetch and axios forms', () => {
    const { facts } = snippetProject({
      'load.ts': `import axios from 'axios';
const ENROLL = '/api/patients/enroll';
const API = 'https://api.example.com';
export async function load(id: string, patient: { id: string }, verb: string) {
  await fetch(ENROLL, { method: 'post' });
  await fetch(\`\${API}/patients/\${patient.id}/visits?page=2\`);
  await fetch(\`https://other.example.com/v1/items/\${id}\`, { method: verb });
  await axios.get(\`/api/patients/\${id}\`);
  await axios({ url: '/api/reports', method: 'PUT' });
  await axios('/api/ping');
  const url = id ? '/a' : '/b';
  await fetch(url);
}
`,
    });
    expect(facts('load.ts').apiCalls.map((c) => `${c.line} ${c.method} ${c.urlPattern} ${c.urlText}`)).toEqual([
      '5 POST /api/patients/enroll ENROLL',
      '6 GET /patients/:id/visits `${API}/patients/${patient.id}/visits?page=2`',
      '7 UNKNOWN /v1/items/:id `https://other.example.com/v1/items/${id}`',
      '8 GET /api/patients/:id `/api/patients/${id}`',
      "9 PUT /api/reports '/api/reports'",
      "10 GET /api/ping '/api/ping'",
    ]);
  });
});

describe('API calls: client plumbing', () => {
  it('skips template URLs with no static path segment (a wrapper joining a base URL and a path)', () => {
    const { facts } = snippetProject({
      'client.ts': [
        "const BASE_URL = 'https://api.example.com';",
        'export async function request(method: string, path: string) {',
        '  await fetch(`${BASE_URL}${path}`, { method });',
        '  await fetch(`${BASE_URL}/${path}`);',
        "  await fetch(`${BASE_URL}/health`);",
        '}',
      ].join('\n'),
    });
    expect(facts('client.ts').apiCalls.map((c) => `${c.line} ${c.urlPattern}`)).toEqual(['5 /health']);
  });
});
