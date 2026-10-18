/**
 * EXTENSION (google-login): Sign in with Google (Google Identity Services,
 * redirect mode) as a login method. See @maronn-openid-connect/google-login.
 */
export interface GoogleLoginConfig {
  /**
   * OAuth 2.0 client ID (type: Web application) from the Google Cloud console.
   * The ID token's `aud` must equal it. Register `<issuer>/login/google` as an
   * authorized redirect URI of this client, and the login page origin as an
   * authorized JavaScript origin.
   */
  clientId: string;
  /**
   * Optional: only accept Google Workspace accounts of these hosted domains
   * (`hd` claim). A personal Google account has no `hd` and is rejected.
   */
  hostedDomain?: string | string[];
  /**
   * Optional: reject accounts whose email Google has not verified
   * (`email_verified !== true`). Off by default; users are keyed by the Google
   * `sub`, never by email, so an unverified email cannot hijack another user.
   */
  requireVerifiedEmail?: boolean;
}

declare module '../../config' {
  interface ProviderConfig {
    /**
     * EXTENSION (google-login): Sign in with Google. Leave undefined to render no
     * Google button; the login page then only offers the username / password form.
     */
    googleLogin?: GoogleLoginConfig;
  }
}

/**
 * The Google login of the environment: GOOGLE_CLIENT_ID, and optionally
 * GOOGLE_HOSTED_DOMAIN to accept the accounts of one Workspace domain only.
 * undefined without GOOGLE_CLIENT_ID.
 */
export function readGoogleLoginConfig(): GoogleLoginConfig | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return undefined;
  const hostedDomain = process.env.GOOGLE_HOSTED_DOMAIN;
  return hostedDomain ? { clientId, hostedDomain } : { clientId };
}
