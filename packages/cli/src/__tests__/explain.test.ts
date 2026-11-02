import { describe, expect, it } from 'vitest';
import { buildOpMap, endpointOf, functionOf, reachableFunctions, stepOf, stepUses } from '../explain/map.js';
import { renderEndpoint, renderFunction, renderOverview, renderStep } from '../explain/text.js';
import { readFunctionCatalog } from '../extract/templates.js';
import { buildOpFlow } from '../flow/build.js';
import { annotateFlowModules } from '../flow/modules.js';
import { DEFAULT_FEATURES, FEATURE_CONFIG_KEYS, type OidcFeatureConfig } from '../registry.js';

const FRAMEWORKS = ['hono', 'express', 'fastify', 'nextjs'];
const EVERYTHING = Object.fromEntries(FEATURE_CONFIG_KEYS.map((key) => [key, true])) as unknown as OidcFeatureConfig;

const catalog = readFunctionCatalog();
const flow = buildOpFlow({ features: DEFAULT_FEATURES });
const map = buildOpMap({ flow, functions: catalog, frameworks: FRAMEWORKS });

describe('buildOpMap', () => {
  it('should keep the functions the steps reach, down to core, and no other', () => {
    expect(map.functions['hono:oidc-provider/endpoints/token/steps/authenticate-client.ts#authenticateTokenClient']).toBeDefined();
    expect(map.functions['core:client-auth.ts#timingSafeEqual'] ?? map.functions['core:crypto-utils.ts#timingSafeEqual']).toBeDefined();
    // Not reached from any step of the default configuration: a function of an experimental package.
    expect(Object.values(map.functions).some((card) => card.package === 'experimental')).toBe(false);
  });

  it('should say which flag turns each feature on or off and which endpoints it adds', () => {
    const par = map.features.find((feature) => feature.id === 'par');
    expect(par).toMatchObject({ enabled: false, flag: '--enable par', endpoints: ['par'], tier: 'experimental' });
    const introspection = map.features.find((feature) => feature.id === 'introspection');
    expect(introspection).toMatchObject({ enabled: true, flag: '--disable introspection', endpoints: ['introspection'] });
  });

  it('should list the four commands with explain among them', () => {
    expect(map.commands.map((command) => command.name)).toEqual(['generate', 'setup', 'graph', 'explain']);
  });
});

describe('reachableFunctions', () => {
  it('should stop at the depth asked for', () => {
    const step = stepOf(endpointOf(flow, 'token'), 'authenticate-client');
    const one = reachableFunctions(catalog, [step.functionId as string], 1);
    expect(Object.keys(one)).toContain('core:client-auth.ts#extractClientCredentials');
    expect(Object.keys(one)).not.toContain('core:client-auth.ts#validateSingleClientAuthMethod');
    const two = reachableFunctions(catalog, [step.functionId as string], 2);
    expect(Object.keys(two)).toContain('core:client-auth.ts#validateSingleClientAuthMethod');
  });
});

describe('stepUses', () => {
  it('should find the step whose function a card is, and the steps that call it', () => {
    const uses = stepUses(flow);
    const own = uses.get('hono:oidc-provider/endpoints/token/steps/authenticate-client.ts#authenticateTokenClient');
    expect(own?.map((use) => [use.endpoint.id, use.step.id, use.as])).toEqual([['token', 'authenticate-client', 'function']]);
    const called = uses.get('core:client-auth.ts#verifyClientSecret')?.map((use) => `${use.endpoint.id}/${use.step.id}`);
    expect(called).toContain('token/authenticate-client');
    expect(called).toContain('introspection/authenticate-client');
  });
});

describe('functionOf', () => {
  it('should resolve a bare name that is unique', () => {
    expect(functionOf(catalog, 'verifyClientSecret').id).toBe('core:client-auth.ts#verifyClientSecret');
  });

  it('should ask for the root when a name is in both apps', () => {
    expect(() => functionOf(catalog, 'issueImplicitTokens')).toThrow('names 2 functions');
    expect(functionOf(catalog, 'hono:issueImplicitTokens').package).toBe('hono');
  });

  it('should name the roots in the error for an unknown function', () => {
    expect(() => functionOf(catalog, 'nope')).toThrow('Unknown function "nope"');
  });
});

