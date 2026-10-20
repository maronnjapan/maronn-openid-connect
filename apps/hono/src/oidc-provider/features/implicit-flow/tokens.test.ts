import { AuthorizationError, type AuthorizationResponseParams } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ID,
  NONCE,
  REDIRECT_URI,
  STATE,
  SUBJECT,
  TRANSACTION_ID,
  registerTestClient,
} from '../../../test-support/authorize.js';
import { TEST_ISSUER, providerContext } from '../../../test-support/context.js';
import { decodeJwt, leftHalfSha256, NOW, verifiesWith } from '../../../test-support/token.js';
import type { OidcProviderOptions } from '../../app.js';
import type { ClientRegistration } from '../../config.js';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { createProviderStores } from '../../db/memory/stores.js';
import { registerUser } from '../../db/memory/users.js';
import { issueImplicitTokens } from './tokens.js';

const AUTH_TIME = NOW - 30;
const USERINFO_ENDPOINT = `${TEST_ISSUER}/userinfo`;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;

/** What completeAuthTransaction() returns for an Implicit Flow request of the test client. */
function responseParamsOf(overrides: Partial<AuthorizationResponseParams> = {}): AuthorizationResponseParams {
  return {
    redirectUri: REDIRECT_URI,
    redirectUriExplicit: true,
    state: STATE,
    clientId: CLIENT_ID,
    scope: ['openid', 'profile'],
    nonce: NONCE,
    transactionId: TRANSACTION_ID,
    ...overrides,
  };
}

/** Issue the tokens of the response type for alice, who registered with a name and an email. */
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
  const issued = await issueImplicitTokens(context.c, {
    responseType,
    responseParams: responseParamsOf(input.responseParams),
    session: { subject: SUBJECT, authTime: AUTH_TIME },
    grantedScope: input.grantedScope ?? ['openid', 'profile'],
  });
  return { ...context, ...issued };
}

