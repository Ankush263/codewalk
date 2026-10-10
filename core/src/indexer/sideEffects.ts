import { Node, SyntaxKind, type CallExpression, type ClassDeclaration, type PropertyAccessExpression, type SourceFile } from 'ts-morph';
import type { SideEffectFact, SideEffectKind } from '../store/types.js';
import { calleeText, declarationOf, enclosingSymbol, packageOf, type RepoLookup } from './calls.js';
import { unwrap, type RegisteredSymbol } from './symbols.js';

// Side effects per symbol (CLAUDE.md §6.3 item 4), recognised by the module a receiver comes from:
// SQL through pg / knex / prisma, Redis commands, outbound HTTP, event and queue publishes, and
// errors thrown or passed to Express's `next`. Anything unrecognised is left untagged, not guessed.

interface Effect {
  kind: SideEffectKind;
  detail: string;
}

const REDIS_NOT_COMMANDS = new Set(['on', 'once', 'off', 'removeListener', 'connect', 'disconnect', 'quit', 'duplicate', 'pipeline', 'multi', 'exec', 'defineCommand']);
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const KNEX_READ = new Set(['select', 'first', 'pluck']);
const KNEX_WRITE: Record<string, string> = { insert: 'INSERT', update: 'UPDATE', del: 'DELETE', delete: 'DELETE' };
const PRISMA_OPS: Record<string, string> = {
  findUnique: 'SELECT', findUniqueOrThrow: 'SELECT', findFirst: 'SELECT', findFirstOrThrow: 'SELECT', findMany: 'SELECT',
  count: 'SELECT', aggregate: 'SELECT', groupBy: 'SELECT',
  create: 'INSERT', createMany: 'INSERT', update: 'UPDATE', updateMany: 'UPDATE', upsert: 'UPSERT', delete: 'DELETE', deleteMany: 'DELETE',
};
const SQL_TARGET = /\b(FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+("?[A-Za-z_][\w$]*"?(?:\."?[A-Za-z_][\w$]*"?)?)/gi;
const NOT_TABLES = new Set(['SET', 'SELECT', 'VALUES', 'LATERAL', 'ONLY', 'DEFAULT']);
const CTE_NAME = /(?:\bWITH(?:\s+RECURSIVE)?|,)\s*("?[A-Za-z_][\w$]*"?)\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/gi;
const TRANSACTION = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION|SET)\b/i;
const MAX_TEXT = 80;

export function collectSideEffects(sourceFile: SourceFile, byNode: Map<unknown, RegisteredSymbol>, repo: RepoLookup): SideEffectFact[] {
  const facts = new Map<string, SideEffectFact>();
  const add = (node: Node, effect: Effect) => {
    const owner = enclosingSymbol(node, byNode);
    if (!owner) return;
    const line = node.getStartLineNumber();
    facts.set(`${owner.name}:${owner.startLine}:${effect.kind}:${effect.detail}:${line}`, {
      symbol: { name: owner.name, startLine: owner.startLine },
      ...effect,
      line,
    });
  };

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    for (const effect of callEffects(call, repo)) add(call, effect);
  }
  for (const statement of sourceFile.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
    add(statement, { kind: 'throws', detail: thrownDetail(statement.getExpression(), 'rethrows') });
  }
  return [...facts.values()].sort((a, b) => a.line - b.line || a.detail.localeCompare(b.detail));
}

