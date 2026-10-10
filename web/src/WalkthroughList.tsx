import type { WalkthroughListItem } from '@codewalk/core';
import { useEffect, useState } from 'react';
import type { Api } from './api';
import { hrefFor } from './route';

export function WalkthroughList({ api }: { api: Api }) {
  const [items, setItems] = useState<WalkthroughListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.list().then(setItems, (e: Error) => setError(e.message));
  }, [api]);

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!items) return <p>Loading…</p>;
  if (items.length === 0) {
    return (
      <p className="empty">
        No saved walkthroughs yet. Create one with <code>walk fn</code>, <code>walk file</code>, <code>walk endpoint</code>, <code>walk component</code> or{' '}
        <code>walk trace</code>.
      </p>
    );
  }
  return (
    <table className="list">
      <thead>
        <tr>
          <th>Status</th>
          <th>Kind</th>
          <th>Walkthrough</th>
          <th>Steps</th>
          <th>Saved</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={`${item.scopeKind}:${item.scopeRef}`}>
            <td>
              <span className={`badge ${item.fresh ? 'fresh' : 'stale'}`}>{item.fresh ? 'fresh' : 'stale'}</span>
            </td>
            <td>{item.scopeKind}</td>
            <td>
              <a href={hrefFor(item.scopeKind, item.scopeRef)}>{item.title}</a>
              <div className="ref">{item.scopeRef}</div>
              {item.staleSummary && <div className="detail">{item.staleSummary}</div>}
            </td>
            <td>{item.totalSteps}</td>
            <td>{item.savedAt.slice(0, 16).replace('T', ' ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