describe('issueImplicitTokens', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
        state: STATE,
      });
    });

    // OIDC Core 1.0 §3.2.2.10: nonce and at_hash are REQUIRED in the ID Token
    // of this response type.
    it('should bind the ID Token to the access token with at_hash and carry the nonce and auth_time', async () => {
      const { parameters, signingKey } = await issue('id_token token');

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        at_hash: await leftHalfSha256(parameters['access_token'] ?? ''),
        nonce: NONCE,
        auth_time: AUTH_TIME,
      });
      expect(await verifiesWith(parameters['id_token'] ?? '', signingKey)).toBe(true);
    });

    // RFC 9068 §2.2: the access token is the JWT the token endpoint issues for a code.
    it('should issue an at+jwt access token for the granted scope', async () => {
      const { parameters, signingKey } = await issue('id_token token');

      const accessToken = decodeJwt(parameters['access_token'] ?? '');
      expect(accessToken.header).toEqual({ alg: 'RS256', typ: 'at+jwt', kid: 'test-rs256-key' });
      expect(accessToken.payload).toEqual({
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: [USERINFO_ENDPOINT],
        exp: NOW + 3600,
        iat: NOW,
        nbf: NOW,
        jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        scope: 'openid profile',
        client_id: CLIENT_ID,
      });
      expect(await verifiesWith(parameters['access_token'] ?? '', signingKey)).toBe(true);
    });

    // The UserInfo, introspection and revocation endpoints look the access
    // token up; it names the grant and the transaction it was issued from.
    it('should store the access token with its grant, the claims request and the transaction', async () => {
      const claims = { userinfo: { email: null } };

      const { db, parameters, grantId } = await issue('id_token token', { responseParams: { claims } });

      expect(grantId).toMatch(RANDOM_VALUE);
      expect([...db.accessTokens.entries()]).toEqual([
        [
          parameters['access_token'],
          {
            sub: SUBJECT,
            clientId: CLIENT_ID,
            scope: ['openid', 'profile'],
            expiresAt: NOW + 3600,
            grantId,
            iat: NOW,
            nbf: NOW,
            audience: [USERINFO_ENDPOINT],
            issuer: TEST_ISSUER,
            jti: decodeJwt(parameters['access_token'] ?? '').payload['jti'],
            claims,
            acr: undefined,
            transactionId: TRANSACTION_ID,
          },
        ],
      ]);
    });

    // RFC 6749 §4.2.2: the implicit grant issues no refresh token, so
    // offline_access in the granted scope changes nothing.
    it('should issue no refresh token', async () => {
      const { db, parameters } = await issue('id_token token', { grantedScope: ['openid', 'offline_access'] });

      expect(Object.keys(parameters)).toEqual(['access_token', 'token_type', 'expires_in', 'scope', 'id_token', 'state']);
      expect(db.refreshTokens.size).toBe(0);
    });

    it('should issue an opaque access token when the provider settings ask for one', async () => {
      const { db, parameters } = await issue('id_token token', { options: { config: { accessTokenFormat: 'opaque' } } });

      expect(parameters['access_token']).toMatch(RANDOM_VALUE);
      expect([...db.accessTokens.keys()]).toEqual([parameters['access_token']]);
    });

    // OIDC Core 1.0 §5.4: the claims of the scope values come from the
    // UserInfo endpoint, which the access token reaches.
    it('should leave the claims of the scope values out of the ID Token', async () => {
      const { parameters } = await issue('id_token token');

      expect(decodeJwt(parameters['id_token'] ?? '').payload).not.toHaveProperty('name');
    });

    // OIDC Core 1.0 §5.5: claims.id_token asks for individual claims in the ID
    // Token whatever the response type; those of the scope values still come
    // from the UserInfo endpoint (§5.4).
    it('should put only the claims that claims.id_token requests into the ID Token', async () => {
      const { parameters } = await issue('id_token token', {
        responseParams: { claims: { id_token: { email: null } } },
      });

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        at_hash: await leftHalfSha256(parameters['access_token'] ?? ''),
        nonce: NONCE,
        auth_time: AUTH_TIME,
        email: 'alice@example.com',
      });
    });
  });

  describe('id_token', () => {
    // OIDC Core 1.0 §3.2.2.5: only the ID Token and the state.
    it('should return the ID Token and the state without an access token', async () => {
      const { db, parameters } = await issue('id_token');

      expect(parameters).toEqual({ id_token: expect.any(String), state: STATE });
      expect(db.accessTokens.size).toBe(0);
    });

    // OIDC Core 1.0 §5.4: with no access token for the UserInfo endpoint, the
    // claims of the scope values go into the ID Token; no at_hash (§3.2.2.10).
    it('should put the claims of the granted scope values into the ID Token', async () => {
      const { parameters } = await issue('id_token');

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        name: 'Alice',
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        nonce: NONCE,
        auth_time: AUTH_TIME,
      });
    });

    // OIDC Core 1.0 §5.5: claims.id_token asks for a claim the scope does not
    // cover (OIDF oidcc-claims-essential requests name with scope=openid).
    it('should put the claims that claims.id_token requests into the ID Token', async () => {
      const { parameters } = await issue('id_token', {
        grantedScope: ['openid'],
        responseParams: { scope: ['openid'], claims: { id_token: { name: { essential: true } } } },
      });

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        nonce: NONCE,
        auth_time: AUTH_TIME,
        name: 'Alice',
      });
    });

    it('should issue the ID Token without user claims when the End-User has none', async () => {
      const { c, db } = await providerContext();
      await registerTestClient(db);

      const { parameters } = await issueImplicitTokens(c, {
        responseType: 'id_token',
        responseParams: responseParamsOf(),
        session: { subject: 'unknown-user', authTime: AUTH_TIME },
        grantedScope: ['openid', 'profile'],
      });

      expect(decodeJwt(parameters['id_token'] ?? '').payload).toEqual({
        iss: TEST_ISSUER,
        sub: 'unknown-user',
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        nonce: NONCE,
        auth_time: AUTH_TIME,
      });
    });
  });

  describe('acr / amr', () => {
    // OIDC Core 1.0 §2: the acrResolver of the app decides acr and amr.
    it('should put the acr and amr the acrResolver returns into the tokens', async () => {
      const acrResolver = vi.fn(async () => ({ acr: 'urn:acr:mfa', amr: ['pwd', 'otp'] }));

      const { db, parameters } = await issue('id_token token', {
        options: { acrResolver },
        responseParams: { acrValues: 'urn:acr:mfa urn:acr:pwd' },
      });

      expect(acrResolver.mock.calls).toEqual([
        [{ userId: SUBJECT, clientId: CLIENT_ID, requestedAcrValues: 'urn:acr:mfa urn:acr:pwd' }],
      ]);
      expect(decodeJwt(parameters['id_token'] ?? '').payload).toMatchObject({ acr: 'urn:acr:mfa', amr: ['pwd', 'otp'] });
      expect([...db.accessTokens.values()].map((record) => record.acr)).toEqual(['urn:acr:mfa']);
    });

    // OIDC Core 1.0 §3.1.2.1: acr_values lists the values in order of preference.
    it('should put the most preferred requested acr into the ID Token without an acrResolver', async () => {
      const { parameters } = await issue('id_token', { responseParams: { acrValues: 'urn:acr:mfa urn:acr:pwd' } });

      expect(decodeJwt(parameters['id_token'] ?? '').payload['acr']).toBe('urn:acr:mfa');
      expect(decodeJwt(parameters['id_token'] ?? '').payload).not.toHaveProperty('amr');
    });
  });

  describe('Signing keys', () => {
    // OIDC Dynamic Client Registration 1.0 §2: id_token_signed_response_alg.
    it('should throw server_error, redirected to the client, when no ID Token signing key has the registered alg', async () => {
      const failure = issue('id_token', { client: { idTokenSignedResponseAlg: 'ES256' } });

      await expect(failure).rejects.toBeInstanceOf(AuthorizationError);
      await expect(failure).rejects.toMatchObject({
        error: 'server_error',
        errorDescription: 'No ID Token signing key registered for alg ES256',
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
    });
  });

  describe('Transaction', () => {
    // The stores of db/ record that the transaction ended in issued tokens.
    it('should record that the transaction issued its tokens', async () => {
      const stores = createProviderStores(createEmptyDatabase());
      const recordTokenIssued = vi.fn(async () => undefined);

      await issue('id_token', { options: { storage: { ...stores, transactionStore: { ...stores.transactionStore, recordTokenIssued } } } });

      expect(recordTokenIssued.mock.calls).toEqual([[TRANSACTION_ID]]);
    });

    it('should record nothing when the response has no transaction', async () => {
      const stores = createProviderStores(createEmptyDatabase());
      const recordTokenIssued = vi.fn(async () => undefined);

      await issue('id_token', {
        options: { storage: { ...stores, transactionStore: { ...stores.transactionStore, recordTokenIssued } } },
        responseParams: { transactionId: undefined },
      });

      expect(recordTokenIssued.mock.calls).toEqual([]);
    });
  });
});
