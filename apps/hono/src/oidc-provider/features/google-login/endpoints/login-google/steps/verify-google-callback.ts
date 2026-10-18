import {
  GoogleLoginError,
  handleGoogleLoginRedirect,
  resolveGoogleLoginSubject,
} from '@maronn-openid-connect/google-login';
import type { LoginError } from '../../../../../endpoints/login/screen.js';
import { step } from '../../../../../endpoints/step.js';
import type { GoogleLoginConfig } from '../../../config.js';

export const meta = step({
  id: 'verify-google-callback',
  endpoint: 'login-google',
  feature: 'google-login',
  kind: 'validate',
  label: 'Verify the posted Google ID token and nonce',
  function: 'verifyGoogleLoginCallback',
  calls: ['handleGoogleLoginRedirect', 'resolveGoogleLoginSubject'],
  consumes: [],
  produces: ['transactionId', 'subject'],
  removable: false,
});

/**
 * [verify-google-callback] EXTENSION (google-login): run the callback checks
 * and map the Google account to an OP subject. Returns the error to show on
 * failure so a failed Google callback is never redirected to a client — until
 * the nonce is verified the OP cannot tell whose transaction this is.
 */
export async function verifyGoogleLoginCallback(
  c: any,
  googleLogin: GoogleLoginConfig,
): Promise<{ transactionId: string; subject: string } | LoginError> {
  const nonceStore = c.get('googleLoginNonceStore');
  const verifier = c.get('googleIdTokenVerifier');
  const accountResolver = c.get('googleAccountResolver');
  try {
    // Double Submit Cookie -> google-auth-library verification -> nonce lookup,
    // in the order Google's server-side verification guide prescribes.
    const login = await handleGoogleLoginRedirect({
      params: await c.req.parseBody(),
      cookieHeader: c.req.header('Cookie') ?? null,
      clientId: googleLogin.clientId,
      verifier,
      nonceStore,
      hostedDomain: googleLogin.hostedDomain,
      requireVerifiedEmail: googleLogin.requireVerifiedEmail,
    });
    const subject = await resolveGoogleLoginSubject(login.account, accountResolver);
    return { transactionId: login.transactionId, subject };
  } catch (error) {
    if (!(error instanceof GoogleLoginError)) throw error;
    return {
      kind: 'error',
      error: error.code,
      errorDescription: error.message,
      statusCode: error.httpStatusCode,
    };
  }
}
