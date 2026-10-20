import { AuthorizationError, type AuthorizationResponseParams } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, verifyRs256Jwt } from '../../../../test-support/jwt';
import { providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import type { RegisteredClient } from '../../config';
import { createDatabase, registerClient, registerUser } from '../../db';
import { clientResolver, stores } from '../../provider';
import { issueHybridTokens } from './tokens';

// provider.ts keeps its clients, users and stores in the key-value store of
// db/ (in memory for the tests, vitest.config.ts) for the whole file.

/** 2026-01-01T00:00:00Z in Unix seconds: every test runs on this clock. */
const NOW = 1767225600;
const AUTH_TIME = NOW - 30;
const ISSUER = 'https://op.example.com';
const USERINFO = `${ISSUER}/userinfo`;
const CLIENT_ID = 'hybrid-tokens-client';
const REDIRECT_URI = 'https://rp.example.com/callback';
const SUBJECT = 'hybrid-user';
/** RFC 7636 Appendix B: the S256 code_challenge of its example code_verifier. */
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** What completeAuthTransaction() returns for a Hybrid Flow request of the client. */
function responseParamsOf(overrides: Partial<AuthorizationResponseParams> = {}): AuthorizationResponseParams {
  return {
    redirectUri: REDIRECT_URI,
    redirectUriExplicit: true,
    state: 'state-1',
    clientId: CLIENT_ID,
    scope: ['openid', 'profile'],
    nonce: 'nonce-1',
    codeChallenge: CODE_CHALLENGE,
    codeChallengeMethod: 'S256',
    transactionId: 'txn-1',
    ...overrides,
  };
}

/** Issue the code and the tokens of the response type for the End-User, who registered with a name and an email. */
async function issue(
  responseType: string,
  input: { responseParams?: Partial<AuthorizationResponseParams>; grantedScope?: string[] } = {},
) {
  const signingKey = await rs256Key();
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    redirectUris: [REDIRECT_URI],
    responseTypes: ['code id_token token', 'code id_token', 'code token'],
  });
  await registerUser(createDatabase(), { sub: SUBJECT, name: 'Alice', email: 'alice@example.com' });
  const issued = await issueHybridTokens({
    responseType,
    responseParams: responseParamsOf(input.responseParams),
    session: { subject: SUBJECT, authTime: AUTH_TIME, sessionId: 'session-1' },
    grantedScope: input.grantedScope ?? ['openid', 'profile'],
    keys: providerSigningKeys(signingKey),
  });
  return { ...issued, signingKey };
}

