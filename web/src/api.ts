import type { QuestionView, ScopeKind, WalkthroughDetail, WalkthroughListItem } from '@codewalk/core';

// The `walk serve` API. POSTs carry X-Codewalk: 1, which the server requires (a cross-site page can't send it).

export interface Api {
  list(): Promise<WalkthroughListItem[]>;
  detail(kind: ScopeKind, ref: string): Promise<WalkthroughDetail>;
  ask(kind: ScopeKind, ref: string, stepId: string, question: string): Promise<QuestionView>;
  regenerate(kind: ScopeKind, ref: string): Promise<WalkthroughDetail>;
}

export function httpApi(base = ''): Api {
  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}${path}`, init);
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    return body as T;
  };
  const post = <T,>(path: string, data: unknown) =>
    request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codewalk': '1' }, body: JSON.stringify(data) });
  const scope = (kind: string, ref: string) => `kind=${encodeURIComponent(kind)}&ref=${encodeURIComponent(ref)}`;
  return {
    list: () => request('/api/walkthroughs'),
    detail: (kind, ref) => request(`/api/walkthrough?${scope(kind, ref)}`),
    ask: (kind, ref, stepId, question) => post('/api/questions', { kind, ref, stepId, question }),
    regenerate: (kind, ref) => post('/api/regenerate', { kind, ref }),
  };
}
