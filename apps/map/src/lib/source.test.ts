import { describe, expect, it } from 'vitest';
import type { FlowEndpoint, FunctionCard, MapData } from '../types';
import { endpointSources, functionSources, sourceLines } from './source';

function card(id: string, calls: string[] = []): FunctionCard {
  return { id, name: id, package: 'core', module: `${id}.ts`, line: 3, exported: true, kind: 'other', summary: '', calls, calledBy: [], source: { file: `core:${id}.ts`, start: 1, end: 5 } };
}

const first = card('first', ['shared', 'unknown']);
const shared = card('shared', ['first']);
const handler = card('handler', ['shared']);
handler.source = { file: 'nextjs:app/token/route.ts', start: 3, end: 10 };
const data = { functions: { first, shared, handler } } as unknown as MapData;

describe('code targets', () => {
  it('follows nested calls once even with recursion and unknown callees', () => {
    expect(functionSources(data, first).map((target) => target.id)).toEqual(['first', 'shared']);
  });

  it('offers the endpoint and its steps before their transitive callees', () => {
    const endpoint = { source: 'hono:token/pipeline.ts', steps: [{ functionId: 'first', calls: ['shared'] }] } as FlowEndpoint;
    expect(endpointSources(data, endpoint).map((target) => target.id)).toEqual(['hono:token/pipeline.ts', 'first', 'shared']);
  });

  it('follows Route Handlers even when Next.js has no annotated step calls', () => {
    const endpoint = { source: handler.source!.file, steps: [] } as unknown as FlowEndpoint;
    expect(endpointSources(data, endpoint).map((target) => target.id)).toEqual([handler.source!.file, 'handler', 'shared', 'first']);
  });

  it('still follows callees for an older function card without source data', () => {
    const old = { ...first, source: undefined };
    expect(functionSources({ ...data, functions: { ...data.functions, first: old } }, old).map((target) => target.id)).toEqual(['shared']);
  });

  it('includes callees resolved by the function flow but absent from the catalog calls', () => {
    const withFlow = { ...first, calls: [], flow: { nodes: [{ id: 'call', kind: 'call' as const, label: 'shared', callee: 'shared', line: 4 }], edges: [] } };
    expect(functionSources({ ...data, functions: { ...data.functions, first: withFlow } }, withFlow).map((target) => target.id)).toEqual(['first', 'shared']);
  });
});

describe('sourceLines', () => {
  it('uses inclusive original line numbers and keeps empty lines and indentation', () => {
    expect(sourceLines('imports\r\n/** docs */\r\nfunction f() {\r\n\r\n  return "<tag>";\r\n}\r\n', 2, 6)).toEqual([
      { number: 2, text: '/** docs */' }, { number: 3, text: 'function f() {' }, { number: 4, text: '' }, { number: 5, text: '  return "<tag>";' }, { number: 6, text: '}' },
    ]);
  });
  it('returns a complete file when no range is specified', () => {
    expect(sourceLines('first\nsecond\n')).toEqual([{ number: 1, text: 'first' }, { number: 2, text: 'second' }]);
  });
});