/** The left half of the SHA-256 hash of the value, base64url-encoded: at_hash and c_hash for RS256. */
async function leftHalfSha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  let binary = '';
  for (const byte of digest.slice(0, digest.length / 2)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('issueHybridTokens', () => {
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
        state: 'state-1',
      });
    });

    // OIDC Core 1.0 §3.3.2.11: nonce, at_hash and c_hash are REQUIRED in the
    // ID Token of this response type; the claims of the scope values come from
    // the UserInfo endpoint (§5.4).
    it('should bind the ID Token to the code with c_hash and to the access token with at_hash', async () => {
      const { parameters, signingKey } = await issue('code id_token token');

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        iss: ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        at_hash: await leftHalfSha256(parameters['access_token'] ?? ''),
        c_hash: await leftHalfSha256(parameters['code'] ?? ''),
        nonce: 'nonce-1',
        auth_time: AUTH_TIME,
      });
      expect(await verifyRs256Jwt(parameters['id_token'] ?? '', signingKey.publicJwk)).toBe(true);
    });

    // One grant for the code and the tokens: a code replay or a withdrawn
    // consent revokes them together (OAuth 2.1 §4.1.2). The access token is
    // the one the token endpoint would issue (RFC 9068 §2.2).
    it('should store the code and the access token under one grant', async () => {
      const { parameters, grantId, authCodeData } = await issue('code id_token token');

      expect(grantId).toMatch(RANDOM_VALUE);
      expect(authCodeData.grantId).toBe(grantId);
      expect(await stores.authCodeStore.get(parameters['code'] ?? '')).toMatchObject({ grantId, subject: SUBJECT });
      expect(await stores.accessTokenStore.get(parameters['access_token'] ?? '')).toEqual({
        sub: SUBJECT,
        clientId: CLIENT_ID,
        scope: ['openid', 'profile'],
        expiresAt: NOW + 3600,
        grantId,
        iat: NOW,
        nbf: NOW,
        audience: [USERINFO],
        issuer: ISSUER,
        jti: decodeJwt(parameters['access_token'] ?? '').payload['jti'],
      });
    });

    // OIDC Core 1.0 §5.5: claims.id_token asks for individual claims in the ID
    // Token whatever the response type; those of the scope values still come
    // from the UserInfo endpoint (§5.4).
    it('should put only the claims that claims.id_token requests into the ID Token', async () => {
      const { parameters } = await issue('code id_token token', {
        responseParams: { claims: { id_token: { email: null } } },
      });

      const payload = decodeJwt(parameters['id_token'] ?? '').payload;
      expect(payload['email']).toBe('alice@example.com');
      expect(payload).not.toHaveProperty('name');
    });
  });

  describe('code id_token', () => {
    // OIDC Core 1.0 §3.3.2.5 / §3.3.2.11: no access token from the authorization
    // endpoint, c_hash without at_hash. §5.4: the token endpoint issues the
    // access token for the UserInfo endpoint, so the claims of the scope values
    // stay out of the ID Token (unlike response_type=id_token).
    it('should return the code and the ID Token, bound to the code with c_hash, without the claims of the scope values', async () => {
      const { parameters, authCodeData } = await issue('code id_token');

      expect(parameters).toEqual({ code: authCodeData.code, id_token: expect.any(String), state: 'state-1' });
      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        iss: ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        c_hash: await leftHalfSha256(parameters['code'] ?? ''),
        nonce: 'nonce-1',
        auth_time: AUTH_TIME,
      });
    });
  });

  describe('code token', () => {
    // OIDC Core 1.0 §3.3.2.5: no ID Token from the authorization endpoint; the
    // token endpoint issues it for the code. No ID Token signing key is needed.
    it('should return the code and the access token without an ID Token, whatever the ID Token alg the client registered', async () => {
      vi.spyOn(clientResolver, 'findClient').mockResolvedValue({
        clientId: CLIENT_ID,
        redirectUris: [REDIRECT_URI],
        idTokenSignedResponseAlg: 'ES256',
      } as RegisteredClient);

      const { parameters, authCodeData } = await issue('code token', { responseParams: { nonce: undefined } });

      expect(parameters).toEqual({
        code: authCodeData.code,
        access_token: expect.any(String),
        token_type: 'Bearer',
        expires_in: '3600',
        scope: 'openid profile',
        state: 'state-1',
      });
    });
  });

  describe('Stored code', () => {
    // OIDC Core 1.0 §3.1.3.1 / §3.3.3: the code carries the request to the token
    // endpoint as the code flow stores it: the PKCE challenge (RFC 7636), the
    // nonce for the ID Token of the exchange, the OP session the online refresh
    // token is bound to, and the transaction it came from.
    it('should store the code with the request of the transaction, the session and the configured lifetime', async () => {
      const claims = { userinfo: { email: null } };

      const { parameters, grantId } = await issue('code id_token token', {
        responseParams: { claims, acrValues: 'urn:acr:mfa', audience: ['https://api.example.com'] },
      });

      expect(await stores.authCodeStore.get(parameters['code'] ?? '')).toEqual({
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
        nonce: 'nonce-1',
        audience: ['https://api.example.com'],
        acrValues: 'urn:acr:mfa',
        claims,
        sessionId: 'session-1',
      });
    });
  });

  describe('acr / amr', () => {
    // OIDC Core 1.0 §3.1.2.1: the acrResolver of provider.ts echoes the most
    // preferred requested acr value, authenticated with a password.
    it('should put the acr and amr the acrResolver returns into the tokens', async () => {
      const { parameters } = await issue('code id_token token', { responseParams: { acrValues: 'urn:acr:mfa urn:acr:pwd' } });

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toMatchObject({ acr: 'urn:acr:mfa', amr: ['pwd'] });
      expect(await stores.accessTokenStore.get(parameters['access_token'] ?? '')).toMatchObject({ acr: 'urn:acr:mfa' });
    });
  });

  describe('Signing keys', () => {
    // OIDC Dynamic Client Registration 1.0 §2: id_token_signed_response_alg.
    // The key is chosen before the code is stored, so nothing is left behind.
    it('should throw server_error, redirected to the client, and store no code when no ID Token signing key has the registered alg', async () => {
      vi.spyOn(clientResolver, 'findClient').mockResolvedValue({
        clientId: CLIENT_ID,
        redirectUris: [REDIRECT_URI],
        idTokenSignedResponseAlg: 'ES256',
      } as RegisteredClient);
      const authCodeStoreSet = vi.spyOn(stores.authCodeStore, 'set');

      const failure = issue('code id_token');

      await expect(failure).rejects.toBeInstanceOf(AuthorizationError);
      await expect(failure).rejects.toMatchObject({
        error: 'server_error',
        errorDescription: 'No ID Token signing key registered for alg ES256',
        redirectUri: REDIRECT_URI,
        state: 'state-1',
      });
      expect(authCodeStoreSet).not.toHaveBeenCalled();
    });
  });
});
