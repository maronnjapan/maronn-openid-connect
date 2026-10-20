import { AuthorizationError, type AuthorizationResponseParams } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ID,
  CODE_CHALLENGE,
  NONCE,
  REDIRECT_URI,
  SESSION_ID,
  STATE,
  SUBJECT,
  TRANSACTION_ID,
  registerTestClient,
} from '../../../test-support/authorize.js';
import { TEST_ISSUER, providerContext } from '../../../test-support/context.js';
import { decodeJwt, leftHalfSha256, NOW, verifiesWith } from '../../../test-support/token.js';
import type { OidcProviderOptions } from '../../app.js';
import type { ClientRegistration } from '../../config.js';
import { registerUser } from '../../db/memory/users.js';
import { issueHybridTokens } from './tokens.js';

const AUTH_TIME = NOW - 30;
const USERINFO_ENDPOINT = `${TEST_ISSUER}/userinfo`;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;

/** What completeAuthTransaction() returns for a Hybrid Flow request of the test client. */
function responseParamsOf(overrides: Partial<AuthorizationResponseParams> = {}): AuthorizationResponseParams {
  return {
    redirectUri: REDIRECT_URI,
    redirectUriExplicit: true,
    state: STATE,
    clientId: CLIENT_ID,
    scope: ['openid', 'profile'],
    nonce: NONCE,
    codeChallenge: CODE_CHALLENGE,
    codeChallengeMethod: 'S256',
    transactionId: TRANSACTION_ID,
    ...overrides,
  };
}

/** Issue the code and the tokens of the response type for alice, who registered with a name and an email. */
async function issue(
  responseType: string,
  input: {
    options?: Partial<OidcProviderOptions>;
    responseParams?: Partial<AuthorizationResponseParams>;
    grantedScope?: string[];
    client?: Partial<ClientRegistration>;
  } = {},
) {
  const context = await providerContext({ options: input.options });
  await registerTestClient(context.db, input.client);
  await registerUser(context.db, { sub: SUBJECT, name: 'Alice', email: 'alice@example.com' });
  const issued = await issueHybridTokens(context.c, {
    responseType,
    responseParams: responseParamsOf(input.responseParams),
    session: { subject: SUBJECT, authTime: AUTH_TIME, sessionId: SESSION_ID },
    grantedScope: input.grantedScope ?? ['openid', 'profile'],
  });
  return { ...context, ...issued };
}

