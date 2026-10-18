import { findPendingRecordByUserCode, issueVerificationBinding } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { buildDeviceBindingCookie } from '../../../cookies.js';
import { parseSessionId } from '../../../../../cookies.js';
import { resolveGrantableScopes } from '../../../../../scopes.js';
import { type DeviceOutcome, remainingTtlSeconds } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'submit-user-code',
  endpoint: 'device',
  feature: 'device-authorization-grant',
  kind: 'resolve',
  label: 'Match the user_code and bind this browser',
  spec: 'RFC 8628 §3.3',
  function: 'submitDeviceUserCode',
  calls: ['findPendingRecordByUserCode', 'issueVerificationBinding', 'buildDeviceBindingCookie'],
  consumes: [],
  produces: ['record', 'bindingCookie'],
  removable: false,
});

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
  const browserSessionStore = c.get('browserSessionStore');

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
      scopes: await resolveGrantableScopes(record.scope, session.subject),
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
