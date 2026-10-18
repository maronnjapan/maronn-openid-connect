import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { rs256Key, staticKeyProvider } from '../../../test-support/keys.js';
import {
  AUTH_TIME,
  CLIENT_ID,
  CLIENT_SECRET,
  NOW,
  REDIRECT_URI,
  SUBJECT,
  basicAuthorization,
  confidentialClient,
  decodeJwt,
  leftHalfSha256,
  storedAuthorizationCode,
} from '../../../test-support/token.js';
import { createApp } from '../../app.js';
import { createClientKeyResolver, createClientResolver, registerClient } from '../../db/memory/clients.js';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { createProviderStores } from '../../db/memory/stores.js';

// RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge.
const CODE_VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CODE_CHALLENGE = 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU';
const USERINFO_ENDPOINT = `${TEST_ISSUER}/userinfo`;
// The default refreshTokenAbsoluteLifetime of config.ts: 90 days.
const REFRESH_TOKEN_LIFETIME = 7776000;

interface TokenResponseBody {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token?: string;
  scope: string;
  refresh_token?: string;
}

/** The provider of createApp() on an in-memory database, with client-1 registered and code-1 stored. */
async function provider(scope: string[]) {
  const db = createEmptyDatabase();
  const stores = createProviderStores(db);
  await registerClient(db, confidentialClient());
  await stores.authCodeStore.set(
    'code-1',
    storedAuthorizationCode({ scope, codeChallenge: CODE_CHALLENGE, codeChallengeMethod: 'S256' }),
  );
  const app = createApp({
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: stores,
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    config: { issuer: TEST_ISSUER },
  });
  const post = (fields: Record<string, string>, secret = CLIENT_SECRET) =>
    app.request(`${TEST_ISSUER}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthorization(CLIENT_ID, secret),
      },
      body: new URLSearchParams(fields).toString(),
    });
  const exchangeCode = () =>
    post({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER });
  const refresh = (refreshToken: string) => post({ grant_type: 'refresh_token', refresh_token: refreshToken });
  return { stores, post, exchangeCode, refresh };
}

describe('tokenApp', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('authorization_code grant', () => {
    // OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1: a successful token response, not cached.
    it('should exchange the code for an access token, an ID Token and a refresh token', async () => {
      const { stores, exchangeCode } = await provider(['openid', 'offline_access']);

      const response = await exchangeCode();
      const body = (await response.json()) as TokenResponseBody;

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Pragma')).toBe('no-cache');
      expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'openid offline_access' });
      // RFC 9068 §2.2: the access token of the grant.
      expect(decodeJwt(body.access_token).payload).toMatchObject({
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: [USERINFO_ENDPOINT],
        client_id: CLIENT_ID,
        scope: 'openid offline_access',
        iat: NOW,
        exp: NOW + 3600,
      });
      // OIDC Core 1.0 §3.1.3.6 / §2: bound to the access token, with the nonce and auth_time of the code.
      expect(decodeJwt(body.id_token ?? '').payload).toEqual({
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 3600,
        iat: NOW,
        at_hash: await leftHalfSha256(body.access_token),
        nonce: 'nonce-1',
        auth_time: AUTH_TIME,
      });
      // OIDC Core 1.0 §11: offline_access makes the refresh token outlive the login session.
      expect(await stores.refreshTokenStore.get(body.refresh_token ?? '')).toEqual({
        subject: SUBJECT,
        clientId: CLIENT_ID,
        scope: ['openid', 'offline_access'],
        expiresAt: NOW + REFRESH_TOKEN_LIFETIME,
        originalIssuedAt: NOW,
        used: false,
        grantId: 'grant-1',
        iat: NOW,
        issuer: TEST_ISSUER,
        audience: [USERINFO_ENDPOINT],
        authTime: AUTH_TIME,
        nonce: 'nonce-1',
      });
      expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({
        sub: SUBJECT,
        clientId: CLIENT_ID,
        grantId: 'grant-1',
        expiresAt: NOW + 3600,
      });
    });

    // OAuth 2.1 §4.1.2: a replayed code is rejected and the tokens issued from it are revoked.
    it('should reject a replayed code with invalid_grant and revoke the tokens issued from it', async () => {
      const { stores, exchangeCode } = await provider(['openid', 'offline_access']);
      const first = (await (await exchangeCode()).json()) as TokenResponseBody;

      const replay = await exchangeCode();

      expect(replay.status).toBe(400);
      expect(await replay.json()).toEqual({
        error: 'invalid_grant',
        error_description: 'Authorization code has already been used',
      });
      expect(await stores.accessTokenStore.get(first.access_token)).toBeUndefined();
      expect(await stores.refreshTokenStore.get(first.refresh_token ?? '')).toBeUndefined();
    });

    // RFC 6749 §5.2 / RFC 6750 §3: a failed client authentication is a 401 with WWW-Authenticate.
    it('should answer a wrong client_secret with 401 invalid_client and leave the code unused', async () => {
      const { stores, post } = await provider(['openid']);

      const response = await post(
        { grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER },
        'wrong-secret',
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
      expect(await response.json()).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' });
      expect((await stores.authCodeStore.get('code-1'))?.used).toBe(false);
    });
  });

  describe('refresh_token grant', () => {
    // OAuth 2.1 §4.3.1 / §6.1 / OIDC Core 1.0 §12.1: rotation, absolute lifetime and the first authentication kept.
    it('should rotate the refresh token and re-issue the tokens with the auth_time of the first authentication', async () => {
      const { stores, exchangeCode, refresh } = await provider(['openid', 'offline_access']);
      const first = (await (await exchangeCode()).json()) as TokenResponseBody;
      vi.setSystemTime((NOW + 60) * 1000);

      const response = await refresh(first.refresh_token ?? '');
      const body = (await response.json()) as TokenResponseBody;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'openid offline_access' });
      expect(body.refresh_token).not.toBe(first.refresh_token);
      // OIDC Core 1.0 §12.2: the re-issued ID Token keeps sub and auth_time and carries no nonce.
      expect(decodeJwt(body.id_token ?? '').payload).toEqual({
        iss: TEST_ISSUER,
        sub: SUBJECT,
        aud: CLIENT_ID,
        exp: NOW + 60 + 3600,
        iat: NOW + 60,
        at_hash: await leftHalfSha256(body.access_token),
        auth_time: AUTH_TIME,
      });
      // OAuth 2.1 §4.3.1: the presented refresh token is marked used.
      expect((await stores.refreshTokenStore.get(first.refresh_token ?? ''))?.used).toBe(true);
      // OAuth 2.1 §6.1: the successor keeps the absolute lifetime of the first issuance.
      expect(await stores.refreshTokenStore.get(body.refresh_token ?? '')).toMatchObject({
        subject: SUBJECT,
        scope: ['openid', 'offline_access'],
        grantId: 'grant-1',
        used: false,
        iat: NOW + 60,
        originalIssuedAt: NOW,
        expiresAt: NOW + REFRESH_TOKEN_LIFETIME,
        authTime: AUTH_TIME,
      });
    });

    // OAuth 2.1 §4.3.1 / RFC 9700 §4.14: reuse of a rotated refresh token revokes the token family.
    it('should reject the reuse of a rotated refresh token with invalid_grant and revoke its successors', async () => {
      const { stores, exchangeCode, refresh } = await provider(['openid', 'offline_access']);
      const first = (await (await exchangeCode()).json()) as TokenResponseBody;
      const second = (await (await refresh(first.refresh_token ?? '')).json()) as TokenResponseBody;

      const reuse = await refresh(first.refresh_token ?? '');

      expect(reuse.status).toBe(400);
      expect(await reuse.json()).toEqual({ error: 'invalid_grant', error_description: 'Refresh token has already been used' });
      expect(await stores.refreshTokenStore.get(second.refresh_token ?? '')).toBeUndefined();
      expect(await stores.accessTokenStore.get(second.access_token)).toBeUndefined();
    });

    // OIDC Core 1.0 §11: without offline_access the refresh token is bound to the login session.
    it('should stop accepting an online refresh token once its login session has ended', async () => {
      const { stores, exchangeCode, refresh } = await provider(['openid']);
      await stores.browserSessionStore.set('session-1', { subject: SUBJECT, authTime: AUTH_TIME });
      const first = (await (await exchangeCode()).json()) as TokenResponseBody;
      const whileLoggedIn = await refresh(first.refresh_token ?? '');
      const second = (await whileLoggedIn.json()) as TokenResponseBody;
      await stores.browserSessionStore.delete('session-1');

      const afterLogout = await refresh(second.refresh_token ?? '');

      expect(whileLoggedIn.status).toBe(200);
      expect(afterLogout.status).toBe(400);
      expect(await afterLogout.json()).toEqual({
        error: 'invalid_grant',
        error_description: 'The authentication session bound to this refresh token has ended',
      });
    });
  });
});
