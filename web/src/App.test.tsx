// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { fakeApi, renderDiagram } from './__fixtures__/api';
import { hrefFor, parseHash } from './route';
import { memoryStorage } from './storage';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('routes', () => {
  it('round-trips a scope through the hash', () => {
    const href = hrefFor('trace', 'POST /api/x <- web/A.tsx#A');
    expect(href).toBe('#/w/trace/POST%20%2Fapi%2Fx%20%3C-%20web%2FA.tsx%23A');
    expect(parseHash(href)).toEqual({ page: 'walkthrough', kind: 'trace', ref: 'POST /api/x <- web/A.tsx#A' });
    expect(parseHash('#/w/nope/x')).toEqual({ page: 'list' });
    expect(parseHash('#/w/fn/%E0%A4%A')).toEqual({ page: 'list' });
  });
});

describe('walkthrough list', () => {
  const show = (api = fakeApi()) => render(<App api={api} storage={memoryStorage()} renderDiagram={renderDiagram} />);

  it('lists saved walkthroughs with their status and links to each', async () => {
    show();
    const link = await screen.findByRole('link', { name: 'How POST /api/patients/enroll works' });
    expect(link.getAttribute('href')).toBe('#/w/endpoint/POST%20%2Fapi%2Fpatients%2Fenroll');
    expect(screen.getByText('1/2 steps stale · changed: insertPatient')).toBeTruthy();
    expect(screen.getAllByText('stale')).toHaveLength(1);
    expect(screen.getAllByText('fresh')).toHaveLength(1);
  });

  it('explains how to create one when none are saved', async () => {
    show(fakeApi({ list: async () => [] }));
    expect(await screen.findByText(/No saved walkthroughs yet/)).toBeTruthy();
  });

  it('shows API errors', async () => {
    show(fakeApi({ list: async () => { throw new Error('Cannot connect to Postgres'); } }));
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot connect to Postgres');
  });
});
