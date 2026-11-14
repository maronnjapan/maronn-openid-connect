import { TokenError, type TokenClientInfo } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext, TEST_ISSUER } from '../../../../test-support/context.js';
import { decodeJwt } from '../../../../test-support/extensions.js';
import type { ProviderConfig } from '../../../config.js';
import type { TokenRequestBody } from '../../../endpoints/token/response.js';
import { findUnsupportedScopes } from '../../../scopes.js';
import { issueClientCredentialsToken } from './dispatch-client-credentials.js';

// The provider declares no custom scope (CUSTOM_SCOPES in scopes.ts is
// empty), so the allow-list check never rejects anything. It is replaced by
// a spy that behaves the same until a test says otherwise.
vi.mock('../../../scopes.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../scopes.js')>();
  return { ...original, findUnsupportedScopes: vi.fn(original.findUnsupportedScopes) };
});

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW = Date.UTC(2026, 0, 1) / 1000;
const API = 'https://api.example.com';

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
  vi.useRealTimers();
  vi.mocked(findUnsupportedScopes).mockClear();
});

function request(fields: Record<string, string> = {}): TokenRequestBody {
  return { grant_type: 'client_credentials', ...fields } as TokenRequestBody;
}

function context(config: Partial<ProviderConfig> = {}) {
  return providerContext({ options: { config } });
}

/** The TokenError the step fails with. */
async function failureOf(promise: Promise<unknown>): Promise<TokenError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  return error as TokenError;
}

