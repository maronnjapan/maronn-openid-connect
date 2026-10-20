import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../test-support/context.js';
import { staticKeyProvider } from '../../test-support/keys.js';
import { createProviderConfig } from '../config.js';
import { createEmptyDatabase } from '../db/memory/database.js';
import { createProviderStores } from '../db/memory/stores.js';
import type { AuthorizationResponseModeHandler } from '../endpoints/authorize/response-mode.js';
import type { AuthorizationResponseTypeHandler } from '../endpoints/authorize/response-type.js';
import type { LoginMethod } from '../endpoints/login/login-method.js';
import {
  applyContextOf,
  configOf,
  defineFeature,
  discoveryOf,
  loginMethodsOf,
  responseModesOf,
  responseTypesOf,
  routesOf,
  tokenGrantsOf,
  type Feature,
  type FeatureContextInput,
} from './feature.js';

const ISSUER = 'https://op.example.com';
const config = createProviderConfig({ issuer: ISSUER });

/** A context hook input on a bare context with the given values. */
function contextInput(values: Record<string, unknown> = {}): FeatureContextInput {
  return {
    c: contextOf(undefined, values),
    options: { signingKeyProvider: staticKeyProvider() },
    stores: createProviderStores(createEmptyDatabase()),
  };
}

function responseMode(name: string): AuthorizationResponseModeHandler {
  return {
    names: [name],
    restore: () => ({ name, respond: async (redirectUri) => ({ method: 'redirect', location: redirectUri }) }),
  };
}

function responseType(names: AuthorizationResponseTypeHandler['names']): AuthorizationResponseTypeHandler {
  return { names, respond: async () => ({ kind: 'server_error' }) };
}

function loginMethod(id: string): LoginMethod {
  return { id, render: async () => undefined };
}

describe('defineFeature', () => {
  it('should return the feature it is given', () => {
    const feature: Feature = { id: 'example' };

    expect(defineFeature(feature)).toBe(feature);
  });
});

describe('routesOf', () => {
  it('should list the routes of every feature in the order of the features', () => {
    const first = new Hono();
    const second = new Hono();
    const third = new Hono();
    const features = [
      defineFeature({
        id: 'one',
        routes: [
          { path: '/one', app: first, methods: ['GET'] },
          { path: '/one/more', app: second, methods: ['POST'] },
        ],
      }),
      defineFeature({ id: 'without-routes' }),
      defineFeature({ id: 'two', routes: [{ path: '/two', app: third, methods: ['POST'], cors: 'protected' }] }),
    ];

    expect(routesOf(features)).toEqual([
      { path: '/one', app: first, methods: ['GET'] },
      { path: '/one/more', app: second, methods: ['POST'] },
      { path: '/two', app: third, methods: ['POST'], cors: 'protected' },
    ]);
  });

  it('should return no routes when no feature serves one', () => {
    expect(routesOf([defineFeature({ id: 'a' }), defineFeature({ id: 'b' })])).toEqual([]);
  });
});

// OIDC Discovery 1.0 §3: the features add members to the provider metadata.
describe('discoveryOf', () => {
  it('should merge an array member into the advertised array, each value once in order', () => {
    const features = [
      defineFeature({ id: 'a', discovery: () => ({ grant_types_supported: ['refresh_token', 'authorization_code'] }) }),
      defineFeature({ id: 'b', discovery: () => ({ grant_types_supported: ['urn:example:grant', 'refresh_token'] }) }),
    ];

    const merged = discoveryOf(features, { grant_types_supported: ['authorization_code'] }, ISSUER, config);

    expect(merged).toEqual({
      grant_types_supported: ['authorization_code', 'refresh_token', 'urn:example:grant'],
    });
  });

  it('should replace a scalar member, the later feature winning', () => {
    const features = [
      defineFeature({ id: 'a', discovery: () => ({ request_parameter_supported: true }) }),
      defineFeature({ id: 'b', discovery: () => ({ request_parameter_supported: 'yes' }) }),
    ];

    const merged = discoveryOf(features, { issuer: ISSUER, request_parameter_supported: false }, ISSUER, config);

    expect(merged).toEqual({ issuer: ISSUER, request_parameter_supported: 'yes' });
  });

  it('should replace an array member with a value that is not an array, and a scalar with an array', () => {
    const features = [
      defineFeature({ id: 'a', discovery: () => ({ scopes_supported: 'openid', claims_supported: ['sub'] }) }),
    ];

    const merged = discoveryOf(features, { scopes_supported: ['openid', 'profile'], claims_supported: 'none' }, ISSUER, config);

    expect(merged).toEqual({ scopes_supported: 'openid', claims_supported: ['sub'] });
  });

  it('should pass the issuer and the settings to the discovery hook of a feature', () => {
    const features = [
      defineFeature({
        id: 'a',
        discovery: (issuer, settings) => ({
          registration_endpoint: `${issuer}/register`,
          example_lifetime: settings.accessTokenExpiresIn,
        }),
      }),
    ];

    expect(discoveryOf(features, {}, ISSUER, config)).toEqual({
      registration_endpoint: 'https://op.example.com/register',
      example_lifetime: 3600,
    });
  });

  it('should leave the metadata it is given unchanged', () => {
    const metadata = { grant_types_supported: ['authorization_code'] };
    const features = [defineFeature({ id: 'a', discovery: () => ({ grant_types_supported: ['refresh_token'] }) })];

    discoveryOf(features, metadata, ISSUER, config);

    expect(metadata).toEqual({ grant_types_supported: ['authorization_code'] });
  });
});

