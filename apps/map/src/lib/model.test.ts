import { describe, expect, it } from 'vitest';
import type { FlowEndpoint, FunctionEntry, MapData, MapFeature, OpFlow } from '../types';
import { callersOf, commandLine, defaultEnabled, enabledMarkers, endpointsInModule, endpointsRootedAt, endpointsUsing, featureKey, featuresToShow, generatedWhen, search, usesOf, visibleEndpoints } from './model';

const features: MapFeature[] = [
  { id: 'pkce', tier: 'stable', summary: 'PKCE', enabled: true, flag: '--disable pkce', endpoints: [], packages: [] },
  { id: 'refresh-token', tier: 'stable', summary: 'refresh', enabled: true, flag: '--disable refresh-token', endpoints: [], packages: [] },
  { id: 'par', tier: 'experimental', summary: 'PAR', enabled: true, flag: '--enable par', endpoints: ['par'], packages: [] },
];

const token: FlowEndpoint = {
  id: 'token', label: 'Token endpoint', path: '/token', methods: ['POST'], layer: 'api', group: { id: 'code', label: 'Code' }, rearrangeable: true, root: 'endpoint:token',
  steps: [
    { id: 'parse-request', label: 'Parse', kind: 'parse', function: 'parseTokenRequest', functionId: 'hono:a.ts#parseTokenRequest', calls: ['core:b.ts#isForm'], consumes: [], produces: ['params'], removable: false },
    { id: 'validate-refresh-token-grant', label: 'Refresh', kind: 'validate', function: 'validateRefresh', functionId: 'hono:r.ts#validateRefresh', calls: ['core:b.ts#isForm'], consumes: ['params'], produces: [], removable: false, feature: 'refreshToken' },
    { id: 'respond', label: 'Respond', kind: 'respond', function: 'respondToken', functionId: 'hono:c.ts#respondToken', calls: [], consumes: [], produces: [], removable: false },
    { id: 'respond-error', label: 'Error', kind: 'respond', function: 'respondError', calls: [], consumes: [], produces: [], removable: false },
  ],
  edges: [
    { from: 'parse-request', to: 'validate-refresh-token-grant', kind: 'flow' },
    { from: 'validate-refresh-token-grant', to: 'respond', kind: 'flow' },
    { from: 'parse-request', to: 'respond', kind: 'branch', label: 'answered' },
    { from: 'parse-request', to: 'respond-error', kind: 'error' },
  ],
};
const par: FlowEndpoint = { ...token, id: 'par', path: '/par', feature: 'par', steps: [], edges: [] };
const flow: OpFlow = { version: 2, features: {}, scopes: [], db: null, endpoints: [token, par], edges: [] };

function card(id: string, name: string, calls: string[], calledBy: string[], summary = `${name} does it.`): FunctionEntry {
  const [root, rest] = id.split(':') as [string, string];
  return { id, name, package: root, module: rest.split('#')[0] as string, line: 1, exported: true, kind: 'other', summary, calls, calledBy, sites: [], frame: '' };
}

const data: MapData = {
  version: 4, frameworks: ['hono', 'nextjs'], commands: [], features, flows: { hono: flow, nextjs: flow }, members: {}, bodies: {}, sources: {},
  functions: {
    'core:b.ts#isForm': card('core:b.ts#isForm', 'isForm', [], ['hono:a.ts#parseTokenRequest', 'hono:r.ts#validateRefresh']),
    'core:d.ts#deep': card('core:d.ts#deep', 'deep', [], ['core:b.ts#isForm']),
    'hono:a.ts#parseTokenRequest': card('hono:a.ts#parseTokenRequest', 'parseTokenRequest', ['core:b.ts#isForm'], []),
    'hono:r.ts#validateRefresh': card('hono:r.ts#validateRefresh', 'validateRefresh', ['core:b.ts#isForm'], []),
    'hono:x.ts#split': card('hono:x.ts#split', 'split', [], []),
    'core:y.ts#split': card('core:y.ts#split', 'split', [], []),
  },
};
data.functions['core:b.ts#isForm']!.calls = ['core:d.ts#deep'];

describe('featureKey', () => {
  it('should turn a feature id into its OidcFeatureConfig key', () => {
    expect(featureKey('refresh-token')).toBe('refreshToken');
    expect(featureKey('pkce')).toBe('pkce');
  });
});

describe('generatedWhen', () => {
  it('should say when a step is generated: always, by default, or with the flag of its feature', () => {
    expect(generatedWhen(features, undefined)).toBe('常に生成される');
    expect(generatedWhen(features, 'refreshToken')).toBe('既定で生成される（--disable refresh-token で外せる）');
    expect(generatedWhen(features, 'par')).toBe('--enable par で生成される');
  });
});

