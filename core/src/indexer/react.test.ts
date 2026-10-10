import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { snippetProject } from './__fixtures__/snippets.js';

const FIXTURE = new URL('../../../fixture/', import.meta.url);
const WEB = [
  'web/apiClient.ts',
  'web/types.ts',
  'web/components/EnrollForm.tsx',
  'web/components/FormField.tsx',
  'web/components/PatientSummary.tsx',
  'web/hooks/useEnrollMutation.ts',
  'web/hooks/usePatient.ts',
];
const web = () => snippetProject(Object.fromEntries(WEB.map((p) => [p, readFileSync(new URL(p, FIXTURE), 'utf8')])));
const only = <T>(xs: T[]): T => {
  expect(xs).toHaveLength(1);
  return xs[0];
};

describe('React facts on the fixture', () => {
  it('EnrollForm: props, state, hooks with callee and callbacks', () => {
    const f = only(web().facts('web/components/EnrollForm.tsx').reactFacts);
    expect(f.symbol).toEqual({ name: 'EnrollForm', startLine: 18 });
    expect(f.propsType).toBe('EnrollFormProps');
    expect(f.props).toEqual(['onEnrolled']);
    expect(f.state).toEqual([{ name: 'values', setter: 'setValues', hook: 'useState', initial: 'EMPTY_FORM', line: 19 }]);
    expect(f.hooks).toEqual([
      { name: 'useState', line: 19, callee: null, package: 'react', bindings: ['values', 'setValues'], callbacks: [] },
      {
        name: 'useEnrollMutation',
        line: 20,
        callee: { file: 'web/hooks/useEnrollMutation.ts', name: 'useEnrollMutation', startLine: 11 },
        package: null,
        bindings: ['mutate', 'status', 'error'],
        callbacks: [{ name: 'onSuccess', line: 21 }],
      },
    ]);
    expect(f.context).toEqual([]);
    expect(f.effects).toEqual([]);
  });

  it('EnrollForm: render tree keeps components and elements with handlers or conditions', () => {
    const f = only(web().facts('web/components/EnrollForm.tsx').reactFacts);
    expect(f.render.map((r) => `${r.element}:${r.line}:${r.depth}:${r.condition ?? '-'}`)).toEqual([
      'form:39:0:-',
      'FormField:40:1:-',
      'FormField:41:1:-',
      'FormField:42:1:-',
      'FormField:43:1:-',
      'input:45:2:-',
      'p:48:1:error',
    ]);
    expect(f.render[1]).toEqual({
      element: 'FormField',
      kind: 'component',
      line: 40,
      depth: 1,
      component: { file: 'web/components/FormField.tsx', name: 'FormField', startLine: 11 },
      package: null,
      props: [
        { name: 'label', value: '"First name"' },
        { name: 'name', value: '"firstName"' },
        { name: 'value', value: 'values.firstName' },
        { name: 'onChange', value: 'handleChange' },
      ],
      condition: null,
    });
  });

  it('EnrollForm: handlers resolve to the functions they name', () => {
    const f = only(web().facts('web/components/EnrollForm.tsx').reactFacts);
    expect(f.handlers.map((h) => `${h.event} <${h.element}> ${h.handler} :${h.line} -> ${h.target ? `${h.target.name}@${h.target.startLine}` : '-'}`)).toEqual([
      'onSubmit <form> handleSubmit :39 -> EnrollForm.handleSubmit@32',
      'onChange <FormField> handleChange :40 -> EnrollForm.handleChange@27',
      'onChange <FormField> handleChange :41 -> EnrollForm.handleChange@27',
      'onChange <FormField> handleChange :42 -> EnrollForm.handleChange@27',
      'onChange <FormField> handleChange :43 -> EnrollForm.handleChange@27',
      'onChange <input> handleChange :45 -> EnrollForm.handleChange@27',
    ]);
  });

  it('hooks: parameters, state and effects with deps', () => {
    const p = web();
    const mutation = only(p.facts('web/hooks/useEnrollMutation.ts').reactFacts);
    expect(mutation).toMatchObject({
      symbol: { name: 'useEnrollMutation', startLine: 11 },
      propsType: 'Options',
      props: ['onSuccess'],
      state: [
        { name: 'status', setter: 'setStatus', hook: 'useState', initial: "'idle'", line: 12 },
        { name: 'error', setter: 'setError', hook: 'useState', initial: 'null', line: 13 },
      ],
      render: [],
      handlers: [],
    });
    const patient = only(p.facts('web/hooks/usePatient.ts').reactFacts);
    expect(patient.props).toEqual(['id']);
    expect(patient.propsType).toBe('string');
    expect(patient.hooks.map((h) => `${h.name}:${h.line}`)).toEqual(['useState:6', 'useState:7', 'useEffect:9']);
    expect(patient.effects).toEqual([{ hook: 'useEffect', line: 9, endLine: 23, deps: ['id'], binding: null }]);
  });

  it('PatientSummary: early returns become conditions', () => {
    const f = only(web().facts('web/components/PatientSummary.tsx').reactFacts);
    expect(f.props).toEqual(['patientId']);
    expect(f.propsType).toBe('{ patientId: string }');
    expect(f.hooks[0]).toMatchObject({ name: 'usePatient', callee: { file: 'web/hooks/usePatient.ts', name: 'usePatient', startLine: 5 }, bindings: ['patient', 'loading'] });
    expect(f.render.map((r) => `${r.element}:${r.line}:${r.condition}`)).toEqual(['p:6:loading', 'p:7:!patient']);
  });

  it('non-React files have no React facts', () => {
    expect(web().facts('web/apiClient.ts').reactFacts).toEqual([]);
  });
});

