import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, providerContext } from '../../../../test-support/context.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { registerUser } from '../../../db/memory/users.js';
import {
  AUTH_TIME,
  CLIENT_ID,
  NOW,
  SUBJECT,
  authorizationCodeRequest,
  decodeJwt,
  leftHalfSha256,
  refreshTokenRequest,
  verifiesWith,
} from '../../../../test-support/token.js';
import { issueIdToken } from './issue-id-token.js';

const ACCESS_TOKEN = 'access-token-1';

describe('issueIdToken', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // OIDC Core 1.0 §3.1.2.1: an ID Token is issued only for an OpenID Connect request (openid scope).
  it('should issue no ID Token when the grant has no openid scope', async () => {
    const { c, signingKey } = await providerContext();

    await expect(
      issueIdToken(c, {
        idTokenSigningKey: signingKey,
        accessToken: ACCESS_TOKEN,
        subject: SUBJECT,
        authTime: AUTH_TIME,
        nonce: 'nonce-1',
        validatedRequest: authorizationCodeRequest({ scope: ['profile'] }),
        issuedAt: NOW,
        acr: undefined,
        amr: undefined,
      }),
    ).resolves.toBeUndefined();
  });

  // OIDC Core 1.0 §2 / §3.1.3.7: a JWT signed with the ID Token key, typ JWT and its kid.
  it('should sign the ID Token with the ID Token signing key and its kid', async () => {
    const { c } = await providerContext();
    const idTokenSigningKey = await rs256Key('id-token-key');

    const idToken = await issueIdToken(c, {
      idTokenSigningKey,
      accessToken: ACCESS_TOKEN,
      subject: SUBJECT,
      authTime: AUTH_TIME,
      nonce: 'nonce-1',
      validatedRequest: authorizationCodeRequest(),
      issuedAt: NOW,
      acr: undefined,
      amr: undefined,
    });

    expect(decodeJwt(idToken ?? '').header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'id-token-key' });
    expect(await verifiesWith(idToken ?? '', idTokenSigningKey)).toBe(true);
  });

  // OIDC Core 1.0 §2 / §3.1.3.6: iss, sub, aud, exp, iat, at_hash, nonce, auth_time, acr, amr.
  it('should put the claims of the authentication and the at_hash of the access token into the payload', async () => {
    const { c, signingKey } = await providerContext({ options: { config: { idTokenExpiresIn: 900 } } });

    const idToken = await issueIdToken(c, {
      idTokenSigningKey: signingKey,
      accessToken: ACCESS_TOKEN,
      subject: SUBJECT,
      authTime: AUTH_TIME,
      nonce: 'nonce-1',
      validatedRequest: authorizationCodeRequest(),
      issuedAt: NOW,
      acr: 'urn:acr:mfa',
      amr: ['pwd', 'otp'],
    });

    expect(decodeJwt(idToken ?? '').payload).toEqual({
      iss: TEST_ISSUER,
      sub: SUBJECT,
      aud: CLIENT_ID,
      exp: NOW + 900,
      iat: NOW,
      // OIDC Core 1.0 §3.1.3.6: the left half of SHA-256 (RS256) of the access token.
      at_hash: await leftHalfSha256(ACCESS_TOKEN),
      nonce: 'nonce-1',
      auth_time: AUTH_TIME,
      acr: 'urn:acr:mfa',
      amr: ['pwd', 'otp'],
    });
  });

  // OIDC Core 1.0 §5.5: the id_token member of the claims parameter of the
  // authorization request adds those claims to the ID Token, whatever the scope.
  // The claims of the scope values stay with the UserInfo endpoint (§5.4).
  it('should add the claims requested by claims.id_token of the authorization request', async () => {
    const { c, db, signingKey } = await providerContext();
    await registerUser(db, { sub: SUBJECT, name: 'Alice', email: 'alice@example.com' });

    const idToken = await issueIdToken(c, {
      idTokenSigningKey: signingKey,
      accessToken: ACCESS_TOKEN,
      subject: SUBJECT,
      authTime: AUTH_TIME,
      nonce: 'nonce-1',
      validatedRequest: authorizationCodeRequest({
        scope: ['openid', 'profile'],
        claims: { id_token: { email: { essential: true } } },
      }),
      issuedAt: NOW,
      acr: undefined,
      amr: undefined,
    });

    expect(decodeJwt(idToken ?? '').payload).toEqual({
      email: 'alice@example.com',
      iss: TEST_ISSUER,
      sub: SUBJECT,
      aud: CLIENT_ID,
      exp: NOW + 3600,
      iat: NOW,
      at_hash: await leftHalfSha256(ACCESS_TOKEN),
      nonce: 'nonce-1',
      auth_time: AUTH_TIME,
    });
  });

  // The userinfo member asks the UserInfo endpoint for the claims (OIDC Core 1.0 §5.5).
  it('should leave the claims requested by claims.userinfo out of the ID Token', async () => {
    const { c, db, signingKey } = await providerContext();
    await registerUser(db, { sub: SUBJECT, name: 'Alice', email: 'alice@example.com' });

    const idToken = await issueIdToken(c, {
      idTokenSigningKey: signingKey,
      accessToken: ACCESS_TOKEN,
      subject: SUBJECT,
      authTime: AUTH_TIME,
      nonce: 'nonce-1',
      validatedRequest: authorizationCodeRequest({ claims: { userinfo: { email: { essential: true } } } }),
      issuedAt: NOW,
      acr: undefined,
      amr: undefined,
    });

    expect(decodeJwt(idToken ?? '').payload).toEqual({
      iss: TEST_ISSUER,
      sub: SUBJECT,
      aud: CLIENT_ID,
      exp: NOW + 3600,
      iat: NOW,
      at_hash: await leftHalfSha256(ACCESS_TOKEN),
      nonce: 'nonce-1',
      auth_time: AUTH_TIME,
    });
  });

  // OIDC Core 1.0 §12.1 / §12.2: a refresh re-issues the ID Token without the nonce.
  it('should leave nonce, acr and amr out of the ID Token of a refresh without them', async () => {
    const { c, signingKey } = await providerContext();

    const idToken = await issueIdToken(c, {
      idTokenSigningKey: signingKey,
      accessToken: ACCESS_TOKEN,
      subject: SUBJECT,
      authTime: AUTH_TIME,
      nonce: undefined,
      validatedRequest: refreshTokenRequest(),
      issuedAt: NOW,
      acr: undefined,
      amr: undefined,
    });

    expect(decodeJwt(idToken ?? '').payload).toEqual({
      iss: TEST_ISSUER,
      sub: SUBJECT,
      aud: CLIENT_ID,
      exp: NOW + 3600,
      iat: NOW,
      at_hash: await leftHalfSha256(ACCESS_TOKEN),
      auth_time: AUTH_TIME,
    });
  });
});
