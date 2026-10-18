import {
  getDefaultGoogleIdTokenVerifier,
  type GoogleIdTokenPayload,
} from '@maronn-openid-connect/google-login';
import { defineFeature } from '../feature.js';
import './config.js';
import { loginGooglePage } from './endpoints/login-google/page.js';
import { googleLoginMethod } from './login-method.js';
import { createGoogleLoginNonceStore, googleAccountToFederatedIdentity } from './store.js';

/**
 * EXTENSION (google-login) — Sign in with Google (Google Identity Services,
 * redirect mode) as a login method: the button on the login page and its
 * callback, POST /login/google. It stays off until config.googleLogin (the
 * Google OAuth client ID) is set. See @maronn-openid-connect/google-login.
 */
export const googleLogin = defineFeature({
  id: 'google-login',
  routes: [{ path: '/login/google', app: loginGooglePage, methods: ['POST'] }],
  context: ({ c, options, stores }) => ({
    googleLoginNonceStore: createGoogleLoginNonceStore(stores.upstreamLoginStore),
    googleIdTokenVerifier: options.googleIdTokenVerifier ?? getDefaultGoogleIdTokenVerifier(),
    // Just-in-time provisioning through the user store, keyed by the Google sub.
    googleAccountResolver: options.googleAccountResolver ?? {
      resolveSubject: async (account: GoogleIdTokenPayload) =>
        (await c.get('userStore').linkFederatedIdentity(googleAccountToFederatedIdentity(account))).sub,
    },
  }),
  loginMethods: [googleLoginMethod],
});