describe('React facts on snippets', () => {
  const panel = `import { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import { Link } from 'react-router-dom';
export const ThemeContext = createContext('light');
function reducer(n: number, a: { type: 'inc' }) { return a.type === 'inc' ? n + 1 : n; }
export function Panel({ items, onPick: pick, ...rest }: { items: string[]; onPick(i: string): void }) {
  const theme = useContext(ThemeContext);
  const [count, dispatch] = useReducer(reducer, 0);
  const total = useMemo(() => items.length, [items]);
  const choose = useCallback((i: string) => pick(i), [pick]);
  return (
    <div {...rest}>
      {count > 0 ? <Link to="/done">Done</Link> : <span onClick={() => dispatch({ type: 'inc' })}>{total}</span>}
      <button onClick={() => choose(items[0])}>{theme}</button>
    </div>
  );
}
`;

  it('collects context, reducers, derived values, package components, ternaries and inline handlers', () => {
    const f = snippetProject({ 'Panel.tsx': panel }).facts('Panel.tsx').reactFacts.find((x) => x.symbol.name === 'Panel')!;
    expect(f.props).toEqual(['items', 'onPick', '...rest']);
    expect(f.context).toEqual([{ context: 'ThemeContext', line: 6, bindings: ['theme'] }]);
    expect(f.state).toEqual([{ name: 'count', setter: 'dispatch', hook: 'useReducer', initial: '0', line: 7 }]);
    expect(f.effects).toEqual([
      { hook: 'useMemo', line: 8, endLine: 8, deps: ['items'], binding: 'total' },
      { hook: 'useCallback', line: 9, endLine: 9, deps: ['pick'], binding: 'choose' },
    ]);
    expect(f.hooks.map((h) => `${h.name}:${h.package}`)).toEqual(['useContext:react', 'useReducer:react', 'useMemo:react', 'useCallback:react']);
    expect(f.render.map((r) => `${r.kind} ${r.element}:${r.line}:${r.depth}:${r.condition ?? '-'}:${r.package ?? '-'}`)).toEqual([
      'component Link:12:1:count > 0:react-router-dom',
      'element span:12:1:!(count > 0):-',
      'element button:13:1:-:-',
    ]);
    expect(f.handlers.map((h) => `${h.event} <${h.element}> ${h.handler} ${h.target ? 'resolved' : 'inline'}`)).toEqual([
      "onClick <span> () => dispatch({ type: 'inc' }) inline",
      'onClick <button> () => choose(items[0]) inline',
    ]);
  });
});
