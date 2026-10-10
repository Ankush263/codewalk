import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { HandlerBindingFact, ReactFact, RenderNodeFact, StateVarFact, SymbolKey } from '../store/types.js';
import { calleeText, declarationOf, enclosingSymbol, packageOf, repoFunctionOf, type RepoLookup } from './calls.js';
import { oneLine } from './sideEffects.js';
import { functionInitializer, unwrap, type FileSymbols, type RegisteredSymbol } from './symbols.js';

// React facts per component and hook (CLAUDE.md §6.4): props, state, hooks, context, effects, render
// tree and event handlers. Only code the symbol owns counts: bodies of nested symbols (e.g.
// EnrollForm.handleSubmit) have facts of their own. Inline arrows that aren't symbols (effect
// callbacks, `.map` callbacks) belong to the enclosing component or hook.

const HOOK_NAME = /^use[A-Z0-9]/;
const REACT = new Set(['react', 'preact']);
const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useMemo', 'useCallback']);
const EVENT = /^on[A-Z]/;

export function collectReactFacts(sourceFile: SourceFile, registry: FileSymbols, repo: RepoLookup): ReactFact[] {
  return registry.symbols.filter((s) => (s.kind === 'component' || s.kind === 'hook') && s.bodyOwner).map((s) => factsOf(s, registry, repo));
}

function factsOf(sym: RegisteredSymbol, registry: FileSymbols, repo: RepoLookup): ReactFact {
  const fn = sym.bodyOwner!;
  const owns = (n: Node): boolean => {
    if (enclosingSymbol(n, registry.byNode) === sym) return true;
    // `const onSave = useCallback(() => ..., [])`: the declaration is a symbol of its own, but the hook call belongs to `sym`.
    const parent = n.getParent();
    return Node.isCallExpression(n) && !!parent && Node.isVariableDeclaration(parent) && enclosingSymbol(parent, registry.byNode) === sym;
  };
  const params = (fn as unknown as { getParameters(): Node[] }).getParameters();
  const first = params[0];
  const typeNode = first && Node.isParameterDeclaration(first) ? first.getTypeNode() : undefined;

  const facts: ReactFact = {
    symbol: { name: sym.name, startLine: sym.startLine },
    propsType: typeNode ? oneLine(typeNode.getText()) : null,
    props: (sym.kind === 'component' ? params.slice(0, 1) : params).flatMap((p) => (Node.isParameterDeclaration(p) ? propertyNames(p.getNameNode()) : [])),
    state: [],
    hooks: [],
    context: [],
    effects: [],
    render: [],
    handlers: [],
  };

  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = calleeText(call.getExpression());
    const short = name.slice(name.lastIndexOf('.') + 1);
    if (HOOK_NAME.test(short) && owns(call)) collectHook(call, name, short, facts, repo);
  }

  const elements = [...fn.getDescendantsOfKind(SyntaxKind.JsxElement), ...fn.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)].sort(
    (a, b) => a.getStart() - b.getStart(),
  );
  for (const el of elements) if (owns(el)) collectElement(el, fn, facts, repo);
  return facts;
}

function collectHook(call: CallExpression, name: string, short: string, facts: ReactFact, repo: RepoLookup): void {
  const expr = call.getExpression();
  const line = (Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr).getStartLineNumber();
  const pkg = packageOf(expr, repo);
  const decl = pkg ? undefined : declarationOf(expr);
  const callee = decl && repo.isRepoFile(decl.getSourceFile()) ? repo.keyFor(decl) : null;
  const holder = call.getParent();
  const bindingNode = holder && Node.isVariableDeclaration(holder) ? holder.getNameNode() : undefined;
  const bindings = bindingNode ? localNames(bindingNode) : [];
  const args = call.getArguments();
  facts.hooks.push({ name, line, callee, package: pkg, bindings, callbacks: callbacksOf(args) });

  if (pkg === null || !REACT.has(pkg)) return;
  if (short === 'useState' || short === 'useReducer') {
    const [firstEl, secondEl] = bindingNode && Node.isArrayBindingPattern(bindingNode) ? bindingNode.getElements() : [];
    const nameOf = (e: Node | undefined) => (e && Node.isBindingElement(e) ? e.getName() : null);
    const init = short === 'useState' ? args[0] : args[1];
    const state: StateVarFact = {
      name: nameOf(firstEl) ?? (bindingNode && Node.isIdentifier(bindingNode) ? bindingNode.getText() : '(unnamed)'),
      setter: nameOf(secondEl),
      hook: short,
      initial: init ? oneLine(init.getText()) : null,
      line,
    };
    facts.state.push(state);
  } else if (short === 'useContext') {
    facts.context.push({ context: args[0] ? oneLine(args[0].getText()) : '', line, bindings });
  } else if (EFFECT_HOOKS.has(short)) {
    const depsArg = unwrap(args[1]);
    facts.effects.push({
      hook: short,
      line: call.getStartLineNumber(),
      endLine: call.getEndLineNumber(),
      deps: !depsArg ? null : Node.isArrayLiteralExpression(depsArg) ? depsArg.getElements().map((e) => oneLine(e.getText())) : [oneLine(depsArg.getText())],
      binding: bindingNode && Node.isIdentifier(bindingNode) ? bindingNode.getText() : null,
    });
  }
}