describe('applyContextOf', () => {
  it('should set the values of the features in their order, a later feature reading and replacing earlier ones', async () => {
    const input = contextInput({ clientResolver: 'base' });
    const features = [
      defineFeature({ id: 'a', context: { first: 1, shared: 'from-a' } }),
      defineFeature({ id: 'without-context' }),
      defineFeature({
        id: 'b',
        context: ({ c }) => ({
          seenShared: c.get('shared'),
          shared: 'from-b',
          clientResolver: `${c.get('clientResolver')}+b`,
        }),
      }),
    ];

    await applyContextOf(features, input);

    expect({
      first: input.c.get('first'),
      seenShared: input.c.get('seenShared'),
      shared: input.c.get('shared'),
      clientResolver: input.c.get('clientResolver'),
    }).toEqual({ first: 1, seenShared: 'from-a', shared: 'from-b', clientResolver: 'base+b' });
  });

  it('should await a context hook that returns a promise', async () => {
    const input = contextInput();
    const features = [defineFeature({ id: 'a', context: async () => ({ loaded: 'later' }) })];

    await applyContextOf(features, input);

    expect(input.c.get('loaded')).toBe('later');
  });

  it('should pass the options and the stores to a context hook', async () => {
    const input = contextInput();
    const features = [
      defineFeature({ id: 'a', context: ({ options, stores }) => ({ options, stores }) }),
    ];

    await applyContextOf(features, input);

    expect(input.c.get('options')).toBe(input.options);
    expect(input.c.get('stores')).toBe(input.stores);
  });
});

describe('configOf', () => {
  it('should merge the defaults of the features, a later feature replacing an earlier one', () => {
    const features = [
      defineFeature({ id: 'a', config: { accessTokenFormat: 'opaque', authorizationCodeTtl: 60 } }),
      defineFeature({ id: 'without-config' }),
      defineFeature({ id: 'b', config: { accessTokenFormat: 'jwt' } }),
    ];

    expect(configOf(features)).toEqual({ accessTokenFormat: 'jwt', authorizationCodeTtl: 60 });
  });

  it('should return no defaults when no feature has any', () => {
    expect(configOf([defineFeature({ id: 'a' })])).toEqual({});
  });
});

describe('tokenGrantsOf', () => {
  it('should list each grant_type once, in the order the features name them', () => {
    const features = [
      defineFeature({ id: 'exchange', token: { grants: ['urn:ietf:params:oauth:grant-type:token-exchange'] } }),
      defineFeature({ id: 'without-grants' }),
      defineFeature({
        id: 'assertion',
        token: {
          grants: ['urn:ietf:params:oauth:grant-type:token-exchange', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
        },
      }),
    ];

    expect(tokenGrantsOf(features)).toEqual([
      'urn:ietf:params:oauth:grant-type:token-exchange',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ]);
  });
});

describe('responseModesOf', () => {
  it('should list the response modes of every feature in the order of the features', () => {
    const queryJwt = responseMode('query.jwt');
    const formPostJwt = responseMode('form_post.jwt');
    const features = [
      defineFeature({ id: 'a', authorize: { responseModes: [queryJwt] } }),
      defineFeature({ id: 'b' }),
      defineFeature({ id: 'c', authorize: { responseModes: [formPostJwt] } }),
    ];

    expect(responseModesOf(features)).toEqual([queryJwt, formPostJwt]);
  });
});

describe('responseTypesOf', () => {
  it('should list the response types of every feature in the order of the features', () => {
    const idToken = responseType(['id_token']);
    const idTokenToken = responseType(['id_token token']);
    const features = [
      defineFeature({ id: 'a', authorize: { responseTypes: [idToken] } }),
      defineFeature({ id: 'b', authorize: { responseModes: [responseMode('fragment')] } }),
      defineFeature({ id: 'c', authorize: { responseTypes: [idTokenToken] } }),
    ];

    expect(responseTypesOf(features)).toEqual([idToken, idTokenToken]);
  });
});

describe('loginMethodsOf', () => {
  it('should list the login methods of every feature in the order of the features', () => {
    const google = loginMethod('google');
    const passkey = loginMethod('passkey');
    const features = [
      defineFeature({ id: 'a', loginMethods: [google] }),
      defineFeature({ id: 'b' }),
      defineFeature({ id: 'c', loginMethods: [passkey] }),
    ];

    expect(loginMethodsOf(features)).toEqual([google, passkey]);
  });
});
