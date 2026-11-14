import { TokenError, type TokenClientInfo } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt } from '../../../../test-support/jwt';
import { providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import { jsonResponseOf } from '../../../../test-support/responses';
import { config, stores } from '../../provider';
import { findUnsupportedScopes } from '../../scopes';
import { dispatchClientCredentials } from './grant';

// The provider declares no custom scope (CUSTOM_SCOPES in scopes.ts is
// empty), so the allow-list check never rejects anything. It is replaced by
// a spy that behaves the same until a test says otherwise.
vi.mock('../../scopes', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../scopes')>();
  return { ...original, findUnsupportedScopes: vi.fn(original.findUnsupportedScopes) };
});

// provider.ts keeps its stores in the key-value store of db/ (in memory for
// the tests, vitest.config.ts) for the whole file; every test reads the token
// its own request was answered with.

/** 2026-01-01T00:00:00Z in Unix seconds: every test runs on this clock. */
const NOW = 1767225600;
const ISSUER = 'https://op.example.com';
const API = 'https://api.example.com';
const defaultAudiences = config.clientCredentialsAllowedAudiences;

/** A confidential client registered for the grant and for two scopes of a resource server. */
const client: TokenClientInfo = {
  clientId: 'service-1',
  grantTypes: ['client_credentials'],
  tokenEndpointAuthMethods: ['client_secret_basic'],
  scope: ['reports.read', 'reports.write'],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  config.clientCredentialsAllowedAudiences = defaultAudiences;
  vi.mocked(findUnsupportedScopes).mockClear();
  vi.useRealTimers();
});

function request(fields: Record<string, string> = {}): Record<string, string> {
  return { grant_type: 'client_credentials', ...fields };
}

/** The TokenError the grant fails with. */
async function failureOf(promise: Promise<unknown>): Promise<TokenError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  return error as TokenError;
}