describe('renderOverview', () => {
  const text = renderOverview(map);

  it('should list the commands, the frameworks and the endpoints of the configuration', () => {
    expect(text).toContain('maronn-oidc generate <framework>');
    expect(text).toContain('Frameworks: hono, express, fastify, nextjs');
    expect(text).toMatch(/token\s+POST \/token\s+Token endpoint\s+\d+ steps/);
  });

  it('should name the flag of an endpoint a feature adds, on and off', () => {
    expect(text).toContain('(--disable introspection)');
    expect(text).toMatch(/--enable par\s+par/);
  });
});

describe('renderEndpoint', () => {
  it('should list the steps in pipeline order with their function and the names of their calls', () => {
    const text = renderEndpoint(map, endpointOf(flow, 'token'));
    expect(text).toContain('POST /token  Token endpoint');
    expect(text).toMatch(/1\. \[parse-request\] Parse the token request/);
    expect(text).toMatch(/2\. \[authenticate-client\][^\n]*\n\s+authenticateTokenClient\(\)[^\n]*\n[^\n]*\n\s+calls: extractClientCredentials, resolveAuthenticatedTokenClient, validateClientAuthMethod, verifyClientSecret/);
  });

  it('should mark the dynamic calls of a step', () => {
    const text = renderEndpoint(map, endpointOf(flow, 'consent'));
    expect(text).toContain('consentResolver.recordConsent (dynamic)');
  });
});

describe('renderStep', () => {
  const endpoint = endpointOf(flow, 'token');
  const step = stepOf(endpoint, 'authenticate-client');

  it('should draw the function of the step and the tree of its calls to the depth asked for', () => {
    const one = renderStep(map, endpoint, step, 1);
    expect(one).toContain('authenticateTokenClient()  hono oidc-provider/endpoints/token/steps/authenticate-client.ts');
    expect(one).toContain('├─ extractClientCredentials()  core client-auth.ts');
    expect(one).not.toContain('validateSingleClientAuthMethod()');
    const two = renderStep(map, endpoint, step, 2);
    expect(two).toContain('│  ├─ validateSingleClientAuthMethod()  core client-auth.ts');
  });

  it('should say where the step sits in the pipeline and what it reads and defines', () => {
    const text = renderStep(map, endpoint, step, 1);
    expect(text).toContain('pipeline: [parse-request] → [authenticate-client] → [validate-grant-type]');
    expect(text).toContain('reads: params, authorization   defines: tokenClient, authenticatedClientId');
  });

  it('should show the block of a Next.js Route Handler with the calls of the block', () => {
    const next = annotateFlowModules(buildOpFlow({ features: DEFAULT_FEATURES }), 'nextjs');
    const nextMap = buildOpMap({ flow: next, functions: catalog, frameworks: FRAMEWORKS, framework: 'nextjs' });
    const text = renderStep(nextMap, endpointOf(next, 'token'), stepOf(endpointOf(next, 'token'), 'authenticate-client'), 1);
    expect(text).toContain('(a block of token/route.ts, not a function of its own)');
    expect(text).toContain('├─ extractClientCredentials()  core client-auth.ts');
  });
});

describe('renderFunction', () => {
  const everything = [
    { flow: buildOpFlow({ features: EVERYTHING }) },
    { flow: annotateFlowModules(buildOpFlow({ features: EVERYTHING }), 'nextjs'), framework: 'nextjs' },
  ];

  it('should show the card, its calls and the steps of every feature that use it', () => {
    const text = renderFunction(map, catalog, functionOf(catalog, 'verifyClientSecret'), { depth: 1, callers: false, everything });
    expect(text).toContain('verifyClientSecret()  core client-auth.ts');
    expect(text).toContain('⇐ called by step [authenticate-client] of POST /token  (every provider)');
    expect(text).toContain('⇐ called by step [authenticate-client] of POST /backchannel_authentication  (--enable ciba)');
    expect(text).toContain('⇐ called by block [authenticate-client] of POST /token  (every provider)  [nextjs token/route.ts]');
    expect(text).toContain('├─ isPublicTokenClient()');
    expect(text).not.toContain('Called by');
  });

  it('should climb the callers up to the steps with --callers', () => {
    const text = renderFunction(map, catalog, functionOf(catalog, 'validateClientAuthMethodAllowed'), { depth: 2, callers: true, everything });
    expect(text).toContain('Called by');
    expect(text).toContain('← validateClientAuthMethod()  core client-auth.ts');
    expect(text).toContain('← authenticateTokenClient()  hono oidc-provider/endpoints/token/steps/authenticate-client.ts');
    expect(text).toContain('⇐ the function of step [authenticate-client] of POST /token  (every provider)');
    expect(text).toContain('(--enable device-authorization-grant)');
  });
});
