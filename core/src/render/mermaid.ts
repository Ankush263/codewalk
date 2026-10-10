import { basename } from 'node:path';
import type { EndpointContext, EndpointSideEffect } from '../context/endpoint.js';
import type { TraceContext } from '../context/trace.js';

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

/**
 * The full-stack diagram (CLAUDE.md §6.5): the user (or an effect) → the component → the frontend files
 * on the trigger path → the endpoint diagram, whose Client is the frontend function making the call, so
 * responses and error statuses come back to it → what that function does after the response.
 */
export function traceDiagram(ctx: TraceContext): string {
  const comp = ctx.component.component.symbol;
  const fileOf = new Map<string, string>();
  for (const u of [ctx.component.component, ...ctx.component.hooks]) for (const s of [u.symbol, ...u.inner]) fileOf.set(s.name, s.file);
  for (const c of ctx.component.callees) if (c.callee) fileOf.set(c.callee.name, c.callee.file);

  const participants = ['  actor User', `  participant C as ${text(comp.name)}`];
  const ids = new Map<string, string>([[comp.file, 'C']]);
  const idFor = (file: string): string => {
    let id = ids.get(file);
    if (!id) {
      id = `F${ids.size}`;
      ids.set(file, id);
      participants.push(`  participant ${id} as ${text(basename(file))}`);
    }
    return id;
  };

  const messages: string[] = [];
  const trigger = ctx.link.call.triggers[0];
  if (!trigger) messages.push('  Note over C: no trigger found');
  else if (trigger.kind === 'effect') messages.push(`  Note over C: ${text(trigger.label)}`);
  else messages.push(`  User->>C: ${text(trigger.label)}`);
  let from = 'C';
  for (const name of trigger?.path ?? [ctx.link.call.symbol.name]) {
    const to = idFor(fileOf.get(name) ?? ctx.link.call.symbol.file);
    messages.push(`  ${from}->>${to}: ${text(name.slice(name.lastIndexOf('.') + 1))}()`);
    from = to;
  }

  const server = endpointDiagram(ctx.endpoint).split('\n').slice(1);
  for (const line of server) {
    if (line === '  participant Client') continue;
    if (line.trimStart().startsWith('participant ')) participants.push(line);
    else messages.push(line.replace(/^(\s+)Client(?=-?->>)/, `$1${from}`).replace(/(-?->>)Client:/, `$1${from}:`));
  }

  const after = [...new Set(ctx.afterResponse.map((a) => `${a.calleeText.slice(a.calleeText.lastIndexOf('.') + 1)}()`))];
  if (after.length > 0) messages.push(`  Note over ${from}: then ${text(after.join(', '))}`);
  return ['sequenceDiagram', ...participants, ...messages].join('\n');
}
