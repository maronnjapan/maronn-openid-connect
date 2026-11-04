import { describe, expect, it } from 'vitest';
import { CallGraph } from '../impact.js';
import { nodesOf } from '../tree.js';
import { compile } from './helpers.js';

describe('callable wiring and invocation', () => {
  it('should distinguish nested values and deferred registrations inside a typed implementation', () => {
    const fixture = compile({ 'a.ts': `
interface Contract { run?(): void; nested?: unknown }
declare function subscribe(callback: () => void): void;
export function work() {}
export function nested(): Contract { return { nested: { run() { work(); } } }; }
export function registered(): Contract { return { run() { subscribe(() => work()); } }; }
export function iterated(): Contract { return { run() { [1].forEach(() => work()); } }; }
` });
    try {
      expect(fixture.tree('nested').tree.implements ?? []).toEqual([]);
      expect(fixture.tree('registered').tree.implements?.[0]?.calls ?? []).not.toContain('lib:a.ts#work');
      expect(fixture.tree('iterated').tree.implements?.[0]?.calls).toContain('lib:a.ts#work');
    } finally { fixture.dispose(); }
  });

  it('should follow an indexed callable member through an alias, an object spread and a named implementation', () => {
    const fixture = compile({ 'a.ts': `
export interface First { load?: () => number }
export interface Second { load?: () => number }
export function source() { return 1; }
export function create(): First { const alias = source; return { load: alias }; }
export function forward(options: First): Second {
  return { ...(options.load === undefined ? {} : { load: options.load }) };
}
export function invoke(load: NonNullable<Second['load']>) { return load(); }
export function accepts(options: First = {}) { return options.load?.(); }
export function supply() { return accepts({ load: () => source() }); }
` });
    try {
      const target = [...nodesOf(fixture.tree('invoke').tree.nodes)].find((node) => node.kind === 'call')?.target;
      expect(target).toEqual({ kind: 'member', id: 'lib:a.ts#Second.load' });
      expect(fixture.tree('forward').tree.implements).toEqual([{ member: 'lib:a.ts#Second.load', lines: [7, 7], calls: ['lib:a.ts#First.load'] }]);
      expect(fixture.tree('create').tree.implements?.[0]?.calls).toEqual(['lib:a.ts#source']);
      expect(fixture.tree('supply').tree.implements?.[0]?.member).toBe('lib:a.ts#First.load');
      const graph = new CallGraph(new Map([...fixture.revision.trees].map(([id, built]) => [id, built.tree])), []);
      expect(graph.upstream(['lib:a.ts#source']).has('lib:a.ts#invoke')).toBe(true);
    } finally { fixture.dispose(); }
  });

  it('should keep arbitrary named and inline callbacks deferred while linking named array callbacks at their invocation', () => {
    const fixture = compile({ 'a.ts': `
declare function subscribe(callback: () => number): void;
export function work() { return 1; }
export function register() { subscribe(work); subscribe(() => work()); }
export function iterate(items: number[]) { return items.map(work); }
export function custom(api: { map(callback: () => number): void }) { api.map(work); }
` });
    try {
      const registered = fixture.tree('register').tree;
      expect([...nodesOf(registered.nodes)].some((node) => node.target?.kind === 'function' && node.target.id === 'lib:a.ts#work')).toBe(false);
      expect(registered.deferred).toContain('lib:a.ts#work');
      expect([...nodesOf(fixture.tree('iterate').tree.nodes)]).toContainEqual(expect.objectContaining({ kind: 'call', target: { kind: 'function', id: 'lib:a.ts#work' } }));
      expect([...nodesOf(fixture.tree('custom').tree.nodes)].some((node) => node.target?.kind === 'function' && node.target.id === 'lib:a.ts#work')).toBe(false);
      expect(fixture.revision.wiring.filter((entry) => entry.kind === 'callback' && entry.code === 'work')).toHaveLength(2);
    } finally { fixture.dispose(); }
  });

  it('should expose callable parameters, anonymous contracts and direct context function calls with reasons', () => {
    const fixture = compile({ 'a.ts': `
export function parameter(callback: () => number) { return callback(); }
export function anonymous(options: { load(): number }) { return options.load(); }
export function context(c: any) { const fn = c.get('callback'); fn(); c.get('other')(); }
` });
    try {
      for (const name of ['parameter', 'anonymous']) {
        const calls = [...nodesOf(fixture.tree(name).tree.nodes)].filter((node) => node.kind === 'call');
        expect(calls).toHaveLength(1);
        expect(calls[0]?.target).toMatchObject({ kind: 'untraceable', why: expect.any(String) });
      }
      const calls = [...nodesOf(fixture.tree('context').tree.nodes)].filter((node) => node.kind === 'call' && node.target?.kind === 'untraceable');
      expect(calls).toHaveLength(2);
      expect(calls.every((node) => node.target?.kind === 'untraceable' && node.target.why.includes('c.get('))).toBe(true);
    } finally { fixture.dispose(); }
  });

  it('should inventory startup modules without function declarations through the normal revision reader', () => {
    const fixture = compile({ 'a.ts': 'export function create() { return {}; }', 'startup.ts': "import { create } from './a'; export const current = create();" });
    try {
      expect(fixture.revision.wiring).toContainEqual(expect.objectContaining({ file: 'lib:startup.ts', kind: 'initialization', status: 'untraceable' }));
    } finally { fixture.dispose(); }
  });
});
