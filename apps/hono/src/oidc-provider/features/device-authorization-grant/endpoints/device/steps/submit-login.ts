import {
  findPendingRecordByUserCode,
  recordDeviceLoginFailure,
  validateVerificationBinding,
  validateVerificationCsrfToken,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { generateRandomString } from '@maronn-openid-connect/core';
import { buildSessionCookie } from '../../../../../cookies.js';
import { parseDeviceBindingSecret } from '../../../cookies.js';
import { deviceAuthorizationConfig } from '../../../config.js';
import { resolveGrantableScopes } from '../../../../../scopes.js';
import { type DeviceOutcome, type DeviceLoginSubmission, verificationFailure } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'submit-login',
  endpoint: 'device',
  feature: 'device-authorization-grant',
  kind: 'validate',
  label: 'Sign the End-User in on this browser',
  spec: 'RFC 8628 §3.3',
  function: 'submitDeviceLogin',
  calls: ['findPendingRecordByUserCode', 'validateVerificationBinding', 'validateVerificationCsrfToken', 'recordDeviceLoginFailure', 'buildSessionCookie'],
  consumes: ['record', 'bindingCookie'],
  produces: ['session'],
  removable: false,
});

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
  const browserSessionStore = c.get('browserSessionStore');
  const authenticateUser = c.get('authenticateUser');

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
    scopes: await resolveGrantableScopes(record.scope, user.sub),
    cookies: [buildSessionCookie(sessionId)],
  };
}
