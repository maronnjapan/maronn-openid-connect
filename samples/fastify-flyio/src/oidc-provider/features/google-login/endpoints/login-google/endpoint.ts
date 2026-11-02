import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * Complete a Sign in with Google login: verify the ID token Google posts back,
 * link the Google account to a user of the provider, start the session of the
 * transaction and go on to the consent screen.
 *
 * EXTENSION: generated with --enable google-login (the login_uri of Sign in
 * with Google).
 */
export const endpoint = defineEndpoint({
  id: 'login-google',
  order: 50,
  label: 'Google login callback (login_uri)',
  path: '/login/google',
  methods: ['POST'],
  layer: 'browser',
  group: { id: 'google-login', label: 'Sign in with Google (extension)' },
  feature: 'google-login',
  rearrangeable: false,
  steps: [
    'verify-google-callback',
    'load-transaction',
    'discard-session-for-fresh-login',
    'establish-session',
    'hand-off-to-consent',
  ],
  edges: {
    chain: true,
  },
  journeys: [
    { from: 'login', to: 'login-google', label: 'Sign in with Google', kind: 'flow', order: 60 },
    { from: 'login-google', to: 'consent', label: 'authenticated', kind: 'flow', order: 70 },
  ],
});
