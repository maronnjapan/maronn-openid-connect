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
 * The three functions below are the three state-changing steps of that UI.
 * None of them builds a Response: each returns an outcome (which screen comes
 * next, with which cookies), and pages/device.tsx — which also owns GET /device
 * and the POST routes — turns it into HTTP.
 *
 * ## Why every step here demands a binding cookie
 *
 * The user_code is known to whoever started the flow, and that party can be the
 * attacker. A CSRF token stored on the record is therefore not a defense: the
 * attacker can fetch a valid one by submitting their own code. What stops both
 * consent coercion (a forged approval that ships the victim's tokens to the
 * attacker's device) and login CSRF (a forged sign-in that plants the
 * attacker's session in the victim's browser) is the binding cookie minted
 * below — see buildDeviceBindingCookie() in store.ts for the full model. The
 * hidden csrf_token is kept as defense in depth, never as the only check.
 */
import {
  DeviceAuthorizationError,
  DeviceVerificationError,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  findPendingRecordByUserCode,
  issueVerificationBinding,
  recordDeviceLoginFailure,
  validateVerificationBinding,
  validateVerificationCsrfToken,
  type DeviceAuthorizationRecord,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { generateRandomString } from '@maronn-openid-connect/core';
import {
  browserSessionStore as defaultBrowserSessionStore,
  buildClearedDeviceBindingCookie,
  buildDeviceBindingCookie,
  buildSessionCookie,
  parseDeviceBindingSecret,
  parseSessionId,
  userStore,
} from '../store.js';
import { deviceAuthorizationConfig } from './device-authorization.js';

/** What a verification step decided; pages/device.tsx turns it into the next screen. */
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
function remainingTtlSeconds(record: DeviceAuthorizationRecord): number {
  return Math.max(0, Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000));
}

/** Map a verification failure to the error to show; anything else is re-thrown. */
function verificationFailure(error: unknown): DeviceOutcome {
  if (error instanceof DeviceVerificationError) {
    return { kind: 'error', error: error.message, statusCode: error.statusCode };
  }
  if (error instanceof DeviceAuthorizationError) {
    return { kind: 'error', error: error.errorDescription, statusCode: 400 };
  }
  throw error;
}

/**
 * User code submission (POST /device)
 * RFC 8628 §3.3
 *
 * On a match this is where the browser binding is minted, so this is also the
 * first answer that may carry a csrf_token. Everything downstream requires the
 * cookie this outcome sets.
 */
export async function submitDeviceUserCode(c: any, submittedUserCode: string): Promise<DeviceOutcome> {
  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return { kind: 'invalid_user_code', userCode: submittedUserCode };
  }

  // Rotate the binding secret and the csrf token together. A second browser
  // submitting the same user_code takes the binding over (last writer wins);
  // that is inherent to a flow whose identifier is shareable by design.
  const { bindingSecret, csrfToken } = await issueVerificationBinding(record, deviceStore);
  const cookie = buildDeviceBindingCookie(
    record.userCode,
    bindingSecret,
    remainingTtlSeconds(record),
  );

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return {
      kind: 'approval',
      userCode: record.userCodeDisplay,
      csrfToken,
      clientId: record.clientId,
      scopes: record.scope,
      cookies: [cookie],
    };
  }

  return {
    kind: 'login',
    userCode: record.userCodeDisplay,
    csrfToken,
    cookies: [cookie],
  };
}

/**
 * Device login (POST /device/login)
 * RFC 8628 §3.3
 *
 * Binding first, then CSRF, then credentials: the binding is what proves this is
 * the browser that submitted the user_code, and it must gate the step that would
 * otherwise let a forged POST establish an OP session in the victim's browser.
 */
export async function submitDeviceLogin(c: any, input: DeviceLoginSubmission): Promise<DeviceOutcome> {
  const { userCode: submittedUserCode, csrfToken, username, password } = input;

  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return { kind: 'invalid_user_code', userCode: submittedUserCode };
  }

  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(c.req.header('Cookie') ?? null, record.userCode),
    );
    validateVerificationCsrfToken(record, csrfToken);
  } catch (error) {
    return verificationFailure(error);
  }

  // Swap point: replace this with your own credential check (LDAP, WebAuthn, an
  // upstream IdP) without touching anything above or below it.
  const user = await authenticateUser(username, password);
  if (!user) {
    // Per-record throttling only. An attacker holding a device-grant client can
    // mint unlimited records, so the aggregate password-guess budget is the same
    // as the one on /login. Subject-scoped throttling is a separate concern.
    const failure = await recordDeviceLoginFailure(
      record,
      deviceStore,
      deviceAuthorizationConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // The record is now denied: the device gets access_denied on its next poll.
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      userCode: record.userCodeDisplay,
      csrfToken,
      remainingAttempts: failure.remainingAttempts,
    };
  }

  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // The new OP session travels with the approval screen; the approval step
  // will have to present the binding cookie again as well.
  return {
    kind: 'approval',
    userCode: record.userCodeDisplay,
    csrfToken,
    clientId: record.clientId,
    scopes: record.scope,
    cookies: [buildSessionCookie(sessionId)],
  };
}

/**
 * Approve or deny (POST /device/approve)
 * RFC 8628 §3.3
 *
 * The only state-changing step of the UI, so it demands all three: an OP
 * session, the binding cookie, and the csrf_token.
 */
export async function submitDeviceDecision(
  c: any,
  input: DeviceDecisionSubmission,
): Promise<DeviceOutcome> {
  const { userCode: submittedUserCode, csrfToken, decision } = input;

  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const consentResolver = c.get('consentResolver');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return { kind: 'invalid_user_code', userCode: submittedUserCode };
  }

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return { kind: 'session_required' };
  }

  const clearCookie = buildClearedDeviceBindingCookie(record.userCode);
  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(c.req.header('Cookie') ?? null, record.userCode),
    );

    if (decision === 'approve') {
      // csrf_token is validated inside; the record moves to approved with the
      // subject, auth_time, scope and a fresh grantId the token endpoint reads.
      const approved = await approveDeviceAuthorization({
        record,
        store: deviceStore,
        csrfToken,
        subject: session.subject,
        authTime: session.authTime,
      });
      // Record the consent the same way /consent does, so a later Authorization
      // Code Flow for this client skips the consent screen (OIDC Core 1.0 §3.1.2.4).
      await consentResolver?.recordConsent?.(
        approved.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      await consentResolver?.recordGrant?.(approved.subject, approved.clientId, approved.grantId);
      return { kind: 'completed', approved: true, clientId: approved.clientId, cookies: [clearCookie] };
    }

    await denyDeviceAuthorization({ record, store: deviceStore, csrfToken });
    return { kind: 'completed', approved: false, clientId: record.clientId, cookies: [clearCookie] };
  } catch (error) {
    return verificationFailure(error);
  }
}
