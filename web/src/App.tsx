import { useEffect, useState } from 'react';
import type { Api } from './api';
import { parseHash } from './route';
import type { PredictionStore } from './storage';
import { WalkthroughList } from './WalkthroughList';
import { WalkthroughView } from './WalkthroughView';

export interface AppProps {
  api: Api;
  storage: PredictionStore;
  /** Mermaid by default; tests pass a stub. */
  renderDiagram?: (source: string) => Promise<string>;
}

export function App({ api, storage, renderDiagram }: AppProps) {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const route = parseHash(hash);
  return (
    <div className="app">
      <header className="topbar">
        <a href="#/">codewalk</a>
      </header>
      <main>
        {route.page === 'list' ? (
          <WalkthroughList api={api} />
        ) : (
          <WalkthroughView key={`${route.kind}:${route.ref}`} api={api} kind={route.kind} scopeRef={route.ref} storage={storage} renderDiagram={renderDiagram} />
        )}
      </main>
    </div>
  );
}
