import type { ClientResolver, TokenClientResolver } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import type { AuthorizationResponseModeHandler } from '../authorize/response-mode';
import type { LoginMethod } from '../login/login-method';
import { createProviderConfig } from './config';
import {
  configOf,
  contextOf,
  defineFeature,
  discoveryOf,
  loginMethodsOf,
  responseModesOf,
  tokenGrantsOf,
  type Feature,
  type ProviderContext,
} from './feature';

const ISSUER = 'https://op.example.com';
const config = createProviderConfig({ issuer: ISSUER });

/** A client resolver that knows one client, named after the resolver. */
function clientResolver(name: string): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string) {
      return clientId === name ? { clientId, redirectUris: [] } : null;
    },
  };
}

function responseMode(name: string): AuthorizationResponseModeHandler {
  return {
    names: [name],
    restore: async () => ({ name, respond: async (redirectUri) => ({ method: 'redirect', location: redirectUri }) }),
  };
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

// OIDC Discovery 1.0 §3: the features add members to the provider metadata.
describe('discoveryOf', () => {
  it('should merge an array member into the advertised array, each value once in order', () => {
    const features = [
      defineFeature({ id: 'a', discovery: () => ({ grant_types_supported: ['refresh_token', 'authorization_code'] }) }),
      defineFeature({ id: 'b', discovery: () => ({ grant_types_supported: ['urn:example:grant', 'refresh_token'] }) }),
    ];

    const merged = discoveryOf(features, { grant_types_supported: ['authorization_code'] }, ISSUER, config);

    expect(merged).toEqual({ grant_types_supported: ['authorization_code', 'refresh_token', 'urn:example:grant'] });
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

  it('should add the members of the features after the advertised ones, in the order of the features', () => {
    const features = [
      defineFeature({ id: 'a', discovery: () => ({ pushed_authorization_request_endpoint: `${ISSUER}/par` }) }),
      defineFeature({ id: 'without-discovery' }),
      defineFeature({ id: 'b', discovery: () => ({ registration_endpoint: `${ISSUER}/register` }) }),
    ];

    const merged = discoveryOf(features, { issuer: ISSUER }, ISSUER, config);

    expect(Object.entries(merged)).toEqual([
      ['issuer', ISSUER],
      ['pushed_authorization_request_endpoint', 'https://op.example.com/par'],
      ['registration_endpoint', 'https://op.example.com/register'],
    ]);
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

describe('contextOf', () => {
  it('should apply the context hooks in the order of the features, each one given the values built so far', () => {
    const base = clientResolver('base');
    const replaced = clientResolver('replaced');
    const seen: ProviderContext['clientResolver'][] = [];
    const features = [
      defineFeature({
        id: 'a',
        context: (provider) => {
          seen.push(provider.clientResolver);
          return { clientResolver: replaced };
        },
      }),
      defineFeature({ id: 'without-context' }),
      defineFeature({
        id: 'b',
        context: (provider) => {
          seen.push(provider.clientResolver);
          return {};
        },
      }),
    ];

    const context = contextOf(features, { clientResolver: base });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(base);
    expect(seen[1]).toBe(replaced);
    expect(context.clientResolver).toBe(replaced);
  });

  it('should return the values it is given when no feature has a context hook', () => {
    const base = clientResolver('base');

    const context = contextOf([defineFeature({ id: 'a' })], { clientResolver: base });

    expect(context.clientResolver).toBe(base);
  });

  it('should leave the values it is given unchanged', () => {
    const base = clientResolver('base');
    const provider: ProviderContext = { clientResolver: base };
    const features = [defineFeature({ id: 'a', context: () => ({ clientResolver: clientResolver('replaced') }) })];

    contextOf(features, provider);

    expect(provider.clientResolver).toBe(base);
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

  it('should return no grant_type when no feature answers one', () => {
    expect(tokenGrantsOf([defineFeature({ id: 'a' }), defineFeature({ id: 'b', token: {} })])).toEqual([]);
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

    const modes = responseModesOf(features);

    expect(modes).toHaveLength(2);
    expect(modes[0]).toBe(queryJwt);
    expect(modes[1]).toBe(formPostJwt);
  });

  it('should return no response mode when no feature answers in one', () => {
    expect(responseModesOf([defineFeature({ id: 'a' }), defineFeature({ id: 'b', authorize: {} })])).toEqual([]);
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

    const methods = loginMethodsOf(features);

    expect(methods).toHaveLength(2);
    expect(methods[0]).toBe(google);
    expect(methods[1]).toBe(passkey);
  });

  it('should return no login method when no feature offers one', () => {
    expect(loginMethodsOf([defineFeature({ id: 'a' })])).toEqual([]);
  });
});
