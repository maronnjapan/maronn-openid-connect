import { describe, expect, it } from 'vitest';
import type { FlowEndpoint, FunctionCard, MapData, MapFeature, OpFlow } from '../types';
import { buildHash, parseHash } from './hash';
import { callersOf, commandLine, defaultEnabled, endpointsInModule, endpointsUsing, featureKey, featuresToShow, generatedWhen, search, usesOf, visibleEndpoints } from './model';

const features: MapFeature[] = [
  { id: 'pkce', tier: 'stable', summary: 'PKCE', enabled: true, flag: '--disable pkce', endpoints: [], packages: [] },
  { id: 'refresh-token', tier: 'stable', summary: 'refresh', enabled: true, flag: '--disable refresh-token', endpoints: [], packages: [] },
  { id: 'par', tier: 'experimental', summary: 'PAR', enabled: true, flag: '--enable par', endpoints: ['par'], packages: [] },
];

const token: FlowEndpoint = {
  id: 'token', label: 'Token endpoint', path: '/token', methods: ['POST'], layer: 'api', group: { id: 'code', label: 'Code' }, rearrangeable: true,
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

function card(id: string, name: string, calls: string[], calledBy: string[], summary = `${name} does it.`): FunctionCard {
  const [root, rest] = id.split(':') as [string, string];
  return { id, name, package: root, module: rest.split('#')[0] as string, line: 1, exported: true, kind: 'other', summary, calls, calledBy };
}

const data: MapData = {
  version: 3, frameworks: ['hono', 'nextjs'], commands: [], features, flows: { hono: flow, nextjs: flow }, members: {}, memberOfCall: {}, edgeSets: {},
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

  it('should take the arrows the generation of the enabled features draws, when the data has them', () => {
    const edgeSets = { token: { '': [{ from: 'parse-request', to: 'respond', kind: 'flow' as const }], refreshToken: token.edges } };
    expect(visibleEndpoints(flow, features, new Set(['pkce']), edgeSets)[0]!.edges).toEqual([{ from: 'parse-request', to: 'respond', kind: 'flow' }]);
    expect(visibleEndpoints(flow, features, new Set(['pkce', 'refresh-token']), edgeSets)[0]!.edges).toEqual(token.edges);
  });

  it('should show everything when every feature is on', () => {
    expect(visibleEndpoints(flow, features, new Set(['pkce', 'refresh-token', 'par'])).map((endpoint) => endpoint.id)).toEqual(['token', 'par']);
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

describe('hash', () => {
  const defaults = { framework: 'hono', endpoint: null, step: null, fn: null };

  it('should round-trip an endpoint and a step', () => {
    const step = { framework: 'nextjs', endpoint: 'token', step: 'respond', fn: null };
    expect(buildHash(step, data)).toBe('nextjs--token--respond');
    expect(parseHash('#nextjs--token--respond', data, defaults)).toEqual(step);
  });

  it('should round-trip a function by its name, and by its package and module when the name is shared', () => {
    expect(buildHash({ ...defaults, fn: 'core:b.ts#isForm' }, data)).toBe('hono--fn--isForm');
    expect(parseHash('#hono--fn--isForm', data, defaults)).toEqual({ ...defaults, fn: 'core:b.ts#isForm' });
    expect(buildHash({ ...defaults, fn: 'core:y.ts#split' }, data)).toBe('hono--fn--split--core--y.ts');
    expect(parseHash('#nextjs--fn--split--core--y.ts', data, defaults)).toEqual({ ...defaults, framework: 'nextjs', fn: 'core:y.ts#split' });
  });

  it('should still open the function of an earlier link (#fn--name)', () => {
    expect(parseHash('#fn--isForm', data, defaults)).toEqual({ ...defaults, fn: 'core:b.ts#isForm' });
  });

  it('should round-trip the page of the changes of the pull request, and read #changes alone', () => {
    const changes = { ...defaults, framework: 'nextjs', changes: true };
    expect(buildHash(changes, data)).toBe('nextjs--changes');
    expect(parseHash('#nextjs--changes', data, defaults)).toEqual(changes);
    expect(parseHash('#changes', data, defaults)).toEqual({ ...defaults, changes: true });
  });

  it('should name a function opened from the page of the changes by the function', () => {
    expect(buildHash({ ...defaults, fn: 'core:b.ts#isForm', changes: true }, data)).toBe('hono--fn--isForm');
  });

  it('should keep the defaults for a hash that names nothing known', () => {
    expect(parseHash('#nope--token', data, defaults)).toEqual(defaults);
    expect(parseHash('#hono--nope', data, defaults)).toEqual({ ...defaults, framework: 'hono' });
    expect(parseHash('#fn--nope', data, defaults)).toEqual(defaults);
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
