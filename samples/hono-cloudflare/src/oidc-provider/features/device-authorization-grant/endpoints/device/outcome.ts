/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant, verification UI
 * (RFC 8628 §3.3), API layer: logic only.
 *
 * This module was generated because the OP was created with
 * `--enable device-authorization-grant`. It is backed by
 * @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The end user opens /device on a second device, types the user_code the first
 * device is showing, signs in, and approves or denies. The device learns the
 * outcome only by polling the token endpoint — there is no push channel.
 *
 * The three steps of steps/ are the three state-changing steps of that UI.
 * None of them builds a Response: each returns an outcome (which screen comes
 * next, with which cookies), and page.tsx — which also owns GET /device and
 * the POST routes — turns it into HTTP.
 *
 * ## Why every step here demands a binding cookie
 *
 * The user_code is known to whoever started the flow, and that party can be the
 * attacker. A CSRF token stored on the record is therefore not a defense: the
 * attacker can fetch a valid one by submitting their own code. What stops both
 * consent coercion (a forged approval that ships the victim's tokens to the
 * attacker's device) and login CSRF (a forged sign-in that plants the
 * attacker's session in the victim's browser) is the binding cookie minted
 * by submit-user-code — see buildDeviceBindingCookie() in ../../cookies.ts for
 * the full model. The
 * hidden csrf_token is kept as defense in depth, never as the only check.
 */
import {
  DeviceAuthorizationError,
  DeviceVerificationError,
  type DeviceAuthorizationRecord,
} from '@maronn-openid-connect/experimental/device-authorization-grant';

/** What a verification step decided; page.tsx turns it into the next screen. */
export type DeviceOutcome =
  /**
   * The code did not match. RFC 8628 §5.1: unknown, expired and already-used
   * codes share one reason-free answer so the UI cannot reveal which codes exist.
   */
  | { kind: 'invalid_user_code'; userCode: string }
  /** A binding or CSRF failure the OP shows on its own error page. */
  | { kind: 'error'; error: string; statusCode: number }
  /** The decision step needs an OP session this browser does not have (401). */
  | { kind: 'session_required' }
  /** recordDeviceLoginFailure() denied the record: no further attempt is accepted (429). */
  | { kind: 'locked_out' }
  /** Show the sign-in form; cookies carries the binding its submission needs. */
  | { kind: 'login'; userCode: string; csrfToken: string; cookies: string[] }
  /** Wrong credentials: show the sign-in form again with the attempts left. */
  | { kind: 'invalid_credentials'; userCode: string; csrfToken: string; remainingAttempts: number }
  /** Show the approve / deny screen; cookies carries the binding and/or the new OP session. */
  | {
      kind: 'approval';
      userCode: string;
      csrfToken: string;
      clientId: string;
      scopes: string[];
      cookies: string[];
    }
  /** The decision is recorded; cookies clears the binding. */
  | { kind: 'completed'; approved: boolean; clientId: string; cookies: string[] };

/** The fields of the sign-in form. */
export interface DeviceLoginSubmission {
  userCode: string;
  csrfToken: string;
  username: string;
  password: string;
}

/** The fields of the approve / deny form. */
export interface DeviceDecisionSubmission {
  userCode: string;
  csrfToken: string;
  /** 'approve' or anything else (treated as deny). */
  decision: string;
}

/**
 * Remaining lifetime of a record, in whole seconds, never negative.
 *
 * Rounded up so the cookie always outlives the record it binds: a cookie that
 * expired first would turn a still-valid verification into an unexplained 403.
 */
export function remainingTtlSeconds(record: DeviceAuthorizationRecord): number {
  return Math.max(0, Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000));
}

/** Map a verification failure to the error to show; anything else is re-thrown. */
export function verificationFailure(error: unknown): DeviceOutcome {
  if (error instanceof DeviceVerificationError) {
    return { kind: 'error', error: error.message, statusCode: error.statusCode };
  }
  if (error instanceof DeviceAuthorizationError) {
    return { kind: 'error', error: error.errorDescription, statusCode: 400 };
  }
  throw error;
}
