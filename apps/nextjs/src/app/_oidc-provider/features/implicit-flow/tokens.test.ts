import { AuthorizationError, type AuthorizationResponseParams } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, verifyRs256Jwt } from '../../../../test-support/jwt';
import { providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import type { RegisteredClient } from '../../config';
import { createDatabase, registerClient, registerUser } from '../../db';
import { clientResolver, stores } from '../../provider';
import { issueImplicitTokens } from './tokens';

// provider.ts keeps its clients, users and stores in the key-value store of
// db/ (in memory for the tests, vitest.config.ts) for the whole file.

/** 2026-01-01T00:00:00Z in Unix seconds: every test runs on this clock. */
const NOW = 1767225600;
const AUTH_TIME = NOW - 30;
const ISSUER = 'https://op.example.com';
const USERINFO = `${ISSUER}/userinfo`;
const CLIENT_ID = 'implicit-client';
const REDIRECT_URI = 'https://rp.example.com/callback';
const SUBJECT = 'implicit-user';
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** What completeAuthTransaction() returns for an Implicit Flow request of the client. */
function responseParamsOf(overrides: Partial<AuthorizationResponseParams> = {}): AuthorizationResponseParams {
  return {
    redirectUri: REDIRECT_URI,
    redirectUriExplicit: true,
    state: 'state-1',
    clientId: CLIENT_ID,
    scope: ['openid', 'profile'],
    nonce: 'nonce-1',
    transactionId: 'txn-1',
    ...overrides,
  };
}

/** Issue the tokens of the response type for the End-User, who registered with a name and an email. */
async function issue(
  responseType: string,
  input: { responseParams?: Partial<AuthorizationResponseParams>; grantedScope?: string[] } = {},
) {
  const signingKey = await rs256Key();
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    redirectUris: [REDIRECT_URI],
    responseTypes: ['id_token token', 'id_token'],
  });
  await registerUser(createDatabase(), { sub: SUBJECT, name: 'Alice', email: 'alice@example.com' });
  const issued = await issueImplicitTokens({
    responseType,
    responseParams: responseParamsOf(input.responseParams),
    session: { subject: SUBJECT, authTime: AUTH_TIME },
    grantedScope: input.grantedScope ?? ['openid', 'profile'],
    keys: providerSigningKeys(signingKey),
  });
  return { ...issued, signingKey };
}

