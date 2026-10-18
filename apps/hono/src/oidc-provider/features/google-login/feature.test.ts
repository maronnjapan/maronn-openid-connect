import {
  getDefaultGoogleIdTokenVerifier,
  type GoogleAccountResolver,
  type GoogleIdTokenVerifier,
} from '@maronn-openid-connect/google-login';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../test-support/context.js';
import { federatedIdentityKey } from '../../db/memory/database.js';
import { loginGooglePage } from './endpoints/login-google/page.js';
import { googleLogin } from './feature.js';
import { googleLoginMethod } from './login-method.js';

const verifier: GoogleIdTokenVerifier = {
  async verify() {
    throw new Error('not called');
  },
};

describe('googleLogin', () => {
  it('should serve the callback at POST /login/google and offer the Google login method', () => {
    expect({ routes: googleLogin.routes, loginMethods: googleLogin.loginMethods }).toEqual({
      routes: [{ path: '/login/google', app: loginGooglePage, methods: ['POST'] }],
      loginMethods: [googleLoginMethod],
    });
  });

  describe('context', () => {
    it('should use the verifier and the account resolver of the options', async () => {
      const resolver: GoogleAccountResolver = { resolveSubject: async () => 'alice' };
      const { c } = await providerContext({ options: { googleIdTokenVerifier: verifier, googleAccountResolver: resolver } });

      expect(c.get('googleIdTokenVerifier')).toBe(verifier);
      expect(c.get('googleAccountResolver')).toBe(resolver);
    });

    it('should fall back to the process-wide google-auth-library verifier', async () => {
      const { c } = await providerContext();

      expect(c.get('googleIdTokenVerifier')).toBe(getDefaultGoogleIdTokenVerifier());
    });

    // Users are keyed by the Google sub, never by email (just-in-time provisioning).
    it('should resolve a Google account to the user the user store links to its sub', async () => {
      const { c, db } = await providerContext({ options: { googleIdTokenVerifier: verifier } });

      const subject = await c.get('googleAccountResolver').resolveSubject({
        iss: 'https://accounts.google.com',
        aud: 'google-client-id',
        sub: 'google-sub-1',
        iat: 1_767_225_600,
        exp: 1_767_229_200,
        email: 'alice@gmail.com',
      });

      expect(db.federatedIdentities.get(federatedIdentityKey('google', 'google-sub-1'))).toBe(subject);
      expect(db.users.get(subject)).toEqual({ claims: { sub: subject, email: 'alice@gmail.com' } });
    });

    it('should keep the Google login nonces among the upstream logins of the stores', async () => {
      const { c, db } = await providerContext({ options: { googleIdTokenVerifier: verifier } });

      await c.get('googleLoginNonceStore').put('google_login_nonce:nonce-1', { transactionId: 'txn-1', expiresAt: 1 }, 600);

      expect(db.upstreamLogins.get('nonce-1')).toEqual({ provider: 'google', transactionId: 'txn-1', expiresAt: 1 });
    });
  });
});