function collectElement(el: Node, fn: Node, facts: ReactFact, repo: RepoLookup): void {
  const opening = Node.isJsxElement(el) ? el.getOpeningElement() : el;
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return;
  const tag = opening.getTagNameNode();
  const element = tag.getText();
  const kind = /^[A-Z]/.test(element) || element.includes('.') ? 'component' : 'element';
  const attributes = opening.getAttributes();
  const props = attributes.map(attributeOf);

  for (const attr of attributes) {
    if (!Node.isJsxAttribute(attr)) continue;
    const event = attr.getNameNode().getText();
    const init = attr.getInitializer();
    const value = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
    if (!EVENT.test(event) || !value) continue;
    const handler: HandlerBindingFact = {
      element,
      event,
      handler: oneLine(value.getText()),
      line: attr.getStartLineNumber(),
      endLine: attr.getEndLineNumber(),
      target: targetOf(unwrap(value) ?? value, repo),
    };
    facts.handlers.push(handler);
  }

  const condition = conditionOf(el, fn);
  if (kind === 'element' && condition === null && !props.some((p) => EVENT.test(p.name))) return;

  let component: SymbolKey | null = null;
  let pkg: string | null = null;
  if (kind === 'component') {
    pkg = packageOf(tag, repo);
    const decl = pkg ? undefined : declarationOf(tag);
    component = decl && repo.isRepoFile(decl.getSourceFile()) ? repo.keyFor(decl) : null;
  }
  let depth = 0;
  for (let a = el.getParent(); a && a.compilerNode !== fn.compilerNode; a = a.getParent()) if (Node.isJsxElement(a)) depth++;
  const node: RenderNodeFact = { element, kind, line: opening.getStartLineNumber(), depth, component, package: pkg, props, condition };
  facts.render.push(node);
}

/** `a && <X/>` -> "a"; `c ? <X/> : ...` -> "c" / "!(c)"; `if (c) return <X/>` -> "c" / "!(c)"; joined outermost first. */
function conditionOf(el: Node, fn: Node): string | null {
  const parts: string[] = [];
  let child: Node = el;
  for (let a = el.getParent(); a && a.compilerNode !== fn.compilerNode; child = a, a = a.getParent()) {
    const is = (n: Node | undefined) => n !== undefined && n.compilerNode === child.compilerNode;
    if (Node.isBinaryExpression(a) && a.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken && is(a.getRight())) {
      parts.push(oneLine(a.getLeft().getText()));
    } else if (Node.isConditionalExpression(a)) {
      if (is(a.getWhenTrue())) parts.push(oneLine(a.getCondition().getText()));
      else if (is(a.getWhenFalse())) parts.push(`!(${oneLine(a.getCondition().getText())})`);
    } else if (Node.isIfStatement(a)) {
      if (is(a.getThenStatement())) parts.push(oneLine(a.getExpression().getText()));
      else if (is(a.getElseStatement())) parts.push(`!(${oneLine(a.getExpression().getText())})`);
    }
  }
  return parts.length ? parts.reverse().join(' && ') : null;
}

function attributeOf(attr: Node): { name: string; value: string } {
  if (Node.isJsxSpreadAttribute(attr)) return { name: '...', value: oneLine(attr.getExpression().getText()) };
  if (!Node.isJsxAttribute(attr)) return { name: '?', value: oneLine(attr.getText()) };
  const init = attr.getInitializer();
  const value = !init ? 'true' : Node.isJsxExpression(init) ? oneLine(init.getExpression()?.getText() ?? '') : oneLine(init.getText());
  return { name: attr.getNameNode().getText(), value };
}

/** The repo function a handler expression names (`handleSubmit`, an imported `logout`, `mutate` from a hook); null for inline functions. */
function targetOf(expr: Node, repo: RepoLookup): SymbolKey | null {
  if (!Node.isIdentifier(expr) && !Node.isPropertyAccessExpression(expr)) return null;
  return repoFunctionOf(expr, repo);
}

/** Inline functions passed in object-literal arguments, e.g. `useX({ onSuccess: (p) => ... })`. */
function callbacksOf(args: Node[]): { name: string; line: number }[] {
  return args.flatMap((arg) => {
    const obj = unwrap(arg);
    if (!obj || !Node.isObjectLiteralExpression(obj)) return [];
    return obj.getProperties().flatMap((p) => {
      if (Node.isMethodDeclaration(p) || (Node.isPropertyAssignment(p) && functionInitializer(p.getInitializer()))) {
        return [{ name: p.getName(), line: p.getStartLineNumber() }];
      }
      return [];
    });
  });
}

/** Prop names a parameter receives: `{ a, b: c, ...rest }` -> ["a", "b", "...rest"]; `props` -> ["props"]. */
function propertyNames(name: Node): string[] {
  if (Node.isIdentifier(name)) return [name.getText()];
  if (Node.isObjectBindingPattern(name)) {
    return name.getElements().map((e) => (e.getDotDotDotToken() ? `...${e.getName()}` : (e.getPropertyNameNode()?.getText() ?? e.getName())));
  }
  return localNames(name);
}

/** Local names a binding introduces: `{ a: b }` -> ["b"], `[x, , y]` -> ["x", "y"]. */
function localNames(name: Node): string[] {
  if (Node.isIdentifier(name)) return [name.getText()];
  if (Node.isObjectBindingPattern(name) || Node.isArrayBindingPattern(name)) {
    return (name.getElements() as Node[]).flatMap((e) => (Node.isBindingElement(e) ? [e.getName()] : []));
  }
  return [];
}