describe('issueClientCredentialsToken', () => {
  it('should leave a request of another grant to the next step', async () => {
    const { c } = await context();

    expect(
      await issueClientCredentialsToken(c, { grant_type: 'authorization_code' } as TokenRequestBody, client),
    ).toBeUndefined();
  });

  describe('Token response', () => {
    // RFC 6749 §4.4.3 / §5.1: access_token, token_type, expires_in and scope; no refresh_token.
    it('should answer an access token for the requested scope without a refresh token or an ID Token', async () => {
      const { c } = await context();

      const response = await issueClientCredentialsToken(c, request({ scope: 'reports.read' }), client);

      const { access_token: accessToken, ...body } = (await response!.json()) as Record<string, unknown>;
      expect(response!.status).toBe(200);
      expect(response!.headers.get('Cache-Control')).toBe('no-store');
      expect(response!.headers.get('Pragma')).toBe('no-cache');
      expect(typeof accessToken).toBe('string');
      expect(body).toEqual({ token_type: 'Bearer', expires_in: 3600, scope: 'reports.read' });
    });

    // RFC 9068 §2.2: the sub of a token no resource owner is involved in names the client.
    it('should issue a JWT whose sub and client_id are the client and whose aud is the issuer', async () => {
      const { c } = await context();

      const response = await issueClientCredentialsToken(c, request({ scope: 'reports.read' }), client);

      const { access_token: accessToken } = (await response!.json()) as { access_token: string };
      const { header, payload } = decodeJwt(accessToken);
      expect(header).toMatchObject({ alg: 'RS256', typ: 'at+jwt' });
      expect(payload).toEqual({
        iss: TEST_ISSUER,
        sub: 'service-1',
        aud: [TEST_ISSUER],
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
      const { c, stores } = await context();

      const response = await issueClientCredentialsToken(c, request({ scope: 'reports.read' }), client);

      const { access_token: accessToken } = (await response!.json()) as { access_token: string };
      expect(await stores.accessTokenStore.get(accessToken)).toEqual({
        sub: 'service-1',
        clientId: 'service-1',
        scope: ['reports.read'],
        expiresAt: NOW + 3600,
        iat: NOW,
        nbf: NOW,
        audience: [TEST_ISSUER],
        issuer: TEST_ISSUER,
        jti: decodeJwt(accessToken).payload['jti'],
      });
    });

    it('should issue an opaque token when accessTokenFormat is opaque', async () => {
      const { c, stores } = await context({ accessTokenFormat: 'opaque' });

      const response = await issueClientCredentialsToken(c, request(), client);

      const { access_token: accessToken } = (await response!.json()) as { access_token: string };
      expect(accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await stores.accessTokenStore.get(accessToken)).toMatchObject({ sub: 'service-1', clientId: 'service-1' });
    });
  });

  describe('Client', () => {
    // RFC 7591 §2: grant_types defaults to ["authorization_code"].
    it('should reject a client that did not register the grant with unauthorized_client', async () => {
      const { c, db } = await context();

      const error = await failureOf(
        issueClientCredentialsToken(c, request(), { ...client, grantTypes: ['authorization_code'] }),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'unauthorized_client',
        errorDescription: 'Client is not authorized to use grant_type: client_credentials',
        statusCode: 400,
      });
      expect(db.accessTokens.size).toBe(0);
    });

    // RFC 6749 §4.4: the grant MUST only be used by confidential clients.
    it('should reject a public client with unauthorized_client', async () => {
      const { c, db } = await context();

      const error = await failureOf(
        issueClientCredentialsToken(c, request(), { ...client, tokenEndpointAuthMethods: ['none'] }),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'unauthorized_client',
        errorDescription: 'The client_credentials grant is only available to confidential clients',
      });
      expect(db.accessTokens.size).toBe(0);
    });
  });

  describe('Scope', () => {
    // RFC 6749 §3.3: a request without scope gets the pre-defined default, the scopes the client registered.
    it('should issue every registered scope when the request names none', async () => {
      const { c } = await context();

      const response = await issueClientCredentialsToken(c, request(), client);

      expect(await response!.json()).toMatchObject({ scope: 'reports.read reports.write' });
    });

    it('should leave scope out of the response and the token for a client without registered scopes', async () => {
      const { c, stores } = await context();
      const { scope: _scope, ...withoutScope } = client;

      const response = await issueClientCredentialsToken(c, request(), withoutScope);

      const { access_token: accessToken, ...body } = (await response!.json()) as Record<string, unknown>;
      expect(body).toEqual({ token_type: 'Bearer', expires_in: 3600 });
      expect(decodeJwt(accessToken as string).payload).not.toHaveProperty('scope');
      expect((await stores.accessTokenStore.get(accessToken as string))!.scope).toEqual([]);
    });

    // RFC 7591 §2: no End-User consents here, so only the registered scopes are issued.
    it('should reject a scope the client did not register with invalid_scope', async () => {
      const { c, db } = await context();

      const error = await failureOf(issueClientCredentialsToken(c, request({ scope: 'reports.read admin' }), client));

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'invalid_scope',
        errorDescription: 'Client is not registered for scope: admin',
        statusCode: 400,
      });
      expect(db.accessTokens.size).toBe(0);
    });

    it('should reject every requested scope of a client without registered scopes with invalid_scope', async () => {
      const { c } = await context();
      const { scope: _scope, ...withoutScope } = client;

      const error = await failureOf(issueClientCredentialsToken(c, request({ scope: 'reports.read' }), withoutScope));

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({ error: 'invalid_scope' });
    });

    // OIDC Core 1.0 §3.1.2.1: openid stands for the authentication of an End-User.
    it('should reject openid with invalid_scope even when the client registered it', async () => {
      const { c } = await context();

      const error = await failureOf(
        issueClientCredentialsToken(c, request({ scope: 'openid reports.read' }), {
          ...client,
          scope: ['openid', 'reports.read'],
        }),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'invalid_scope',
        errorDescription: 'Scope is not available for the client_credentials grant: openid',
      });
    });

    it('should leave openid and offline_access out of the default scope', async () => {
      const { c } = await context();

      const response = await issueClientCredentialsToken(c, request(), {
        ...client,
        scope: ['openid', 'offline_access', 'reports.read'],
      });

      expect(await response!.json()).toMatchObject({ scope: 'reports.read' });
    });

    // RFC 6749 §3.3: a scope the provider did not declare (scopes.ts) is refused, as at /authorize.
    it('should reject a scope the provider does not accept with invalid_scope', async () => {
      vi.mocked(findUnsupportedScopes).mockReturnValueOnce(['reports.write']);
      const { c } = await context();

      const error = await failureOf(issueClientCredentialsToken(c, request(), client));

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({ error: 'invalid_scope', errorDescription: 'Unsupported scope: reports.write' });
      expect(findUnsupportedScopes).toHaveBeenCalledWith(['reports.read', 'reports.write']);
    });
  });

  describe('Audience', () => {
    // RFC 8707 §2: fail safe, no resource may be named until clientCredentialsAllowedAudiences lists it.
    it('should reject an audience while no audience is allowed with invalid_target', async () => {
      const { c, db } = await context();

      const error = await failureOf(issueClientCredentialsToken(c, request({ audience: API }), client));

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'invalid_target',
        errorDescription: `Requested audience is not allowed: ${API}`,
        statusCode: 400,
      });
      expect(db.accessTokens.size).toBe(0);
    });

    // RFC 9068 §3: the token names the resource server it is for, and not the UserInfo endpoint it cannot be used at.
    it('should issue the token for an allowed audience only', async () => {
      const { c, stores } = await context({ clientCredentialsAllowedAudiences: [API] });

      const response = await issueClientCredentialsToken(c, request({ audience: API }), client);

      const { access_token: accessToken } = (await response!.json()) as { access_token: string };
      expect(decodeJwt(accessToken).payload['aud']).toEqual([API]);
      expect((await stores.accessTokenStore.get(accessToken))!.audience).toEqual([API]);
    });

    it('should reject an audience that is not among the allowed ones with invalid_target', async () => {
      const { c } = await context({ clientCredentialsAllowedAudiences: [API] });

      const error = await failureOf(
        issueClientCredentialsToken(c, request({ audience: `${API} https://other.example.com` }), client),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: 'invalid_target',
        errorDescription: 'Requested audience is not allowed: https://other.example.com',
      });
    });
  });
});
