import { describe, expect, it } from 'vitest';
import type { FlowEndpoint, MapData, MapFeature, OpFlow } from '../types';
import { buildHash, parseHash } from './hash';
import { commandLine, defaultEnabled, featureKey, flagOf, layoutFlow, search, usesOf, visibleEndpoints } from './model';

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
const data: MapData = {
  version: 2, frameworks: ['hono', 'nextjs'], commands: [], features, flows: { hono: flow, nextjs: flow },
  functions: {
    'core:b.ts#isForm': { id: 'core:b.ts#isForm', name: 'isForm', package: 'core', module: 'b.ts', line: 1, exported: true, kind: 'decide', summary: 'Is it a form?', calls: [], calledBy: ['hono:a.ts#parseTokenRequest'] },
    'hono:a.ts#parseTokenRequest': { id: 'hono:a.ts#parseTokenRequest', name: 'parseTokenRequest', package: 'hono', module: 'a.ts', line: 1, exported: true, kind: 'parse', summary: 'Parse.', calls: ['core:b.ts#isForm'], calledBy: [] },
  },
};

describe('featureKey', () => {
  it('should turn a feature id into its OidcFeatureConfig key', () => {
    expect(featureKey('refresh-token')).toBe('refreshToken');
    expect(featureKey('pkce')).toBe('pkce');
  });
});

describe('flagOf', () => {
  it('should name the flag of a feature by its key or id, and every provider without one', () => {
    expect(flagOf(features, 'refreshToken')).toBe('--disable refresh-token');
    expect(flagOf(features, 'par')).toBe('--enable par');
    expect(flagOf(features, undefined)).toBe('every provider');
  });
});

describe('visibleEndpoints', () => {
  it('should leave out the endpoints and steps of features that are off', () => {
    const enabled = new Set(['pkce']);
    const visible = visibleEndpoints(flow, features, enabled);
    expect(visible.map((endpoint) => endpoint.id)).toEqual(['token']);
    expect(visible[0]!.steps.map((step) => step.id)).toEqual(['parse-request', 'respond', 'respond-error']);
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

describe('layoutFlow', () => {
  it('should stack the steps in order, draw consecutive flow arrows straight and the others as arcs', () => {
    const layout = layoutFlow(token, false);
    expect(layout.boxes.map((box) => box.step.id)).toEqual(['parse-request', 'validate-refresh-token-grant', 'respond', 'respond-error']);
    expect(layout.boxes[1]!.y).toBeGreaterThan(layout.boxes[0]!.y);
    const straight = layout.arrows.filter((arrow) => arrow.d.includes(' L'));
    const arcs = layout.arrows.filter((arrow) => arrow.d.includes(' C'));
    expect(straight).toHaveLength(2);
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.label?.text).toBe('answered');
  });

  it('should draw the arrows into the error step only when asked', () => {
    expect(layoutFlow(token, false).arrows.some((arrow) => arrow.edge.kind === 'error')).toBe(false);
    expect(layoutFlow(token, true).arrows.some((arrow) => arrow.edge.kind === 'error')).toBe(true);
  });

  it('should leave room on the right for the arcs and their labels', () => {
    expect(layoutFlow(token, false).width).toBeGreaterThan(layoutFlow({ ...token, edges: token.edges.slice(0, 2) }, false).width);
  });
});

describe('search', () => {
  it('should find steps by id, label or function and functions by name, and nothing under two characters', () => {
    expect(search(data, [token], 'parse').map((hit) => hit.text)).toEqual(['[parse-request] Parse', 'parseTokenRequest()']);
    expect(search(data, [token], 'p')).toEqual([]);
  });
});

describe('hash', () => {
  const defaults = { framework: 'hono', endpoint: null, step: null, fn: null };

  it('should round-trip an endpoint, a step and a function', () => {
    const step = { framework: 'nextjs', endpoint: 'token', step: 'respond', fn: null };
    expect(buildHash(step, data)).toBe('nextjs--token--respond');
    expect(parseHash('#nextjs--token--respond', data, defaults)).toEqual(step);
    expect(buildHash({ ...defaults, fn: 'core:b.ts#isForm' }, data)).toBe('fn--isForm');
    expect(parseHash('#fn--isForm', data, defaults)).toEqual({ ...defaults, fn: 'core:b.ts#isForm' });
  });

  it('should keep the defaults for a hash that names nothing known', () => {
    expect(parseHash('#nope--token', data, defaults)).toEqual(defaults);
    expect(parseHash('#hono--nope', data, defaults)).toEqual({ ...defaults, framework: 'hono' });
    expect(parseHash('#fn--nope', data, defaults)).toEqual(defaults);
  });
});
