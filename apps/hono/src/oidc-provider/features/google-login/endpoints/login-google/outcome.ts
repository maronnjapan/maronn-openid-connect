import type { LoginError } from '../../../../endpoints/login/screen.js';

/** What the Google login callback decided; page.ts turns it into HTTP. */
export type GoogleLoginOutcome =
  | LoginError
  /** config.googleLogin is not set: the callback does not exist (404). */
  | { kind: 'not_configured' }
  /** Signed in: the OP session cookie(s) to set, then continue to the consent step. */
  | { kind: 'authenticated'; cookies: string[] };
