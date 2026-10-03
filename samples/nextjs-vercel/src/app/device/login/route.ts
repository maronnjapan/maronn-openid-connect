/**
 * EXPERIMENTAL — device verification UI, step 2: sign in (RFC 8628 §3.3).
 *
 * Binding first, then CSRF, then credentials: the binding proves this is the
 * browser that submitted the user_code, and it must gate the step that would
 * otherwise let a forged POST plant an OP session in the victim's browser
 * (login CSRF).
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import {
  findPendingRecordByUserCode,
  recordDeviceLoginFailure,
  validateVerificationBinding,
  validateVerificationCsrfToken,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { generateRandomString } from '@maronn-openid-connect/core';
import { errorPage, readFormFields } from '../../_oidc-provider/html';
import { deviceAuthorizationStore, stores } from '../../_oidc-provider/provider';
import { buildSessionCookie, parseDeviceBindingSecret } from '../../_oidc-provider/store';
import { deviceAuthorizationConfig } from '../../device_authorization/config';
import {
  approvalScreen,
  invalidUserCodeScreen,
  loginScreen,
  verificationFailureScreen,
} from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const submittedUserCode = String(form.get('user_code') ?? '');
  const csrfToken = String(form.get('csrf_token') ?? '');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceAuthorizationStore);
  if (!record) {
    return invalidUserCodeScreen(submittedUserCode);
  }

  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(request.headers.get('Cookie'), record.userCode),
    );
    validateVerificationCsrfToken(record, csrfToken);
  } catch (error) {
    return verificationFailureScreen(error);
  }

  // Swap point: replace this with your own credential check (LDAP, WebAuthn, an
  // upstream IdP) without touching anything above or below it.
  const user = await stores.userStore.authenticate(
    String(form.get('username') ?? ''),
    String(form.get('password') ?? ''),
  );
  if (!user) {
    // Per-record throttling only. An attacker holding a device-grant client can
    // mint unlimited records, so the aggregate password-guess budget is the same
    // as the one on /login. Subject-scoped throttling is a separate concern.
    const failure = await recordDeviceLoginFailure(
      record,
      deviceAuthorizationStore,
      deviceAuthorizationConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // The record is now denied: the device gets access_denied on its next poll.
      return errorPage('Too many login attempts', 429);
    }
    return loginScreen({
      userCode: record.userCodeDisplay,
      csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failure.remainingAttempts,
    });
  }

  const sessionId = generateRandomString(32);
  await stores.browserSessionStore.set(sessionId, {
    subject: user.sub,
    authTime: Math.floor(Date.now() / 1000),
  });

  // The new OP session travels with the approval screen; the approval step has
  // to present the binding cookie again as well.
  return approvalScreen(
    {
      userCode: record.userCodeDisplay,
      csrfToken,
      clientId: record.clientId,
      scopes: record.scope,
    },
    [buildSessionCookie(sessionId)],
  );
}
