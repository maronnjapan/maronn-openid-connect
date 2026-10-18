import { defineFeature } from '../../feature';
import { readGoogleLoginConfig } from './config';
import { googleLoginMethod } from './login-method';

/**
 * Sign in with Google as a login method: the button on the login page
 * (login-method.tsx) and the callback app/(google-login)/login/google/route.ts.
 */
export const googleLogin = defineFeature({
  id: 'google-login',
  // Set GOOGLE_CLIENT_ID (the OAuth client ID from the Google Cloud console) to
  // render the "Sign in with Google" button, and register <issuer>/login/google
  // as an authorized redirect URI there. GOOGLE_HOSTED_DOMAIN optionally
  // restricts sign-in to one Workspace domain.
  config: { googleLogin: readGoogleLoginConfig() },
  loginMethods: [googleLoginMethod],
});