describe('issueHybridTokens', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('code id_token token', () => {
    // OIDC Core 1.0 §3.3.2.5: the code with access_token, token_type,
    // expires_in, id_token and state; scope reports the granted scope (RFC 6749 §4.2.2).
    it('should return the code, the access token, its type, lifetime and scope, the ID Token and the state', async () => {
      const { parameters, authCodeData } = await issue('code id_token token');

      expect(parameters).toEqual({
        code: authCodeData.code,
        access_token: expect.any(String),
        token_type: 'Bearer',
        expires_in: '3600',
        scope: 'openid profile',
        id_token: expect.any(String),
        state: STATE,
      });
    });

    // OIDC Core 1.0 §3.3.2.11: nonce, at_hash and c_hash are REQUIRED in the
    // ID Token of this response type; the claims of the scope values come from
    // the UserInfo endpoint (§5.4).
    it('should bind the ID Token to the code with c_hash and to the access token with at_hash', async () => {
      const { parameters, signingKey } = await issue('code id_token token');

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        at_hash: await leftHalfSha256(parameters['access_token'] ?? ''),
        c_hash: await leftHalfSha256(parameters['code'] ?? ''),
        nonce: NONCE,
        auth_time: AUTH_TIME,
      });
      expect(await verifiesWith(parameters['id_token'] ?? '', signingKey)).toBe(true);
    });

    // One grant for the code and the tokens: a code replay or a withdrawn
    // consent revokes them together (OAuth 2.1 §4.1.2).
    it('should store the code and the access token under one grant', async () => {
      const { db, parameters, grantId, authCodeData } = await issue('code id_token token');

      expect(grantId).toMatch(RANDOM_VALUE);
      expect(authCodeData.grantId).toBe(grantId);
      expect([...db.codes.keys()]).toEqual([parameters['code']]);
      expect([...db.accessTokens.values()].map((record) => record.grantId)).toEqual([grantId]);
    });

    // RFC 9068 §2.2: the access token is the JWT the token endpoint issues for a code.
    it('should issue an at+jwt access token for the granted scope', async () => {
      const { parameters, signingKey } = await issue('code id_token token');

      const accessToken = decodeJwt(parameters['access_token'] ?? '');
      expect(accessToken.header).toEqual({ alg: 'RS256', typ: 'at+jwt', kid: 'test-rs256-key' });
      expect(accessToken.payload).toMatchObject({
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: [USERINFO_ENDPOINT],
        exp: NOW + 3600,
        iat: NOW,
        scope: 'openid profile',
        client_id: CLIENT_ID,
      });
      expect(await verifiesWith(parameters['access_token'] ?? '', signingKey)).toBe(true);
    });

    // OIDC Core 1.0 §5.5: claims.id_token asks for individual claims in the ID
    // Token whatever the response type; those of the scope values still come
    // from the UserInfo endpoint (§5.4).
    it('should put only the claims that claims.id_token requests into the ID Token', async () => {
      const { parameters } = await issue('code id_token token', {
        responseParams: { claims: { id_token: { email: null } } },
      });

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toMatchObject({ email: 'alice@example.com' });
      expect(decodeJwt(parameters['id_token'] ?? '').payload).not.toHaveProperty('name');
    });
  });

  describe('code id_token', () => {
    // OIDC Core 1.0 §3.3.2.5: no access token from the authorization endpoint.
    it('should return the code, the ID Token and the state without an access token', async () => {
      const { db, parameters, authCodeData } = await issue('code id_token');

      expect(parameters).toEqual({ code: authCodeData.code, id_token: expect.any(String), state: STATE });
      expect(db.accessTokens.size).toBe(0);
    });

    // OIDC Core 1.0 §3.3.2.11: c_hash without at_hash. §5.4: the token endpoint
    // issues the access token for the UserInfo endpoint, so the claims of the
    // scope values stay out of the ID Token (unlike response_type=id_token).
    it('should bind the ID Token to the code with c_hash and leave the claims of the scope values out', async () => {
      const { parameters } = await issue('code id_token');

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        c_hash: await leftHalfSha256(parameters['code'] ?? ''),
        nonce: NONCE,
        auth_time: AUTH_TIME,
      });
    });
  });

  describe('code token', () => {
    // OIDC Core 1.0 §3.3.2.5: no ID Token from the authorization endpoint; the
    // token endpoint issues it for the code.
    it('should return the code, the access token, its type, lifetime and scope, and the state without an ID Token', async () => {
      const { parameters, authCodeData } = await issue('code token', { responseParams: { nonce: undefined } });

      expect(parameters).toEqual({
        code: authCodeData.code,
        access_token: expect.any(String),
        token_type: 'Bearer',
        expires_in: '3600',
        scope: 'openid profile',
        state: STATE,
      });
    });

    // No ID Token signing key is needed: a client registered for an alg the OP
    // has no key for still gets its code and access token.
    it('should issue the code and the access token whatever the ID Token alg the client registered', async () => {
      const { parameters } = await issue('code token', { client: { idTokenSignedResponseAlg: 'ES256' } });

      expect(Object.keys(parameters)).toEqual(['code', 'access_token', 'token_type', 'expires_in', 'scope', 'state']);
    });
  });

  describe('Stored code', () => {
    // OIDC Core 1.0 §3.1.3.1 / §3.3.3: the code carries the request to the token
    // endpoint as the issue-authorization-code steps store it: the PKCE challenge
    // (RFC 7636), the nonce for the ID Token of the exchange, the OP session the
    // online refresh token is bound to, and the transaction it came from.
    it('should store the code with the request of the transaction, the session and the configured lifetime', async () => {
      const claims = { userinfo: { email: null } };

      const { db, parameters, grantId } = await issue('code id_token token', {
        responseParams: { claims, acrValues: 'urn:acr:mfa', audience: ['https://api.example.com'] },
      });

      expect([...db.codes.values()]).toEqual([
        {
          code: parameters['code'],
          grantId,
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          redirectUriExplicit: true,
          scope: ['openid', 'profile'],
          subject: SUBJECT,
          used: false,
          expiresAt: NOW + 300,
          authTime: AUTH_TIME,
          codeChallenge: CODE_CHALLENGE,
          codeChallengeMethod: 'S256',
          nonce: NONCE,
          audience: ['https://api.example.com'],
          acrValues: 'urn:acr:mfa',
          claims,
          sessionId: SESSION_ID,
          transactionId: TRANSACTION_ID,
        },
      ]);
    });

    // RFC 6749 §4.2.2: the authorization endpoint issues no refresh token; the
    // token endpoint does, for the code, under the offline_access rules of the
    // code flow (the scope keeps offline_access when the policy granted it).
    it('should issue no refresh token and keep offline_access for the token endpoint', async () => {
      const { db, parameters } = await issue('code token', { grantedScope: ['openid', 'offline_access'] });

      expect(parameters['scope']).toBe('openid offline_access');
      expect(db.refreshTokens.size).toBe(0);
      expect([...db.codes.values()].map((record) => record.scope)).toEqual([['openid', 'offline_access']]);
    });
  });

  describe('acr / amr', () => {
    // OIDC Core 1.0 §2: the acrResolver of the app decides acr and amr.
    it('should put the acr and amr the acrResolver returns into the tokens', async () => {
      const acrResolver = vi.fn(async () => ({ acr: 'urn:acr:mfa', amr: ['pwd', 'otp'] }));

      const { db, parameters } = await issue('code id_token token', {
        options: { acrResolver },
        responseParams: { acrValues: 'urn:acr:mfa urn:acr:pwd' },
      });

      expect(acrResolver.mock.calls).toEqual([
        [{ userId: SUBJECT, clientId: CLIENT_ID, requestedAcrValues: 'urn:acr:mfa urn:acr:pwd' }],
      ]);
      expect(decodeJwt(parameters['id_token'] ?? '').payload).toMatchObject({ acr: 'urn:acr:mfa', amr: ['pwd', 'otp'] });
      expect([...db.accessTokens.values()].map((record) => record.acr)).toEqual(['urn:acr:mfa']);
    });
  });

  describe('Signing keys', () => {
    // OIDC Dynamic Client Registration 1.0 §2: id_token_signed_response_alg.
    // The key is chosen before the code is stored, so nothing is left behind.
    it('should throw server_error, redirected to the client, and store no code when no ID Token signing key has the registered alg', async () => {
      const { c, db } = await providerContext();
      await registerTestClient(db, { idTokenSignedResponseAlg: 'ES256' });

      const failure = issueHybridTokens(c, {
        responseType: 'code id_token',
        responseParams: responseParamsOf(),
        session: { subject: SUBJECT, authTime: AUTH_TIME },
        grantedScope: ['openid'],
      });

      await expect(failure).rejects.toBeInstanceOf(AuthorizationError);
      await expect(failure).rejects.toMatchObject({
        error: 'server_error',
        errorDescription: 'No ID Token signing key registered for alg ES256',
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
      expect(db.codes.size).toBe(0);
    });
  });
});