/** Tables a SQL string reads and writes. Transaction control (BEGIN, COMMIT, ...) has none. */
export function sqlEffects(sql: string): { kind: 'db_read' | 'db_write'; detail: string }[] {
  if (!sql.trim() || TRANSACTION.test(sql)) return [];
  const cteNames = new Set([...sql.matchAll(CTE_NAME)].map((m) => m[1].replaceAll('"', '').toLowerCase()));
  const out = new Map<string, { kind: 'db_read' | 'db_write'; detail: string }>();
  for (const m of sql.matchAll(SQL_TARGET)) {
    const at = m.index ?? 0;
    const keyword = m[1].toUpperCase().replace(/\s+/g, ' ');
    const table = m[2].replaceAll('"', '');
    if (NOT_TABLES.has(table.toUpperCase()) || cteNames.has(table.toLowerCase())) continue;
    // `FOR UPDATE`, `FOR NO KEY UPDATE`, `DO UPDATE`: row locks and upserts, not an UPDATE statement.
    if (keyword === 'UPDATE' && /\b(FOR|KEY|DO)\s*$/i.test(sql.slice(0, at))) continue;
    const isRead = keyword === 'FROM' || keyword === 'JOIN';
    // `FROM unnest(...)`: a function, not a table.
    if (isRead && /^\s*\(/.test(sql.slice(at + m[0].length))) continue;
    // `trim(both ' ' FROM name)`, `extract(epoch FROM t)`: FROM inside a function call's arguments.
    if (isRead && insideFunctionCall(sql, at)) continue;
    const effect = isRead ? { kind: 'db_read' as const, detail: `SELECT ${table}` } : { kind: 'db_write' as const, detail: `${keyword.split(' ')[0]} ${table}` };
    out.set(`${effect.kind} ${effect.detail}`, effect);
  }
  return [...out.values()];
}

/** True when `at` sits inside parentheses that open a function call, not a subquery: `f(... FROM x)`. */
function insideFunctionCall(sql: string, at: number): boolean {
  const open: number[] = [];
  for (let i = 0; i < at; i++) {
    if (sql[i] === '(') open.push(i);
    else if (sql[i] === ')') open.pop();
  }
  const paren = open.at(-1);
  if (paren === undefined) return false;
  if (/^\s*(SELECT|WITH|VALUES)\b/i.test(sql.slice(paren + 1))) return false;
  return /[A-Za-z_]\s*$/.test(sql.slice(0, paren));
}

function callEffects(call: CallExpression, repo: RepoLookup): Effect[] {
  const callee = unwrap(call.getExpression()) ?? call.getExpression();
  const args = call.getArguments();

  if (Node.isIdentifier(callee)) {
    const name = callee.getText();
    if (name === 'next' && args[0] && isParameter(callee)) return [{ kind: 'throws', detail: thrownDetail(args[0], 'forwards') }];
    if (name === 'fetch' && !declaredInRepo(callee, repo)) return [http(optionMethod(args[1]) ?? 'GET', args[0])];
    const pkg = packageOf(callee, repo);
    if (pkg === 'axios' || pkg === 'got') return [http(optionMethod(args[1] ?? args[0]) ?? 'GET', args[0])];
    return [];
  }
  if (!Node.isPropertyAccessExpression(callee)) return [];

  const method = callee.getName();
  switch (packageOf(callee.getExpression(), repo)) {
    case 'pg':
      return method === 'query' ? sqlEffects(literalText(args[0]) ?? '') : [];
    case 'ioredis':
    case 'redis':
      return REDIS_NOT_COMMANDS.has(method) ? [] : [{ kind: 'redis', detail: `${method.toUpperCase()} ${argText(args[0])}`.trim() }];
    case 'axios':
    case 'got':
      return HTTP_VERBS.has(method) ? [http(method.toUpperCase(), args[0])] : [];
    case 'http':
    case 'https':
      if (method === 'get') return [http('GET', args[0])];
      return method === 'request' ? [http(optionMethod(args[1] ?? args[0]) ?? 'GET', args[0])] : [];
    case 'events':
      return method === 'emit' ? [{ kind: 'queue', detail: `emit ${argText(args[0])} (in-process)` }] : [];
    case 'bullmq':
      return method === 'add' ? [{ kind: 'queue', detail: `add ${argText(args[0])} (bullmq)` }] : [];
    case 'amqplib':
      return method === 'publish' || method === 'sendToQueue' ? [{ kind: 'queue', detail: `${method} ${argText(args[0])} (amqp)` }] : [];
    case 'knex':
      return knexEffects(call, method);
    case '@prisma/client':
      return prismaEffects(callee, method);
    default:
      return [];
  }
}

function http(method: string, url: Node | undefined): Effect {
  return { kind: 'http_out', detail: `${method} ${urlText(url)}`.trim() };
}

function knexEffects(call: CallExpression, method: string): Effect[] {
  const verb = KNEX_READ.has(method) ? 'SELECT' : KNEX_WRITE[method];
  if (!verb) return [];
  return [{ kind: verb === 'SELECT' ? 'db_read' : 'db_write', detail: `${verb} ${knexTable(call) ?? '?'}` }];
}

/** The table of a knex chain: `knex('t')...`, `.from('t')`, `.into('t')` or `.table('t')`, anywhere in the chain. */
function knexTable(call: CallExpression): string | null {
  let top: Node = call;
  while (Node.isPropertyAccessExpression(top.getParent()) && Node.isCallExpression(top.getParent()!.getParent())) {
    top = top.getParent()!.getParent()!;
  }
  for (let n: Node = top; Node.isCallExpression(n); ) {
    const callee = n.getExpression();
    if (Node.isIdentifier(callee)) return literalText(n.getArguments()[0]);
    if (!Node.isPropertyAccessExpression(callee)) return null;
    if (['from', 'into', 'table'].includes(callee.getName())) return literalText(n.getArguments()[0]);
    n = callee.getExpression();
  }
  return null;
}

function prismaEffects(callee: PropertyAccessExpression, method: string): Effect[] {
  const verb = PRISMA_OPS[method];
  const model = callee.getExpression();
  if (!verb || !Node.isPropertyAccessExpression(model)) return [];
  return [{ kind: verb === 'SELECT' ? 'db_read' : 'db_write', detail: `${verb} ${model.getName()}` }];
}

/** "ConflictError (409)" for `new ConflictError()`, "rethrows err" / "forwards err" for a passed-on value. */
function thrownDetail(expr: Node | undefined, passOn: 'rethrows' | 'forwards'): string {
  const n = unwrap(expr);
  if (n && Node.isNewExpression(n)) {
    const name = calleeText(n.getExpression());
    const decl = declarationOf(n.getExpression());
    const status = decl && Node.isClassDeclaration(decl) ? statusOfClass(decl, 0) : null;
    return status === null ? name : `${name} (${status})`;
  }
  return `${passOn} ${n ? oneLine(n.getText()) : 'error'}`;
}

/** The literal HTTP status a class passes to its base constructor, following `extends` when it has no constructor. */
function statusOfClass(cls: ClassDeclaration, depth: number): number | null {
  if (depth > 5) return null;
  const ctor = cls.getConstructors()[0];
  if (!ctor) {
    const base = cls.getBaseClass();
    return base ? statusOfClass(base, depth + 1) : null;
  }
  const superCall = ctor.getDescendantsOfKind(SyntaxKind.CallExpression).find((c) => c.getExpression().getKind() === SyntaxKind.SuperKeyword);
  const first = superCall?.getArguments()[0];
  if (!first || !Node.isNumericLiteral(first)) return null;
  const status = Number(first.getLiteralValue());
  return status >= 100 && status <= 599 ? status : null;
}

/** Text of a string/template literal, or of a const initialised with one (followed through imports). */
export function literalText(node: Node | undefined, depth = 0): string | null {
  const n = unwrap(node);
  if (!n || depth > 3) return null;
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
  if (Node.isTemplateExpression(n)) return n.getText().slice(1, -1);
  if (Node.isIdentifier(n)) {
    const decl = declarationOf(n);
    if (decl && Node.isVariableDeclaration(decl)) return literalText(decl.getInitializer(), depth + 1);
  }
  return null;
}

function argText(node: Node | undefined): string {
  return literalText(node) ?? (node ? oneLine(node.getText()) : '');
}

/** URL of fetch/axios/http: the first argument, or its `url` property when it's an options object. */
function urlText(node: Node | undefined): string {
  const n = unwrap(node);
  if (n && Node.isObjectLiteralExpression(n)) return argText(propertyValue(n, 'url'));
  return argText(n);
}

/** The literal `method` of an options object, upper-cased. */
function optionMethod(node: Node | undefined): string | null {
  const n = unwrap(node);
  if (!n || !Node.isObjectLiteralExpression(n)) return null;
  return literalText(propertyValue(n, 'method'))?.toUpperCase() ?? null;
}

export function propertyValue(obj: Node, name: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  const prop = obj.getProperty(name);
  return prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
}

function isParameter(id: Node): boolean {
  const decl = declarationOf(id);
  return !!decl && Node.isParameterDeclaration(decl);
}

export function declaredInRepo(id: Node, repo: RepoLookup): boolean {
  const decl = declarationOf(id);
  return !!decl && repo.isRepoFile(decl.getSourceFile());
}

export function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TEXT ? `${collapsed.slice(0, MAX_TEXT - 1)}…` : collapsed;
}
