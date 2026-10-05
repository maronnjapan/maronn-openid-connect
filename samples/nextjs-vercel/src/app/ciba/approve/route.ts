/**
 * EXPERIMENTAL — CIBA authentication device UI, approve or deny.
 *
 * The only state-changing step of the UI. It demands an OP session whose
 * subject owns the record, plus the per-record csrf_token from the
 * session-gated listing. No binding cookie is needed here: the approval is
 * already bound to the authenticated session, so knowing an auth_req_id gives
 * an attacker no step to forge.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { approveCibaRequest, denyCibaRequest } from '@maronn-openid-connect/experimental/ciba';
import { generateRandomString } from '@maronn-openid-connect/core';
import { errorPage } from '../../_oidc-provider/html';
import { readFormFields } from '../../_oidc-provider/http';
import { cibaAuthenticationRequestStore, resolvers, stores } from '../../_oidc-provider/provider';
import { parseSessionId } from '../../_oidc-provider/store';
import { completedScreen, verificationFailureScreen } from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const authReqId = String(form.get('auth_req_id') ?? '');
  const csrfToken = String(form.get('csrf_token') ?? '');
  const decision = String(form.get('decision') ?? '');

  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return errorPage('Sign in again to review this request', 401);
  }

  if (decision !== 'approve' && decision !== 'deny') {
    return errorPage('invalid_request', 400, 'decision must be approve or deny');
  }

  try {
    if (decision === 'approve') {
      // subject and csrf_token are validated inside; the record moves to
      // approved with auth_time, scope and a fresh grantId the token endpoint
      // reads.
      const grantId = generateRandomString(32);
      const approved = await approveCibaRequest({
        authReqId,
        subject: session.subject,
        csrfToken,
        authTime: session.authTime,
        grantId,
        store: cibaAuthenticationRequestStore,
      });

      // Record the consent the way /consent does, so a later Authorization Code
      // Flow for this client skips the consent screen (OIDC Core 1.0 §3.1.2.4),
      // and the grant, so withdrawing that consent revokes these tokens too.
      await resolvers.consentResolver.recordConsent?.(
        session.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      await resolvers.consentResolver.recordGrant(session.subject, approved.clientId, grantId);
      return completedScreen({ approved: true, clientId: approved.clientId });
    }

    const record = await cibaAuthenticationRequestStore.findByAuthReqId(authReqId);
    await denyCibaRequest({
      authReqId,
      subject: session.subject,
      csrfToken,
      store: cibaAuthenticationRequestStore,
    });
    return completedScreen({ approved: false, clientId: record?.clientId ?? '' });
  } catch (error) {
    return verificationFailureScreen(error);
  }
}