describe('visibleEndpoints', () => {
  it('should leave out the endpoints, steps and arrows of features that are off', () => {
    const visible = visibleEndpoints(flow, features, new Set(['pkce']));
    expect(visible.map((endpoint) => endpoint.id)).toEqual(['token']);
    expect(visible[0]!.steps.map((step) => step.id)).toEqual(['parse-request', 'respond', 'respond-error']);
    expect(visible[0]!.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(['parse-request>respond', 'parse-request>respond-error']);
  });

  it('should show everything when every feature is on', () => {
    expect(visibleEndpoints(flow, features, new Set(['pkce', 'refresh-token', 'par'])).map((endpoint) => endpoint.id)).toEqual(['token', 'par']);
  });

  it('should narrow the trees by the ids of the features that are on, as the markers of the code name them', () => {
    expect([...enabledMarkers(features, new Set(['refresh-token', 'gone']))]).toEqual(['refresh-token']);
  });
});

describe('endpointsRootedAt', () => {
  it('should find the endpoints whose trace starts from a frame', () => {
    expect(endpointsRootedAt(flow, 'endpoint:token').map((endpoint) => endpoint.id)).toEqual(['token', 'par']);
    expect(endpointsRootedAt(flow, 'core:b.ts#isForm')).toEqual([]);
  });
});

describe('commandLine', () => {
  it('should write --enable for a non-stable feature that is on and --disable for a stable one that is off', () => {
    expect(commandLine('hono', features, new Set(['pkce', 'par']))).toBe('maronn-oidc generate hono \\\n  --enable par \\\n  --disable refresh-token');
  });

  it('should be the bare command for the default set', () => {
    expect(commandLine('express', features, defaultEnabled(features))).toBe('maronn-oidc generate express');
  });
});

describe('usesOf', () => {
  it('should find the step whose function a card is, and the steps that call it', () => {
    expect(usesOf(flow, 'hono:a.ts#parseTokenRequest').map((use) => [use.step.id, use.as])).toEqual([['parse-request', 'function']]);
    expect(usesOf(flow, 'core:b.ts#isForm').map((use) => use.step.id)).toEqual(['parse-request', 'validate-refresh-token-grant']);
  });
});

describe('endpointsUsing', () => {
  it('should find the steps that reach a function through its callers, with the functions between them', () => {
    const uses = endpointsUsing(data, flow, 'core:d.ts#deep');
    expect(uses.map((use) => [use.endpoint.id, use.step.id, use.as, use.via.map((between) => between.name)])).toEqual([
      ['token', 'parse-request', 'indirect', ['isForm']],
      ['token', 'validate-refresh-token-grant', 'indirect', ['isForm']],
    ]);
  });

  it('should tell the step of the function itself from a step that calls it', () => {
    expect(endpointsUsing(data, flow, 'hono:a.ts#parseTokenRequest').map((use) => [use.step.id, use.as])).toEqual([['parse-request', 'function']]);
    expect(endpointsUsing(data, flow, 'core:b.ts#isForm').map((use) => [use.step.id, use.as])).toEqual([
      ['parse-request', 'call'],
      ['validate-refresh-token-grant', 'call'],
    ]);
  });
});

describe('callersOf', () => {
  it('should list the functions that call a function, by name', () => {
    expect(callersOf(data, data.functions['core:b.ts#isForm']!).map((caller) => caller.name)).toEqual(['parseTokenRequest', 'validateRefresh']);
  });
});

describe('search', () => {
  it('should find steps by id, label or function and functions by name, and nothing under two characters', () => {
    expect(search(data, [token], 'parse').map((hit) => hit.text)).toEqual(['Parse', 'parseTokenRequest()']);
    expect(search(data, [token], 'p')).toEqual([]);
  });
});

describe('endpointsInModule', () => {
  it('should find the endpoint whose own file holds a function (a Route Handler of Next.js)', () => {
    const nextFlow: OpFlow = { ...flow, endpoints: [{ ...token, module: 'token/route.ts' }] };
    expect(endpointsInModule(nextFlow, card('nextjs:app/token/route.ts#token', 'token', [], [])).map((endpoint) => endpoint.id)).toEqual(['token']);
    expect(endpointsInModule(nextFlow, card('core:b.ts#isForm', 'isForm', [], []))).toEqual([]);
  });
});

describe('featuresToShow', () => {
  it('should name the features an endpoint and a step need that are off, and nothing when they are shown', () => {
    expect(featuresToShow(flow, features, new Set(['pkce']), 'par', null)).toEqual(['par']);
    expect(featuresToShow(flow, features, new Set(['pkce']), 'token', 'validate-refresh-token-grant')).toEqual(['refresh-token']);
    expect(featuresToShow(flow, features, new Set(['pkce', 'refresh-token', 'par']), 'token', 'validate-refresh-token-grant')).toEqual([]);
    expect(featuresToShow(flow, features, new Set(['pkce']), 'nope', null)).toEqual([]);
  });
});
