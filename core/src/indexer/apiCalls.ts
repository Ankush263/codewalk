import { Node, SyntaxKind, VariableDeclarationKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { ApiClientWrapper } from '../config.js';
import { normalizePath } from '../routes/match.js';
import type { ApiCallFact } from '../store/types.js';
import { calleeText, declarationOf, enclosingSymbol, packageOf, type RepoLookup } from './calls.js';
import { declaredInRepo, literalText, oneLine, propertyValue } from './sideEffects.js';
import { unwrap, type RegisteredSymbol } from './symbols.js';

// API calls made by frontend code (CLAUDE.md §6.4 item 5, §10): configured client wrappers, fetch and
// axios, each with a literal URL. A call whose URL isn't a literal, e.g. `fetch(url)` inside the
// wrapper itself, is plumbing rather than an API call and is skipped. Phase 5 matches url_pattern to routes.

const AXIOS_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const MAX_CONST_DEPTH = 3;

export function collectApiCalls(sourceFile: SourceFile, byNode: Map<unknown, RegisteredSymbol>, repo: RepoLookup, wrappers: ApiClientWrapper[]): ApiCallFact[] {
  const facts: ApiCallFact[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const found = classify(call, repo, wrappers);
    const url = found && urlOf(found.url, 0);
    if (!found || !url) continue;
    const owner = enclosingSymbol(call, byNode);
    if (!owner) continue;
    const expr = call.getExpression();
    facts.push({
      symbol: { name: owner.name, startLine: owner.startLine },
      method: found.method,
      urlPattern: url.pattern,
      urlText: url.text,
      line: (Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr).getStartLineNumber(),
    });
  }
  return facts.sort((a, b) => a.line - b.line);
}

/**
 * "/patients/" + ${id} -> "/patients/:id". A leading substitution before the first "/" is a base URL
 * (`${API_URL}/patients`) and is dropped, as are a scheme + host, the query string and the hash.
 */
export function toUrlPattern(parts: string[], params: string[] = []): string {
  let out = parts[0];
  params.forEach((param, i) => {
    const next = parts[i + 1] ?? '';
    if (i === 0 && out === '' && next.startsWith('/')) out = next;
    else out += `:${param}${next}`;
  });
  out = out.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  return out.startsWith('/') ? normalizePath(out) : out;
}

function classify(call: CallExpression, repo: RepoLookup, wrappers: ApiClientWrapper[]): { method: string; url: Node | undefined } | null {
  const expr = unwrap(call.getExpression()) ?? call.getExpression();
  const args = call.getArguments();
  const text = calleeText(expr);

  const wrapper = wrappers.find((w) => w.name === text);
  if (wrapper) return { method: wrapper.method, url: args[wrapper.urlArgIndex] };

  if (Node.isIdentifier(expr) && text === 'fetch' && !declaredInRepo(expr, repo)) return { method: optionMethod(args[1]) ?? 'GET', url: args[0] };

  if (Node.isIdentifier(expr) && packageOf(expr, repo) === 'axios') {
    const config = unwrap(args[0]);
    if (config && Node.isObjectLiteralExpression(config)) return { method: optionMethod(config) ?? 'GET', url: propertyValue(config, 'url') };
    return { method: optionMethod(args[1]) ?? 'GET', url: args[0] };
  }
  if (Node.isPropertyAccessExpression(expr) && AXIOS_VERBS.has(expr.getName()) && packageOf(expr.getExpression(), repo) === 'axios') {
    return { method: expr.getName().toUpperCase(), url: args[0] };
  }
  return null;
}

/** A literal `method` option, upper-cased; UNKNOWN when present but not a literal; null when absent. */
function optionMethod(node: Node | undefined): string | null {
  const n = unwrap(node);
  if (!n || !Node.isObjectLiteralExpression(n) || !n.getProperty('method')) return null;
  return literalText(propertyValue(n, 'method'))?.toUpperCase() ?? 'UNKNOWN';
}

/** Pattern and source text of a literal URL (or a const initialised with one); null for anything else. */
function urlOf(node: Node | undefined, depth: number): { pattern: string; text: string } | null {
  const n = unwrap(node);
  if (!n || depth > MAX_CONST_DEPTH) return null;
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return { pattern: toUrlPattern([n.getLiteralText()]), text: oneLine(n.getText()) };
  if (Node.isTemplateExpression(n)) {
    const parts = [n.getHead().getLiteralText()];
    const params: string[] = [];
    for (const span of n.getTemplateSpans()) {
      params.push(paramName(span.getExpression()));
      parts.push(span.getLiteral().getLiteralText());
    }
    const pattern = toUrlPattern(parts, params);
    // `${BASE_URL}${path}` or `${BASE_URL}/${path}`: a client joining a base and a path it was given is
    // plumbing, not an API call; a real one keeps at least one fixed path segment.
    if (!pattern.split('/').some((segment) => segment !== '' && !segment.startsWith(':'))) return null;
    return { pattern, text: oneLine(n.getText()) };
  }
  if (Node.isIdentifier(n)) {
    const decl = declarationOf(n);
    const list = decl?.getParent();
    if (decl && Node.isVariableDeclaration(decl) && list && Node.isVariableDeclarationList(list) && list.getDeclarationKind() === VariableDeclarationKind.Const) {
      const inner = urlOf(decl.getInitializer(), depth + 1);
      return inner && { pattern: inner.pattern, text: n.getText() };
    }
  }
  return null;
}

/** `${id}` -> "id", `${patient.id}` -> "id", anything else -> "param". */
function paramName(expr: Node): string {
  const n = unwrap(expr) ?? expr;
  if (Node.isIdentifier(n)) return n.getText();
  if (Node.isPropertyAccessExpression(n)) return n.getName();
  return 'param';
}
