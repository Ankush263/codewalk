// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { fakeApi, renderDiagram } from './__fixtures__/api';
import { memoryStorage } from './storage';

const highlighted = (container: HTMLElement) => [...container.querySelectorAll('.line.hl')].map((l) => l.getAttribute('data-line'));

beforeEach(() => {
  window.location.hash = '#/w/endpoint/POST%20%2Fapi%2Fpatients%2Fenroll';
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('walkthrough reader', () => {
  const show = (api = fakeApi()) => ({ api, ...render(<App api={api} storage={memoryStorage()} renderDiagram={renderDiagram} />) });

  it('shows the first step: code highlighted on the left, explanation on the right (Phase 6 acceptance)', async () => {
    const { api, container } = show();
    expect(await screen.findByRole('heading', { name: 'How POST /api/patients/enroll works' })).toBeTruthy();
    expect(api.detail).toHaveBeenCalledWith('endpoint', 'POST /api/patients/enroll');
    expect(screen.getByText('api/app.ts:2-3')).toBeTruthy();
    expect(highlighted(container)).toEqual(['2', '3']);
    expect(container.querySelectorAll('.line.dim')).toHaveLength(2);
    expect(screen.getByText('express.json', { selector: '.explanation code' })).toBeTruthy();
    expect(screen.getByText('input s1')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'express express.json' }).getAttribute('href')).toBe('https://expressjs.com/en/api.html#express.json');
    expect(await screen.findByTestId('diagram')).toBeTruthy();
  });

  it('moves between steps with the buttons and the arrow keys, and marks stale steps', async () => {
    const { container } = show();
    await screen.findByText('Step 1 of 2 · Request');
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    expect(screen.getByText('Step 2 of 2 · Persistence')).toBeTruthy();
    expect(highlighted(container)).toEqual(['4']);
    expect(screen.getByText("This step's code changed since it was explained.")).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('Step 1 of 2 · Request')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(screen.getByText('Step 2 of 2 · Persistence')).toBeTruthy();
  });

  it('leaves arrow keys with modifiers to the browser (Alt+← is Back)', async () => {
    show();
    await screen.findByText('Step 1 of 2 · Request');
    for (const mod of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      fireEvent.keyDown(window, { key: 'ArrowRight', ...mod });
      expect(screen.getByText('Step 1 of 2 · Request')).toBeTruthy();
    }
  });

  it('shows a referenced line when its reference is clicked', async () => {
    const { container } = show();
    fireEvent.click(await screen.findByRole('button', { name: 'callee api/routes.ts:2' }));
    expect(screen.getByText('api/routes.ts:2')).toBeTruthy();
    expect(highlighted(container)).toEqual(['2']);
  });

  it('regenerates a stale walkthrough from the banner', async () => {
    const { api } = show();
    expect(await screen.findByText(/1\/2 steps stale · changed: insertPatient/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(api.regenerate).toHaveBeenCalledWith('endpoint', 'POST /api/patients/enroll');
    await screen.findByText('Step 1 of 2 · Request');
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
  });

  it('keeps the reader when regenerating fails, and shows why in the banner', async () => {
    show(fakeApi({ regenerate: async () => { throw new Error('Anthropic API rate limit reached; try again shortly.'); } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Anthropic API rate limit reached; try again shortly.');
    expect(screen.getByRole('heading', { name: 'How POST /api/patients/enroll works' })).toBeTruthy();
    expect(screen.getByText('Step 1 of 2 · Request')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Regenerate' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('reports a walkthrough that cannot be loaded', async () => {
    show(fakeApi({ detail: async () => { throw new Error('No saved endpoint walkthrough POST /x.'); } }));
    expect((await screen.findByRole('alert')).textContent).toBe('No saved endpoint walkthrough POST /x.');
  });
});
