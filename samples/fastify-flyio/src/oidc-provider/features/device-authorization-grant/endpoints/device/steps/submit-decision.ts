import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  findPendingRecordByUserCode,
  validateVerificationBinding,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { buildClearedDeviceBindingCookie, parseDeviceBindingSecret } from '../../../cookies.js';
import { parseSessionId } from '../../../../../cookies.js';
import { resolveGrantableScopes } from '../../../../../scopes.js';
import { type DeviceOutcome, type DeviceDecisionSubmission, verificationFailure } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'submit-decision',
  endpoint: 'device',
  feature: 'device-authorization-grant',
  kind: 'persist',
  label: 'Approve or deny the device',
  spec: 'RFC 8628 §3.3',
  function: 'submitDeviceDecision',
  calls: ['findPendingRecordByUserCode', 'validateVerificationBinding', 'approveDeviceAuthorization', 'denyDeviceAuthorization', 'consentResolver.recordConsent', 'consentResolver.recordGrant'],
  consumes: ['record', 'bindingCookie', 'session'],
  produces: [],
  removable: false,
});

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
  const browserSessionStore = c.get('browserSessionStore');
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

      // Apply the scope policy to what was approved. approveDeviceAuthorization()
      // copies the requested scope into approvedScope, so the policy is applied
      // to the record afterwards and persisted; the token endpoint reads
      // approvedScope, and RFC 6749 §3.3 allows a granted scope narrower than the
      // request. Write the policy in resolveGrantableScopes() (scopes.ts).
      approved.approvedScope = await resolveGrantableScopes(
        approved.approvedScope ?? approved.scope,
        session.subject,
      );
      await deviceStore.update(approved);

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
