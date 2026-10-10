import { useEffect, useRef } from 'react';

const CONTEXT = 6;

/** The step's lines highlighted, with a few dimmed lines around them (CLAUDE.md §6.1 item 1). */
export function CodePanel({ files, file, start, end }: { files: Record<string, string[]>; file: string; start: number; end: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('.hl')?.scrollIntoView?.({ block: 'center' });
  }, [file, start, end]);

  const lines = files[file];
  const label = `${file}:${start}${end !== start ? `-${end}` : ''}`;
  if (!lines) {
    return (
      <div className="code">
        <div className="code-file">{label}</div>
        <p className="error">This file is no longer in the repository.</p>
      </div>
    );
  }
  const from = Math.max(1, start - CONTEXT);
  const to = Math.min(lines.length, end + CONTEXT);
  return (
    <div className="code" ref={ref}>
      <div className="code-file">{label}</div>
      <pre>
        {lines.slice(from - 1, to).map((text, i) => {
          const n = from + i;
          return (
            <div key={n} className={n >= start && n <= end ? 'line hl' : 'line dim'} data-line={n}>
              <span className="ln">{n}</span>
              {text || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
