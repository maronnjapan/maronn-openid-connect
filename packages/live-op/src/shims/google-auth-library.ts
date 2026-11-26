/**
 * What the OP's Google sign-in (packages/google-login) imports of
 * google-auth-library, for the OP of the map: a client that refuses to verify,
 * and the error class the sign-in tells a failure to fetch Google's keys by.
 * The map's OP has no Google client, and it sends no request out of the page.
 */

/** The error google-auth-library's HTTP client throws; nothing here throws it. */
class GaxiosError extends Error {}

export const gaxios = { GaxiosError };

/** A Google OAuth client that refuses to verify an ID token. */
export class OAuth2Client {
  /** Refuse: the map's OP does not verify Google ID tokens. */
  async verifyIdToken(): Promise<never> {
    throw new Error('The OP of the map does not sign in with Google.');
  }
}
