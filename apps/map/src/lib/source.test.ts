import { describe, expect, it } from 'vitest';
import type { FlowEndpoint, FunctionEntry, MapData } from '../types';
import { endpointSources, featureSourceLines, frameSources, sourceLines } from './source';

function card(id: string, calls: string[] = []): FunctionEntry {
  return { id, name: id, package: 'core', module: `${id}.ts`, line: 3, exported: true, kind: 'other', summary: '', calls, calledBy: [], sites: [], frame: `./data/functions/${id}.json`, source: { file: `core:${id}.ts`, start: 1, end: 5 } };
}

const first = card('first', ['shared', 'unknown']);
const shared = card('shared', ['first']);
const handler = card('handler', ['shared']);
handler.source = { file: 'nextjs:app/token/route.ts', start: 3, end: 10 };
const data = {
  functions: { first, shared, handler },
  bodies: { 'endpoint:token': { id: 'endpoint:token', endpoint: 'token', name: 'POST /token', package: 'hono', module: 'oidc-provider/endpoints/token/pipeline.ts', line: 40, summary: '', calls: ['first'], sites: [], frame: 'x', source: { file: 'hono:oidc-provider/endpoints/token/pipeline.ts', start: 40, end: 120 } } },
} as unknown as MapData;

describe('code targets', () => {
  it('follows nested calls once even with recursion and unknown callees', () => {
    expect(frameSources(data, 'first').map((target) => target.id)).toEqual(['first', 'shared']);
  });

  it('offers the file of the endpoint, the frame its trace starts from and what that calls', () => {
    const endpoint = { source: 'hono:oidc-provider/endpoints/token/pipeline.ts', root: 'endpoint:token', steps: [] } as unknown as FlowEndpoint;
    expect(endpointSources(data, endpoint).map((target) => target.id)).toEqual(['hono:oidc-provider/endpoints/token/pipeline.ts', 'endpoint:token', 'first', 'shared']);
    expect(endpointSources(data, endpoint)[1]).toMatchObject({ start: 40, end: 120, label: 'POST /token（エンドポイントの処理） · hono:oidc-provider/endpoints/token/pipeline.ts' });
  });

  it('starts the targets of a Route Handler from the handler', () => {
    const endpoint = { source: handler.source!.file, root: 'handler', steps: [] } as unknown as FlowEndpoint;
    expect(endpointSources(data, endpoint).map((target) => target.id)).toEqual([handler.source!.file, 'handler', 'shared', 'first']);
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

describe('featureSourceLines', () => {
  const code = 'shared\npar starts\npar ends\nshared again\nrefresh starts\nrefresh ends\n';
  const ranges = [{ feature: 'par', lines: [2, 3] as [number, number] }, { feature: 'refresh-token', lines: [5, 6] as [number, number] }];

  it('keeps shared lines outside each inclusive feature range and names the start of each range', () => {
    expect(featureSourceLines(code, ranges).map((line) => [line.number, line.features, line.starts])).toEqual([
      [1, [], []], [2, ['par'], ['par']], [3, ['par'], []], [4, [], []],
      [5, ['refresh-token'], ['refresh-token']], [6, ['refresh-token'], []],
    ]);
  });

  it('names a feature again when a selected function starts inside its range', () => {
    expect(featureSourceLines(code, ranges, 3, 5).map((line) => [line.number, line.features, line.starts])).toEqual([
      [3, ['par'], ['par']], [4, [], []], [5, ['refresh-token'], ['refresh-token']],
    ]);
  });

  it('shows shared source without claiming feature ownership when older data has no ranges', () => {
    expect(featureSourceLines('shared\n', undefined)).toEqual([{ number: 1, text: 'shared', features: [], starts: [] }]);
  });

  it('keeps overlapping feature evidence once and restarts labels after a shared section', () => {
    const overlapping = [...ranges, { feature: 'par', lines: [2, 2] as [number, number] }, { feature: 'par', lines: [5, 6] as [number, number] }];
    expect(featureSourceLines(code, overlapping).filter((line) => line.starts.length > 0).map((line) => [line.number, line.starts])).toEqual([
      [2, ['par']], [5, ['refresh-token', 'par']],
    ]);
  });
});
