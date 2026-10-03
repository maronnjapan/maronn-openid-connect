/**
 * EXPERIMENTAL — device verification UI, step 3: approve or deny
 * (RFC 8628 §3.3).
 *
 * The only state-changing step of the UI, so it demands all three: an OP
 * session, the binding cookie, and the csrf_token. The device learns the
 * outcome by polling the token endpoint.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  findPendingRecordByUserCode,
  validateVerificationBinding,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { errorPage, readFormFields } from '../../_oidc-provider/html';
import { deviceAuthorizationStore, resolvers, stores } from '../../_oidc-provider/provider';
import {
  buildClearedDeviceBindingCookie,
  parseDeviceBindingSecret,
  parseSessionId,
} from '../../_oidc-provider/store';
import { completedScreen, invalidUserCodeScreen, verificationFailureScreen } from '../screens';

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

  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return errorPage('Sign in again to approve this device', 401);
  }

  // The decision ends the verification; drop its binding cookie.
  const clearBindingCookie = buildClearedDeviceBindingCookie(record.userCode);
  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(request.headers.get('Cookie'), record.userCode),
    );

    if (String(form.get('decision') ?? '') === 'approve') {
      // csrf_token is validated inside; the record moves to approved with the
      // subject, auth_time, scope and a fresh grantId the token endpoint reads.
      const approved = await approveDeviceAuthorization({
        record,
        store: deviceAuthorizationStore,
        csrfToken,
        subject: session.subject,
        authTime: session.authTime,
      });

      // Record the consent the way /consent does, so a later Authorization Code
      // Flow for this client skips the consent screen (OIDC Core 1.0 §3.1.2.4),
      // and the grant, so withdrawing that consent revokes these tokens too.
      await resolvers.consentResolver.recordConsent?.(
        session.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      if (approved.grantId) {
        await resolvers.consentResolver.recordGrant(session.subject, approved.clientId, approved.grantId);
      }
      return completedScreen({ approved: true, clientId: approved.clientId }, [clearBindingCookie]);
    }

    // Anything but 'approve' denies.
    await denyDeviceAuthorization({ record, store: deviceAuthorizationStore, csrfToken });
    return completedScreen({ approved: false, clientId: record.clientId }, [clearBindingCookie]);
  } catch (error) {
    return verificationFailureScreen(error);
  }
}
