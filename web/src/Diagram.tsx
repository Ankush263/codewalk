import { useEffect, useState } from 'react';

let counter = 0;

/** Renders Mermaid in strict mode (labels come from code, so no HTML or scripts are allowed through). */
export async function renderMermaid(source: string): Promise<string> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  const { svg } = await mermaid.render(`codewalk-diagram-${++counter}`, source);
  return svg;
}

export function Diagram({ source, render = renderMermaid }: { source: string; render?: (source: string) => Promise<string> }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    render(source).then(
      (out) => live && setSvg(out),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [source, render]);
  return (
    <details className="diagram" open>
      <summary>Sequence diagram</summary>
      {failed ? <pre>{source}</pre> : svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <p>Rendering…</p>}
    </details>
  );
}
