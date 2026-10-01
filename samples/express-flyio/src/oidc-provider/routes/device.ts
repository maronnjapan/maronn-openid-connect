/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant, verification UI
 * (RFC 8628 §3.3), API routing layer.
 *
 * This route was generated because the OP was created with
 * `--enable device-authorization-grant`. It is backed by
 * @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The end user opens /device on a second device, types the user_code the first
 * device is showing, signs in, and approves or denies. The device learns the
 * outcome only by polling the token endpoint — there is no push channel.
 *
 * This file holds every step that changes state (the three POSTs below) and
 * decides which screen answers each one; the screens themselves — and GET
 * /device, the code entry form — live in pages/device.ts, so the UI can be
 * changed without touching this file.
 *
 * ## Why every POST here demands a binding cookie
 *
 * The user_code is known to whoever started the flow, and that party can be the
 * attacker. A CSRF token stored on the record is therefore not a defense: the
 * attacker can fetch a valid one by POSTing /device with their own code. What
 * stops both consent coercion (a forged /device/approve that ships the victim's
 * tokens to the attacker's device) and login CSRF (a forged /device/login that
 * plants the attacker's session in the victim's browser) is the binding cookie
 * minted below — see buildDeviceBindingCookie() in store.ts for the full model.
 * The hidden csrf_token is kept as defense in depth, never as the only check.
 */
import { WebRouter } from '../web-router.js';
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
import {
  renderDeviceApprovalPage,
  renderDeviceCompletedPage,
  renderDeviceLoginPage,
  renderInvalidUserCode,
} from '../pages/device.js';
import { renderErrorPage } from '../pages/errors.js';
import { deviceAuthorizationConfig } from './device-authorization.js';

export const deviceApp = new WebRouter();

/**
 * Attach a Set-Cookie to a Response a page already produced.
 *
 * The page helpers build their own Response, so headers staged on the framework
 * context never reach it. Rebuilding the Response is the framework-neutral way
 * to add the cookie without making the screens cookie-aware.
 */
function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

/** Map a verification failure to its error page; anything else is re-thrown. */
function renderVerificationError(c: any, error: unknown): Response {
  if (error instanceof DeviceVerificationError) {
    return renderErrorPage(c, { error: error.message, statusCode: error.statusCode });
  }
  if (error instanceof DeviceAuthorizationError) {
    return renderErrorPage(c, { error: error.errorDescription, statusCode: 400 });
  }
  throw error;
}

/**
 * User code submission - POST
 * RFC 8628 §3.3
 *
 * On a match this is where the browser binding is minted, so this is also the
 * first response that may carry a csrf_token. Everything downstream requires the
 * cookie this response sets.
 */
deviceApp.post('/', async (c) => {
  const body = await c.req.parseBody();
  const submittedUserCode = String(body['user_code'] ?? '');

  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return renderInvalidUserCode(c, submittedUserCode);
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
    return withCookie(renderDeviceApprovalPage(c, {
      userCode: record.userCodeDisplay,
      csrfToken,
      clientId: record.clientId,
      scopes: record.scope,
    }), cookie);
  }

  return withCookie(renderDeviceLoginPage(c, {
    userCode: record.userCodeDisplay,
    csrfToken,
  }), cookie);
});

/**
 * Device login - POST
 * RFC 8628 §3.3
 *
 * Binding first, then CSRF, then credentials: the binding is what proves this is
 * the browser that submitted the user_code, and it must gate the step that would
 * otherwise let a forged POST establish an OP session in the victim's browser.
 */
deviceApp.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const submittedUserCode = String(body['user_code'] ?? '');
  const csrfToken = String(body['csrf_token'] ?? '');
  const username = String(body['username'] ?? '');
  const password = String(body['password'] ?? '');

  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return renderInvalidUserCode(c, submittedUserCode);
  }

  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(c.req.header('Cookie') ?? null, record.userCode),
    );
    validateVerificationCsrfToken(record, csrfToken);
  } catch (error) {
    return renderVerificationError(c, error);
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
      return renderErrorPage(c, {
        error: 'Too many login attempts',
        statusCode: 429,
      });
    }
    return renderDeviceLoginPage(c, {
      userCode: record.userCodeDisplay,
      csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failure.remainingAttempts,
    });
  }

  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // Two cookies on one response: the new OP session, and the binding cookie the
  // approval POST will have to present again.
  const withSession = withCookie(renderDeviceApprovalPage(c, {
    userCode: record.userCodeDisplay,
    csrfToken,
    clientId: record.clientId,
    scopes: record.scope,
  }), buildSessionCookie(sessionId));
  return withSession;
});

/**
 * Approve or deny - POST
 * RFC 8628 §3.3
 *
 * The only state-changing step of the UI, so it demands all three: an OP
 * session, the binding cookie, and the csrf_token.
 */
deviceApp.post('/approve', async (c) => {
  const body = await c.req.parseBody();
  const submittedUserCode = String(body['user_code'] ?? '');
  const csrfToken = String(body['csrf_token'] ?? '');
  const decision = String(body['decision'] ?? '');

  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const consentResolver = c.get('consentResolver');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return renderInvalidUserCode(c, submittedUserCode);
  }

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return renderErrorPage(c, {
      error: 'Sign in again to approve this device',
      statusCode: 401,
    });
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
      return withCookie(renderDeviceCompletedPage(c, {
        approved: true,
        clientId: approved.clientId,
      }), clearCookie);
    }

    await denyDeviceAuthorization({ record, store: deviceStore, csrfToken });
    return withCookie(renderDeviceCompletedPage(c, {
      approved: false,
      clientId: record.clientId,
    }), clearCookie);
  } catch (error) {
    return renderVerificationError(c, error);
  }
});
