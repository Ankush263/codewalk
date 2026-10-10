import { basename } from 'node:path';
import type { EndpointContext, EndpointSideEffect } from '../context/endpoint.js';

// The sequence diagram of one endpoint (CLAUDE.md §6.3 item 7), drawn from static facts only, never
// by the LLM: the chain in order, then each function's calls and side effects in line order. Errors
// with a known status become `alt` blocks answering the client.

const STORES: Partial<Record<EndpointSideEffect['kind'], string>> = { db_read: 'Postgres', db_write: 'Postgres', redis: 'Redis', queue: 'Events' };
const NO_CODE = new Set(['type', 'class']);

export function endpointDiagram(ctx: EndpointContext): string {
  const participants = ['  participant Client'];
  const messages: string[] = [];
  const ids = new Map<string, string>();
  const participant = (key: string, label: string): string => {
    let id = ids.get(key);
    if (!id) {
      id = `P${ids.size + 1}`;
      ids.set(key, id);
      participants.push(`  participant ${id} as ${text(label)}`);
    }
    return id;
  };

  const visit = (symbolId: number, from: string, path: Set<number>): void => {
    const events: { line: number; emit: () => void }[] = [
      ...ctx.sideEffects
        .filter((e) => e.symbol.id === symbolId)
        .map((e) => ({ line: e.line, emit: () => messages.push(`  ${from}->>${participant(storeKey(e), storeLabel(e))}: ${text(e.detail)}`) })),
      ...ctx.errorPaths
        .filter((p) => p.symbol.id === symbolId && p.status !== null)
        .map((p) => ({ line: p.line, emit: () => messages.push(`  alt ${text(p.error)}`, `    ${from}-->>Client: ${p.status}`, '  end') })),
      ...ctx.callees
        .filter((c) => c.caller.id === symbolId && c.callee && !NO_CODE.has(c.callee.kind))
        .map((c) => ({
          line: c.callLine,
          emit: () => {
            const callee = c.callee!;
            const to = participant(`file:${callee.file}`, basename(callee.file));
            messages.push(`  ${from}->>${to}: ${text(callee.name)}()`);
            if (!path.has(callee.id)) visit(callee.id, to, new Set([...path, callee.id]));
          },
        })),
    ];
    events.sort((a, b) => a.line - b.line);
    for (const e of events) e.emit();
  };

  const nodeIds = ctx.chain.map((n, i) => participant(`node:${i}`, n.label));
  ctx.chain.forEach((n, i) => {
    const from = i === 0 ? 'Client' : nodeIds[i - 1];
    messages.push(`  ${from}->>${nodeIds[i]}: ${i === 0 ? `${ctx.route.method} ${ctx.route.fullPath}` : 'next()'}`);
    if (n.symbol) visit(n.symbol.id, nodeIds[i], new Set([n.symbol.id]));
  });
  messages.push(`  ${nodeIds.at(-1)}-->>Client: response`);
  return ['sequenceDiagram', ...participants, ...messages].join('\n');
}

function storeKey(e: EndpointSideEffect): string {
  return e.kind === 'http_out' ? `http:${host(e.detail)}` : `store:${STORES[e.kind]}`;
}

function storeLabel(e: EndpointSideEffect): string {
  return e.kind === 'http_out' ? host(e.detail) : STORES[e.kind]!;
}

function host(detail: string): string {
  try {
    return new URL(detail.split(' ')[1] ?? '').host;
  } catch {
    return 'HTTP';
  }
}

/** Mermaid ends a statement at ";" and reads "#" as an entity; neither may appear in labels. */
function text(s: string): string {
  return s.replace(/[;#\n]/g, ' ').trim();
}
