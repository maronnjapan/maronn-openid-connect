import {
  GoogleLoginError,
  GoogleLoginErrorCode,
  type GoogleAccountResolver,
  type GoogleIdTokenPayload,
  type GoogleIdTokenVerifier,
} from '@maronn-openid-connect/google-login';
import { describe, expect, it, vi } from 'vitest';
import { formPost, providerContext } from '../../../../../../test-support/context.js';
import type { GoogleLoginConfig } from '../../../config.js';
import { verifyGoogleLoginCallback } from './verify-google-callback.js';

const googleLogin: GoogleLoginConfig = { clientId: 'google-client-id' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function account(overrides: Partial<GoogleIdTokenPayload> = {}): GoogleIdTokenPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: 'google-client-id',
    sub: 'google-sub-1',
    iat: now,
    exp: now + 3600,
    nonce: 'nonce-1',
    email: 'alice@gmail.com',
    email_verified: true,
    name: 'Alice',
    ...overrides,
  };
}

/** A verifier standing in for google-auth-library: it accepts every token and returns payload. */
function fakeVerifier(payload: GoogleIdTokenPayload = account()) {
  return { verify: vi.fn<GoogleIdTokenVerifier['verify']>(async () => payload) };
}

/**
 * The context of the Google callback POST (redirect mode: credential and
 * g_csrf_token in the body, g_csrf_token in a cookie), with nonce-1 issued
 * for txn-1.
 */
async function callbackContext(input: {
  verifier?: GoogleIdTokenVerifier;
  accountResolver?: GoogleAccountResolver;
  fields?: Record<string, string>;
  cookie?: string;
} = {}) {
  const context = await providerContext({
    request: formPost(
      '/login/google',
      input.fields ?? { credential: 'google-id-token', g_csrf_token: 'csrf-1' },
      { Cookie: input.cookie ?? 'g_csrf_token=csrf-1' },
    ),
    options: {
      googleIdTokenVerifier: input.verifier ?? fakeVerifier(),
      ...(input.accountResolver ? { googleAccountResolver: input.accountResolver } : {}),
    },
  });
  await context.c
    .get('googleLoginNonceStore')
    .put('google_login_nonce:nonce-1', { transactionId: 'txn-1', expiresAt: Date.now() + 600_000 }, 600);
  return context;
}

describe('verifyGoogleLoginCallback', () => {
  it('should return the transaction of the nonce and the subject of a user provisioned for the account', async () => {
    const verifier = fakeVerifier();
    const { c, db } = await callbackContext({ verifier });

    const verified = await verifyGoogleLoginCallback(c, googleLogin);

    expect(verified).toEqual({ transactionId: 'txn-1', subject: expect.stringMatching(UUID) });
    const { subject } = verified as { subject: string };
    expect(db.users.get(subject)).toEqual({
      claims: { sub: subject, name: 'Alice', email: 'alice@gmail.com', email_verified: true },
    });
    expect(verifier.verify.mock.calls).toEqual([['google-id-token', 'google-client-id']]);
  });

  // The nonce is single-use: replaying the same ID token finds no login attempt.
  it('should use the nonce up, so a replayed ID token is refused with login_nonce_not_found', async () => {
    const { c } = await callbackContext();

    await verifyGoogleLoginCallback(c, googleLogin);
    const replay = await verifyGoogleLoginCallback(c, googleLogin);

    expect(replay).toEqual({
      kind: 'error',
      error: 'login_nonce_not_found',
      errorDescription:
        'Google login attempt not found. The login page may have expired or the credential was already used.',
      statusCode: 400,
    });
  });

  // Double Submit Cookie, checked before the ID token is looked at.
  it('should refuse a callback without the g_csrf_token cookie before verifying the ID token', async () => {
    const verifier = fakeVerifier();
    const { c } = await callbackContext({ verifier, cookie: 'other=1' });

    expect(await verifyGoogleLoginCallback(c, googleLogin)).toEqual({
      kind: 'error',
      error: 'csrf_token_missing_in_cookie',
      errorDescription: 'No CSRF token in Cookie.',
      statusCode: 400,
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('should answer an ID token the verifier rejects with invalid_id_token and 401', async () => {
    const verifier = {
      verify: vi.fn(async (): Promise<GoogleIdTokenPayload> => {
        throw new GoogleLoginError(GoogleLoginErrorCode.InvalidIdToken, 'Token used too late');
      }),
    };
    const { c } = await callbackContext({ verifier });

    expect(await verifyGoogleLoginCallback(c, googleLogin)).toEqual({
      kind: 'error',
      error: 'invalid_id_token',
      errorDescription: 'Token used too late',
      statusCode: 401,
    });
  });

  it('should refuse an account outside the configured hosted domain with 403', async () => {
    const { c } = await callbackContext();

    expect(await verifyGoogleLoginCallback(c, { ...googleLogin, hostedDomain: 'example.com' })).toEqual({
      kind: 'error',
      error: 'invalid_hosted_domain',
      errorDescription: 'ID token hd does not match the allowed hosted domain',
      statusCode: 403,
    });
  });

  it('should refuse an unverified email with 403 when requireVerifiedEmail is set', async () => {
    const { c } = await callbackContext({ verifier: fakeVerifier(account({ email_verified: false })) });

    expect(await verifyGoogleLoginCallback(c, { ...googleLogin, requireVerifiedEmail: true })).toEqual({
      kind: 'error',
      error: 'email_not_verified',
      errorDescription: 'ID token email is not verified',
      statusCode: 403,
    });
  });

  it('should refuse an account the injected resolver links to no user with account_not_linked', async () => {
    const { c } = await callbackContext({ accountResolver: { resolveSubject: async () => null } });

    expect(await verifyGoogleLoginCallback(c, googleLogin)).toEqual({
      kind: 'error',
      error: 'account_not_linked',
      errorDescription: 'This Google account is not linked to a user of this provider.',
      statusCode: 403,
    });
  });

  it('should let a failure that is not a GoogleLoginError propagate', async () => {
    const outage = new Error('verifier crashed');
    const verifier = {
      verify: vi.fn(async (): Promise<GoogleIdTokenPayload> => {
        throw outage;
      }),
    };
    const { c } = await callbackContext({ verifier });

    await expect(verifyGoogleLoginCallback(c, googleLogin)).rejects.toBe(outage);
  });
});
