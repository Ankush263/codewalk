// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { EXPLAINED, fakeApi, renderDiagram } from './__fixtures__/api';
import { memoryStorage, type PredictionStore } from './storage';

beforeEach(() => {
  window.location.hash = '#/w/endpoint/POST%20%2Fapi%2Fpatients%2Fenroll';
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

const show = (api = fakeApi(), storage: PredictionStore = memoryStorage()) => ({ api, storage, ...render(<App api={api} storage={storage} renderDiagram={renderDiagram} />) });

describe('questions', () => {
  it('shows saved answers, marking stale ones', async () => {
    show();
    expect(await screen.findByText('Why json?')).toBeTruthy();
    expect(screen.getByText('stale', { selector: '.qa .badge' })).toBeTruthy();
  });

  it('asks about the current step and shows the verified answer with its warnings (Phase 6 acceptance)', async () => {
    const { api } = show();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'What does it parse?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('JSON', { selector: '.qa code' })).toBeTruthy();
    expect(api.ask).toHaveBeenCalledWith('endpoint', 'POST /api/patients/enroll', 's1', 'What does it parse?');
    expect(screen.getByText('api/app.ts:2')).toBeTruthy();
    expect(screen.getByText(/Removed reference x\.ts:1/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('shows why a question failed', async () => {
    show(fakeApi({ ask: async () => { throw new Error('The model returned invalid output 3 times.'); } }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'Why?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The model returned invalid output 3 times.');
  });

  it('keeps an unsent question when moving to another step and back', async () => {
    show();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'Draft question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    expect((screen.getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '← Prev' }));
    expect((screen.getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement).value).toBe('Draft question');
  });

  it('does not change steps while typing a question', async () => {
    show();
    const box = await screen.findByRole('textbox', { name: 'Question' });
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(screen.getByText('Step 1 of 2 · Request')).toBeTruthy();
  });
});

describe('predict first, then reveal', () => {
  it('hides the explanation until a prediction is written and revealed, and remembers it (Phase 6 acceptance)', async () => {
    const { storage } = show();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Predict first, then reveal/ }));
    expect(screen.queryByText('express.json', { selector: '.explanation code' })).toBeNull();
    const reveal = screen.getByRole('button', { name: 'Reveal' }) as HTMLButtonElement;
    expect(reveal.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Your prediction: what do these lines do?' }), { target: { value: 'It parses JSON.' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your prediction: what do these lines do?' }), { key: 'ArrowRight' });
    expect(screen.getByText('Step 1 of 2 · Request')).toBeTruthy();
    fireEvent.click(reveal);
    expect(screen.getByText('express.json', { selector: '.explanation code' })).toBeTruthy();
    expect(storage.get(`codewalk:predict:endpoint:POST /api/patients/enroll:s1:${EXPLAINED}`)).toBe('It parses JSON.');

    cleanup();
    show(fakeApi(), storage);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Predict first, then reveal/ }));
    expect(screen.getByText('express.json', { selector: '.explanation code' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Your prediction: what do these lines do?' }) as HTMLTextAreaElement).value).toBe('It parses JSON.');
  });

  it('starts afresh when the step is re-explained', async () => {
    show();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Predict first, then reveal/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your prediction: what do these lines do?' }), { target: { value: 'Old guess.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await screen.findByText('Step 1 of 2 · Request');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull());
    expect((screen.getByRole('textbox', { name: 'Your prediction: what do these lines do?' }) as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByText('express.json', { selector: '.explanation code' })).toBeNull();
  });
});