describe('dispatchClientCredentials', () => {
  it('should return undefined for another grant_type', async () => {
    const keys = providerSigningKeys(await rs256Key());

    expect(await dispatchClientCredentials({ grant_type: 'authorization_code', code: 'code-1' }, client, keys)).toBeUndefined();
  });

  describe('Token response', () => {
    // RFC 6749 §4.4.3 / §5.1: access_token, token_type, expires_in and scope; no refresh_token.
    it('should answer an access token for the requested scope without a refresh token or an ID Token', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const response = await dispatchClientCredentials(request({ scope: 'reports.read' }), client, keys);
      const parts = await jsonResponseOf(response);
      const { access_token: accessToken, ...body } = parts?.body as Record<string, unknown>;

      expect({ ...parts, body }).toEqual({
        status: 200,
        contentType: 'application/json',
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: { token_type: 'Bearer', expires_in: 3600, scope: 'reports.read' },
      });
      expect(typeof accessToken).toBe('string');
    });

    // RFC 9068 §2.2: the sub of a token no resource owner is involved in names the client.
    it('should issue a JWT whose sub and client_id are the client and whose aud is the issuer', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const response = await dispatchClientCredentials(request({ scope: 'reports.read' }), client, keys);
      const { access_token: accessToken } = (await response!.json()) as { access_token: string };

      const { header, payload } = decodeJwt(accessToken);
      expect(header).toMatchObject({ alg: 'RS256', typ: 'at+jwt' });
      expect(payload).toEqual({
        iss: ISSUER,
        sub: 'service-1',
        aud: [ISSUER],
        exp: NOW + 3600,
        iat: NOW,
        nbf: NOW,
        jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        scope: 'reports.read',
        client_id: 'service-1',
      });
    });

    // RFC 7662 §2.2: the record the introspection and revocation endpoints read.
    it('should store the record of the access token without a grant id', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const response = await dispatchClientCredentials(request({ scope: 'reports.read' }), client, keys);
      const { access_token: accessToken } = (await response!.json()) as { access_token: string };

      expect(await stores.accessTokenStore.get(accessToken)).toEqual({
        sub: 'service-1',
        clientId: 'service-1',
        scope: ['reports.read'],
        expiresAt: NOW + 3600,
        iat: NOW,
        nbf: NOW,
        audience: [ISSUER],
        issuer: ISSUER,
        jti: decodeJwt(accessToken).payload['jti'],
      });
    });
  });

  describe('Client', () => {
    // RFC 7591 §2: grant_types defaults to ["authorization_code"].
    it('should reject a client that did not register the grant with unauthorized_client', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const error = await failureOf(
        dispatchClientCredentials(request(), { ...client, grantTypes: ['authorization_code'] }, keys),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'unauthorized_client',
        errorDescription: 'Client is not authorized to use grant_type: client_credentials',
        statusCode: 400,
      });
    });

    // RFC 6749 §4.4: the grant MUST only be used by confidential clients.
    it('should reject a public client with unauthorized_client', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const error = await failureOf(
        dispatchClientCredentials(request(), { ...client, tokenEndpointAuthMethods: ['none'] }, keys),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'unauthorized_client',
        errorDescription: 'The client_credentials grant is only available to confidential clients',
      });
    });
  });

  describe('Scope', () => {
    // RFC 6749 §3.3: a request without scope gets the pre-defined default, the scopes the client registered.
    it('should issue every registered scope when the request names none', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const response = await dispatchClientCredentials(request(), client, keys);

      expect(await response!.json()).toMatchObject({ scope: 'reports.read reports.write' });
    });

    it('should leave scope out of the response and the token for a client without registered scopes', async () => {
      const keys = providerSigningKeys(await rs256Key());
      const { scope: _scope, ...withoutScope } = client;

      const response = await dispatchClientCredentials(request(), withoutScope, keys);
      const { access_token: accessToken, ...body } = (await response!.json()) as Record<string, unknown>;

      expect(body).toEqual({ token_type: 'Bearer', expires_in: 3600 });
      expect(decodeJwt(accessToken as string).payload).not.toHaveProperty('scope');
      expect((await stores.accessTokenStore.get(accessToken as string))!.scope).toEqual([]);
    });

    // RFC 7591 §2: no End-User consents here, so only the registered scopes are issued.
    it('should reject a scope the client did not register with invalid_scope', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const error = await failureOf(dispatchClientCredentials(request({ scope: 'reports.read admin' }), client, keys));

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'invalid_scope',
        errorDescription: 'Client is not registered for scope: admin',
        statusCode: 400,
      });
    });

    it('should reject every requested scope of a client without registered scopes with invalid_scope', async () => {
      const keys = providerSigningKeys(await rs256Key());
      const { scope: _scope, ...withoutScope } = client;

      const error = await failureOf(dispatchClientCredentials(request({ scope: 'reports.read' }), withoutScope, keys));

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({ error: 'invalid_scope' });
    });

    // OIDC Core 1.0 §3.1.2.1: openid stands for the authentication of an End-User.
    it('should reject openid with invalid_scope even when the client registered it', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const error = await failureOf(
        dispatchClientCredentials(
          request({ scope: 'openid reports.read' }),
          { ...client, scope: ['openid', 'reports.read'] },
          keys,
        ),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'invalid_scope',
        errorDescription: 'Scope is not available for the client_credentials grant: openid',
      });
    });

    it('should leave openid and offline_access out of the default scope', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const response = await dispatchClientCredentials(
        request(),
        { ...client, scope: ['openid', 'offline_access', 'reports.read'] },
        keys,
      );

      expect(await response!.json()).toMatchObject({ scope: 'reports.read' });
    });

    // RFC 6749 §3.3: a scope the provider did not declare (scopes.ts) is refused, as at /authorize.
    it('should reject a scope the provider does not accept with invalid_scope', async () => {
      vi.mocked(findUnsupportedScopes).mockReturnValueOnce(['reports.write']);
      const keys = providerSigningKeys(await rs256Key());

      const error = await failureOf(dispatchClientCredentials(request(), client, keys));

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({ error: 'invalid_scope', errorDescription: 'Unsupported scope: reports.write' });
      expect(findUnsupportedScopes).toHaveBeenCalledWith(['reports.read', 'reports.write']);
    });
  });

  describe('Audience', () => {
    // RFC 8707 §2: fail safe, no resource may be named until clientCredentialsAllowedAudiences lists it.
    it('should reject an audience while no audience is allowed with invalid_target', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const error = await failureOf(dispatchClientCredentials(request({ audience: API }), client, keys));

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'invalid_target',
        errorDescription: `Requested audience is not allowed: ${API}`,
        statusCode: 400,
      });
    });

    // RFC 9068 §3: the token names the resource server it is for, and not the UserInfo endpoint it cannot be used at.
    it('should issue the token for an allowed audience only', async () => {
      config.clientCredentialsAllowedAudiences = [API];
      const keys = providerSigningKeys(await rs256Key());

      const response = await dispatchClientCredentials(request({ audience: API }), client, keys);
      const { access_token: accessToken } = (await response!.json()) as { access_token: string };

      expect(decodeJwt(accessToken).payload['aud']).toEqual([API]);
      expect((await stores.accessTokenStore.get(accessToken))!.audience).toEqual([API]);
    });

    it('should reject an audience that is not among the allowed ones with invalid_target', async () => {
      config.clientCredentialsAllowedAudiences = [API];
      const keys = providerSigningKeys(await rs256Key());

      const error = await failureOf(
        dispatchClientCredentials(request({ audience: `${API} https://other.example.com` }), client, keys),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'invalid_target',
        errorDescription: 'Requested audience is not allowed: https://other.example.com',
      });
    });
  });
});
