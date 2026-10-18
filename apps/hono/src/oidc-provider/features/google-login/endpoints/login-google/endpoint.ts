import { defineEndpoint } from '../../../../endpoints/step.js';

/** EXTENSION — the Google login callback (login_uri) of Sign in with Google. */
export const endpoint = defineEndpoint({
  id: 'login-google',
  label: 'Google login callback (login_uri)',
  path: '/login/google',
  methods: ['POST'],
  layer: 'browser',
  group: { id: 'google-login', label: 'Sign in with Google (extension)' },
  feature: 'google-login',
  rearrangeable: false,
  edges: { chain: true },
  journeys: [
    { from: 'login', to: 'login-google', label: 'Sign in with Google', kind: 'flow' },
    { from: 'login-google', to: 'consent', label: 'authenticated', kind: 'flow' },
  ],
});
