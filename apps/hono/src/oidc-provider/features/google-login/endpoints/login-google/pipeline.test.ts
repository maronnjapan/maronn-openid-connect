import type { GoogleIdTokenPayload, GoogleIdTokenVerifier } from '@maronn-openid-connect/google-login';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formPost, providerContext } from '../../../../../test-support/context.js';
import { storeTransaction } from '../../../../../test-support/extensions.js';
import { completeGoogleLogin } from './pipeline.js';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW = Date.UTC(2026, 0, 1) / 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

const verifier: GoogleIdTokenVerifier = {
  async verify(): Promise<GoogleIdTokenPayload> {
    return {
      iss: 'https://accounts.google.com',
      aud: 'google-client-id',
      sub: 'google-sub-1',
      iat: NOW,
      exp: NOW + 3600,
      nonce: 'nonce-1',
    };
  },
};

/**
 * The context of the Google callback POST, with Google login configured
 * (unless googleLogin is false) and nonce-1 issued for transactionId.
 */
async function callbackContext(input: { googleLogin?: boolean; cookie?: string; transactionId?: string } = {}) {
  const context = await providerContext({
    request: formPost(
      '/login/google',
      { credential: 'google-id-token', g_csrf_token: 'csrf-1' },
      { Cookie: input.cookie ?? 'g_csrf_token=csrf-1' },
    ),
    options: {
      config: input.googleLogin === false ? {} : { googleLogin: { clientId: 'google-client-id' } },
      googleIdTokenVerifier: verifier,
    },
  });
  await context.c
    .get('googleLoginNonceStore')
    .put('google_login_nonce:nonce-1', { transactionId: input.transactionId ?? 'txn-1', expiresAt: NOW * 1000 + 600_000 }, 600);
  return context;
}

describe('completeGoogleLogin', () => {
  it('should report not_configured while config.googleLogin is not set', async () => {
    const { c } = await callbackContext({ googleLogin: false });

    expect(await completeGoogleLogin(c)).toEqual({ kind: 'not_configured' });
  });

  // OIDC Core 1.0 §3.1.2.3: the OP session is established exactly as for a password login.
  it('should establish the browser session and hand the subject off to the consent step', async () => {
    const { c, stores, db } = await callbackContext();
    await storeTransaction(stores, 'txn-1');

    const outcome = await completeGoogleLogin(c);

    const [[sessionId, session]] = [...db.browserSessions.entries()];
    const [subject] = [...db.users.keys()];
    expect(outcome).toEqual({
      kind: 'authenticated',
      cookies: [`session_id=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/`],
    });
    expect(session).toEqual({ subject, authTime: NOW });
    expect(await stores.authSessionStore.get('txn-1')).toEqual({ subject, authTime: NOW, sessionId });
  });

  it('should report the error of the callback check and establish no session', async () => {
    const { c, stores, db } = await callbackContext({ cookie: '' });
    await storeTransaction(stores, 'txn-1');

    const outcome = await completeGoogleLogin(c);

    expect(outcome).toEqual({
      kind: 'error',
      error: 'csrf_token_missing_in_cookie',
      errorDescription: 'No CSRF token in Cookie.',
      statusCode: 400,
    });
    expect(db.browserSessions.size).toBe(0);
  });

  it('should report an error when the transaction of the nonce is gone', async () => {
    const { c, db } = await callbackContext({ transactionId: 'txn-gone' });

    const outcome = await completeGoogleLogin(c);

    expect(outcome).toEqual({
      kind: 'error',
      error: 'Auth transaction not found. The session may have expired.',
      statusCode: 400,
    });
    expect(db.browserSessions.size).toBe(0);
  });

  // OIDC Core 1.0 §3.1.2.1: prompt=login asks for a fresh login, so the existing session is discarded.
  it('should discard the existing browser session for prompt=login', async () => {
    const { c, stores, db } = await callbackContext({ cookie: 'g_csrf_token=csrf-1; session_id=old-session' });
    await storeTransaction(stores, 'txn-1', { prompt: 'login' });
    await stores.browserSessionStore.set('old-session', { subject: 'bob', authTime: NOW - 3600 });

    await completeGoogleLogin(c);

    expect(db.browserSessions.has('old-session')).toBe(false);
    expect(db.browserSessions.size).toBe(1);
  });
});
