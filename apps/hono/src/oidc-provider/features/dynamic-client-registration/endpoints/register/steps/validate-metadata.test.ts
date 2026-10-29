import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { registrableGrantTypes, registrableScopes, validateRegistrationMetadata } from './validate-metadata.js';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW = Date.UTC(2026, 0, 1) / 1000;
const CLIENT_ID = /^dcr-[A-Za-z0-9_-]{22}$/;
const CLIENT_SECRET = /^[A-Za-z0-9_-]{43}$/;
const REDIRECT_URIS = ['https://rp.example.com/callback'];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('validateRegistrationMetadata', () => {
  // RFC 7591 §2 and OIDC Dynamic Client Registration 1.0 §2: the defaults of
  // the metadata the client left out, registered so the response carries them (§3.2).
  it('should build a confidential client with a new client_id, a secret and the RFC 7591 defaults', async () => {
    const { c } = await providerContext();

    const client = validateRegistrationMetadata(c, { redirect_uris: REDIRECT_URIS });

    expect(client).toEqual({
      clientId: expect.stringMatching(CLIENT_ID),
      clientSecret: expect.stringMatching(CLIENT_SECRET),
      clientType: 'confidential',
      redirectUris: REDIRECT_URIS,
      grantTypes: ['authorization_code'],
      responseTypes: ['code'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
      idTokenSignedResponseAlg: 'RS256',
      clientIdIssuedAt: NOW,
      metadata: {
        redirect_uris: REDIRECT_URIS,
        token_endpoint_auth_method: 'client_secret_basic',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        application_type: 'web',
        id_token_signed_response_alg: 'RS256',
      },
    });
  });

  // RFC 6749 §2.1: a client with token_endpoint_auth_method none is public and gets no secret.
  it('should build a public client without a secret for token_endpoint_auth_method none', async () => {
    const { c } = await providerContext();

    const client = validateRegistrationMetadata(c, {
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['refresh_token', 'authorization_code'],
      client_name: 'Example App',
      scope: 'openid profile',
    });

    expect(client).toEqual({
      clientId: expect.stringMatching(CLIENT_ID),
      clientType: 'public',
      redirectUris: ['http://127.0.0.1:8080/callback'],
      grantTypes: ['refresh_token', 'authorization_code'],
      responseTypes: ['code'],
      tokenEndpointAuthMethods: ['none'],
      scope: ['openid', 'profile'],
      idTokenSignedResponseAlg: 'RS256',
      clientIdIssuedAt: NOW,
      metadata: {
        redirect_uris: ['http://127.0.0.1:8080/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['refresh_token', 'authorization_code'],
        response_types: ['code'],
        application_type: 'web',
        client_name: 'Example App',
        scope: 'openid profile',
        id_token_signed_response_alg: 'RS256',
      },
    });
  });

  // OIDC Dynamic Client Registration 1.0 §2: the response types of the generated features are registrable.
  it('should accept the response types this provider answers', async () => {
    const { c } = await providerContext();

    const client = validateRegistrationMetadata(c, {
      redirect_uris: REDIRECT_URIS,
      grant_types: ['authorization_code', 'implicit'],
      response_types: ['code', 'code id_token token'],
    });

    expect(client.responseTypes).toEqual(['code', 'code id_token token']);
  });

  it('should bound the signed response algs to the algs of the provider signing keys', async () => {
    const { c } = await providerContext();

    const accepted = validateRegistrationMetadata(c, { redirect_uris: REDIRECT_URIS, id_token_signed_response_alg: 'RS256' });

    expect(accepted.idTokenSignedResponseAlg).toBe('RS256');
    expect(() =>
      validateRegistrationMetadata(c, { redirect_uris: REDIRECT_URIS, userinfo_signed_response_alg: 'ES256' }),
    ).toThrow(
      expect.objectContaining({
        name: 'ClientRegistrationError',
        error: 'invalid_client_metadata',
        errorDescription: 'userinfo_signed_response_alg must be one of RS256',
      }),
    );
  });

  // OIDC Dynamic Client Registration 1.0 §2 / OIDC Core 1.0 §6.2: the request_uri
  // values the client may use, kept for the authorization endpoint to match.
  it('should register request_uris and carry them into the client', async () => {
    const { c } = await providerContext();
    const requestUris = ['https://rp.example.com/requests/a#NjYz', 'https://rp.example.com/requests/b'];

    const client = validateRegistrationMetadata(c, { redirect_uris: REDIRECT_URIS, request_uris: requestUris });

    expect(client.requestUris).toEqual(requestUris);
    expect(client.metadata['request_uris']).toEqual(requestUris);
  });

  // The algs the request-object feature advertises: RS256, and none only while
  // unsigned Request Objects are accepted.
  it('should bound request_object_signing_alg to the algs the request-object feature advertises', async () => {
    const { c } = await providerContext();
    const { c: unsignedAllowed } = await providerContext({ options: { config: { allowUnsignedRequestObject: true } } });

    const client = validateRegistrationMetadata(c, { redirect_uris: REDIRECT_URIS, request_object_signing_alg: 'RS256' });
    const noneClient = validateRegistrationMetadata(unsignedAllowed, {
      redirect_uris: REDIRECT_URIS,
      request_object_signing_alg: 'none',
    });

    expect(client.requestObjectSigningAlg).toBe('RS256');
    expect(noneClient.requestObjectSigningAlg).toBe('none');
    expect(() =>
      validateRegistrationMetadata(c, { redirect_uris: REDIRECT_URIS, request_object_signing_alg: 'none' }),
    ).toThrow(
      expect.objectContaining({
        name: 'ClientRegistrationError',
        error: 'invalid_client_metadata',
        errorDescription: 'request_object_signing_alg must be one of RS256',
      }),
    );
  });

  it('should bound the auth methods to those of the registration settings', async () => {
    const { c } = await providerContext({
      options: { dynamicClientRegistration: { tokenEndpointAuthMethods: ['client_secret_basic', 'private_key_jwt'] } },
    });

    const client = validateRegistrationMetadata(c, { redirect_uris: REDIRECT_URIS, token_endpoint_auth_method: 'private_key_jwt' });

    expect(client.tokenEndpointAuthMethods).toEqual(['private_key_jwt']);
    expect(client.clientType).toBe('confidential');
    expect(Object.hasOwn(client, 'clientSecret')).toBe(false);
  });

  it('should run the custom metadata validators of the registration settings', async () => {
    const { c } = await providerContext({
      options: { dynamicClientRegistration: { customClientMetadata: { tier: (value) => value ?? 'free' } } },
    });

    const client = validateRegistrationMetadata(c, { redirect_uris: REDIRECT_URIS });

    expect(client.metadata['tier']).toBe('free');
  });

  // RFC 7591 §3.2.2: invalid_redirect_uri, without echoing the URI.
  it('should reject a plain-http redirect URI that is not a loopback with invalid_redirect_uri', async () => {
    const { c } = await providerContext();

    expect(() => validateRegistrationMetadata(c, { redirect_uris: ['http://rp.example.com/callback'] })).toThrow(
      expect.objectContaining({
        name: 'ClientRegistrationError',
        error: 'invalid_redirect_uri',
        errorDescription:
          'each redirect_uri must be an absolute URI without a fragment and must not use a dangerous scheme or non-loopback http',
      }),
    );
  });
});

describe('registrableGrantTypes', () => {
  // The provider answers authorization_code, the token grants of its features
  // (refresh_token, token exchange, device code, CIBA, jwt-bearer) and, while a
  // feature answers an implicit response type, implicit.
  it('should keep the configured grants this provider answers, in the configured order', () => {
    expect(
      registrableGrantTypes(
        ['implicit', 'authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'password'],
        ['code', 'id_token'],
      ),
    ).toEqual(['implicit', 'authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code']);
  });

  it('should leave implicit out while no response type returns a token or an id_token', () => {
    expect(registrableGrantTypes(['authorization_code', 'implicit'], ['code'])).toEqual(['authorization_code']);
  });
});

describe('registrableScopes', () => {
  // scopes.ts declares no custom scope in apps/hono, so any value registers.
  it('should return undefined while no custom scope is declared', () => {
    expect(registrableScopes()).toBeUndefined();
  });
});