/** The left half of the SHA-256 hash of the value, base64url-encoded: at_hash for RS256. */
async function leftHalfSha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  let binary = '';
  for (const byte of digest.slice(0, digest.length / 2)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('issueImplicitTokens', () => {
  describe('id_token token', () => {
    // OIDC Core 1.0 §3.2.2.5: access_token, token_type, id_token, state and
    // expires_in; scope reports the granted scope (RFC 6749 §4.2.2).
    it('should return the access token, its type, lifetime and scope, the ID Token and the state', async () => {
      const { parameters } = await issue('id_token token');

      expect(parameters).toEqual({
        access_token: expect.any(String),
        token_type: 'Bearer',
        expires_in: '3600',
        scope: 'openid profile',
        id_token: expect.any(String),
        state: 'state-1',
      });
    });

    // OIDC Core 1.0 §3.2.2.10: nonce and at_hash are REQUIRED in the ID Token
    // of this response type; the claims of the scope values come from the
    // UserInfo endpoint (§5.4).
    it('should bind the ID Token to the access token with at_hash and carry the nonce and auth_time', async () => {
      const { parameters, signingKey } = await issue('id_token token');

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        iss: ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        at_hash: await leftHalfSha256(parameters['access_token'] ?? ''),
        nonce: 'nonce-1',
        auth_time: AUTH_TIME,
      });
      expect(await verifyRs256Jwt(parameters['id_token'] ?? '', signingKey.publicJwk)).toBe(true);
    });

    // The UserInfo, introspection and revocation endpoints look the access token up.
    it('should store the access token with its grant for the granted scope', async () => {
      const { parameters, grantId } = await issue('id_token token');

      expect(grantId).toMatch(RANDOM_VALUE);
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

    // The transaction store records that the transaction ended in issued tokens.
    it('should record that the transaction issued its tokens', async () => {
      const recordTokenIssued = vi.spyOn(stores.transactionStore, 'recordTokenIssued');

      await issue('id_token token');

      expect(recordTokenIssued.mock.calls).toEqual([['txn-1']]);
    });
  });

  describe('id_token', () => {
    // OIDC Core 1.0 §3.2.2.5 / §5.4: only the ID Token and the state, and the
    // ID Token carries the claims of the granted scope values; no at_hash.
    it('should return the ID Token with the claims of the granted scope values and the state', async () => {
      const { parameters } = await issue('id_token');

      expect(parameters).toEqual({ id_token: expect.any(String), state: 'state-1' });
      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        name: 'Alice',
        iss: ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        nonce: 'nonce-1',
        auth_time: AUTH_TIME,
      });
    });
  });

  // OIDC Core 1.0 §5.5: the id_token member of the claims parameter requests
  // claims to be added to the ID Token, whatever the scope and the response type.
  describe('claims parameter', () => {
    it('should add the claims requested by claims.id_token to the ID Token of id_token', async () => {
      const { parameters } = await issue('id_token', {
        responseParams: { scope: ['openid'], claims: { id_token: { name: { essential: true } } } },
        grantedScope: ['openid'],
      });

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        name: 'Alice',
        iss: ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        nonce: 'nonce-1',
        auth_time: AUTH_TIME,
      });
    });

    // The claims of the scope values stay with the UserInfo endpoint (§5.4);
    // the claim requested for the ID Token is added to it.
    it('should add only the claims requested by claims.id_token to the ID Token of id_token token', async () => {
      const { parameters } = await issue('id_token token', {
        responseParams: { claims: { id_token: { email: null } } },
      });

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        email: 'alice@example.com',
        iss: ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        at_hash: await leftHalfSha256(parameters['access_token'] ?? ''),
        nonce: 'nonce-1',
        auth_time: AUTH_TIME,
      });
    });

    // The userinfo member asks the UserInfo endpoint for the claims (§5.5).
    it('should leave the claims requested by claims.userinfo out of the ID Token', async () => {
      const { parameters } = await issue('id_token token', {
        responseParams: { claims: { userinfo: { email: { essential: true } } } },
      });

      expect(decodeJwt(parameters['id_token'] ?? '').payload).not.toHaveProperty('email');
    });
  });

  describe('acr / amr', () => {
    // OIDC Core 1.0 §3.1.2.1: the acrResolver of provider.ts echoes the most
    // preferred requested acr value, authenticated with a password.
    it('should put the acr and amr the acrResolver returns into the ID Token', async () => {
      const { parameters } = await issue('id_token', { responseParams: { acrValues: 'urn:acr:mfa urn:acr:pwd' } });

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toMatchObject({ acr: 'urn:acr:mfa', amr: ['pwd'] });
    });
  });

  describe('Signing keys', () => {
    // OIDC Dynamic Client Registration 1.0 §2: id_token_signed_response_alg.
    it('should throw server_error, redirected to the client, when no ID Token signing key has the registered alg', async () => {
      vi.spyOn(clientResolver, 'findClient').mockResolvedValue({
        clientId: CLIENT_ID,
        redirectUris: [REDIRECT_URI],
        idTokenSignedResponseAlg: 'ES256',
      } as RegisteredClient);

      const failure = issue('id_token');

      await expect(failure).rejects.toBeInstanceOf(AuthorizationError);
      await expect(failure).rejects.toMatchObject({
        error: 'server_error',
        errorDescription: 'No ID Token signing key registered for alg ES256',
        redirectUri: REDIRECT_URI,
        state: 'state-1',
      });
    });
  });
});
