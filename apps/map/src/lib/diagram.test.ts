import { describe, expect, it } from 'vitest';
import type { FlowEndpoint, FunctionCard, MapData } from '../types';
import { endpointDiagram, functionDiagram } from './diagram';

const endpoint: FlowEndpoint = {
  id: 'token', label: 'Token endpoint', path: '/token', methods: ['POST'], layer: 'api', group: { id: 'code', label: 'Code' }, rearrangeable: true,
  steps: [
    { id: 'parse-request', label: 'Parse the request', kind: 'parse', function: 'parseTokenRequest', calls: [], consumes: [], produces: [], removable: false },
    { id: 'issue-refresh-token', label: 'Mint the refresh token', kind: 'issue', function: 'issueRefreshToken', calls: [], consumes: [], produces: [], removable: false, feature: 'refreshToken' },
    { id: 'respond-error', label: 'Respond with the error', kind: 'respond', function: 'respondError', calls: [], consumes: [], produces: [], removable: false },
  ],
  edges: [
    { from: 'parse-request', to: 'issue-refresh-token', kind: 'flow' },
    { from: 'parse-request', to: 'respond-error', kind: 'error' },
  ],
};

const callee: FunctionCard = { id: 'core:a.ts#verify', name: 'verify', package: 'core', module: 'a.ts', line: 3, exported: true, kind: 'validate', summary: 'Verify the secret.', calls: [], calledBy: [] };
const subject: FunctionCard = {
  id: 'hono:s.ts#authenticate', name: 'authenticate', package: 'hono', module: 's.ts', line: 9, exported: true, kind: 'validate', summary: 'Authenticate the client.', calls: ['core:a.ts#verify'], calledBy: [],
  flow: {
    nodes: [
      { id: 'n0', kind: 'start', label: 'authenticate(c)', line: 9 },
      { id: 'n1', kind: 'call', label: 'verify', callee: 'core:a.ts#verify', line: 10 },
      { id: 'n2', kind: 'dynamic', label: 'store.get', member: 'ClientStore.get', note: 'Find the client.', line: 11 },
      { id: 'n3', kind: 'throw', label: 'throw TokenError(InvalidClient)', line: 12 },
      { id: 'n4', kind: 'end', label: 'end', line: 14 },
    ],
    edges: [
      { from: 'n0', to: 'n1', kind: 'flow' },
      { from: 'n1', to: 'n2', kind: 'flow' },
      { from: 'n2', to: 'n3', kind: 'branch', label: '!client' },
      { from: 'n2', to: 'n4', kind: 'branch', label: 'else' },
    ],
  },
};

const data: MapData = {
  version: 3, frameworks: ['hono'], commands: [], flows: {}, memberOfCall: {}, edgeSets: {},
  features: [{ id: 'refresh-token', tier: 'stable', summary: '', enabled: true, flag: '--disable refresh-token', endpoints: [], packages: [] }],
  functions: { [callee.id]: callee, [subject.id]: subject },
  members: { 'ClientStore.get': { type: 'ClientStore', member: 'get', summary: 'Return the client.', package: 'hono', module: 'store.ts', line: 5 } },
};

describe('endpointDiagram', () => {
  it('should draw a different error response for each failed step and retain step navigation', () => {
    const diagram = endpointDiagram({ ...endpoint, edges: [...endpoint.edges, { from: 'issue-refresh-token', to: 'respond-error', kind: 'error' }] }, data);
    const failures = diagram.edges.filter((edge) => edge.kind === 'error');
    expect(new Set(failures.map((edge) => edge.to)).size).toBe(2);
    expect(diagram.nodes.filter((node) => node.tone === 'error').map((node) => node.target)).toEqual([{ step: 'respond-error' }, { step: 'respond-error' }]);
    expect(diagram.nodes.filter((node) => node.tone === 'error').map((node) => node.subtitle)).toEqual(['Parse the request でのエラー · respondError()', 'Mint the refresh token（refresh-token） でのエラー · respondError()']);
  });

  it('should use implementation conditions and early returns instead of the metadata chain', () => {
    const controlFlow = { nodes: [
      { id: 's', kind: 'start' as const, label: 'POST()', line: 1 },
      { id: 'p', kind: 'call' as const, label: 'parse', step: 'parse-request', line: 2 },
      { id: 'c', kind: 'condition' as const, label: '!ok', line: 3 },
      { id: 'r', kind: 'return' as const, label: 'return badRequest', line: 3 },
      { id: 'i', kind: 'call' as const, label: 'issue', step: 'issue-refresh-token', line: 4 },
    ], edges: [
      { from: 's', to: 'p', kind: 'flow' as const },
      { from: 'p', to: 'c', kind: 'flow' as const },
      { from: 'c', to: 'r', kind: 'branch' as const, label: 'true' },
      { from: 'c', to: 'i', kind: 'branch' as const, label: 'false' },
    ] };
    const diagram = endpointDiagram({ ...endpoint, controlFlow }, data);
    expect(diagram.edges.some((edge) => edge.from === 'r')).toBe(false);
    expect(diagram.cases.map((flowCase) => flowCase.label)).toEqual(['!ok: 成立 → return badRequest', '!ok: 不成立 → Mint the refresh token']);
    expect(diagram.nodes.find((node) => node.id === 'i')?.target).toEqual({ step: 'issue-refresh-token' });
  });

  it('should make a box of each step, naming the feature that adds it, and mark the error step', () => {
    const diagram = endpointDiagram(endpoint, data);
    expect(diagram.nodes.map((node) => [node.title, node.subtitle, node.tone])).toEqual([
      ['Parse the request', 'parseTokenRequest()', 'normal'],
      ['Mint the refresh token（refresh-token）', 'issueRefreshToken()', 'normal'],
      ['Respond with the error', 'Parse the request でのエラー · respondError()', 'error'],
    ]);
    expect(diagram.cases.map((flowCase) => flowCase.label)).toEqual(['標準の流れ', 'エラー時']);
  });
});

describe('functionDiagram', () => {
  it('should say what each box does: the summary of the callee, the comment above the line, or the member it reaches', () => {
    const diagram = functionDiagram(subject, data);
    expect(diagram?.nodes.map((node) => [node.title, node.subtitle, node.tone])).toEqual([
      ['authenticate(c)', 'Authenticate the client.', 'start'],
      ['verify()', 'Verify the secret.', 'normal'],
      ['store.get()', 'Find the client.', 'normal'],
      ['throw TokenError(InvalidClient)', '例外を投げて終わる', 'error'],
      ['終了', '最後まで実行して終わる', 'end'],
    ]);
    expect(diagram?.nodes.map((node) => node.target)).toEqual([undefined, { fn: 'core:a.ts#verify' }, { member: 'ClientStore.get' }, undefined, undefined]);
  });

  it('should word the arrows in Japanese and name the cases by where they end', () => {
    const diagram = functionDiagram(subject, data);
    expect(diagram?.edges.map((edge) => edge.label)).toEqual([undefined, undefined, '!client', 'それ以外']);
    expect(diagram?.cases.map((flowCase) => flowCase.label)).toEqual(['!client → throw TokenError(InvalidClient)', 'それ以外 → 終了']);
  });

  it('should give no diagram for a function without a flow', () => {
    expect(functionDiagram(callee, data)).toBe(undefined);
  });
});
