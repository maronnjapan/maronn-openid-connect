import type {
  GoogleAccountResolver,
  GoogleIdTokenVerifier,
} from '@maronn-openid-connect/google-login';

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

declare module '../../config.js' {
  interface ProviderConfig {
    /**
     * EXTENSION (google-login): Sign in with Google. Leave undefined to render no
     * Google button; the login page then only offers the username / password form.
     */
    googleLogin?: GoogleLoginConfig;
  }
}

declare module '../../app.js' {
  interface OidcProviderOptions {
    /**
     * EXTENSION (google-login): verifier for the ID token Google posts to
     * /login/google. Defaults to google-auth-library (OAuth2Client.verifyIdToken)
     * with a process-wide certificate cache; inject a custom one for tests or a
     * proxied environment.
     */
    googleIdTokenVerifier?: GoogleIdTokenVerifier;
    /**
     * EXTENSION (google-login): map a verified Google account to the OP subject.
     * Defaults to just-in-time provisioning through the user store
     * (userStore.linkFederatedIdentity), keyed by the Google `sub`.
     */
    googleAccountResolver?: GoogleAccountResolver;
  }
}
