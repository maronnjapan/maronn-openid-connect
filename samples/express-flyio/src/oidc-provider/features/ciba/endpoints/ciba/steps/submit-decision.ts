import { approveCibaRequest, denyCibaRequest } from '@maronn-openid-connect/experimental/ciba';
import { generateRandomString } from '@maronn-openid-connect/core';
import { parseSessionId } from '../../../../../cookies.js';
import { resolveGrantableScopes } from '../../../../../scopes.js';
import { type CibaOutcome, type CibaDecisionSubmission, verificationFailure } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'submit-decision',
  endpoint: 'ciba',
  feature: 'ciba',
  kind: 'persist',
  label: 'Approve or deny a pending request',
  spec: 'CIBA Core 1.0 §7.1 (authentication device)',
  function: 'submitCibaDecision',
  calls: ['approveCibaRequest', 'denyCibaRequest', 'consentResolver.recordConsent', 'consentResolver.recordGrant'],
  consumes: ['session'],
  produces: [],
  removable: false,
});

/**
 * Approve or deny (POST /ciba/approve)
 *
 * The only state-changing step of the UI. It demands an OP session whose
 * subject owns the record, plus the per-record csrf_token from the
 * session-gated listing.
 */
export async function submitCibaDecision(c: any, input: CibaDecisionSubmission): Promise<CibaOutcome> {
  const { authReqId, csrfToken, decision } = input;

  const browserSessionStore = c.get('browserSessionStore');
  const cibaStore = c.get('cibaAuthenticationRequestStore');
  const consentResolver = c.get('consentResolver');

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return { kind: 'session_required' };
  }

  if (decision !== 'approve' && decision !== 'deny') {
    return { kind: 'invalid_decision' };
  }

  try {
    if (decision === 'approve') {
      // subject and csrf_token are validated inside; the record moves to
      // approved with auth_time, scope and a fresh grantId the token endpoint
      // reads.
      const approved = await approveCibaRequest({
        authReqId,
        subject: session.subject,
        csrfToken,
        authTime: session.authTime,
        grantId: generateRandomString(32),
        store: cibaStore,
      });
      // Apply the scope policy to what was approved. approveCibaRequest()
      // copies the requested scope into approvedScope, so the policy is applied
      // to the record afterwards and persisted; the token endpoint reads
      // approvedScope, and RFC 6749 §3.3 allows a granted scope narrower than the
      // request. Write the policy in resolveGrantableScopes() (scopes.ts).
      approved.approvedScope = await resolveGrantableScopes(
        approved.approvedScope ?? approved.scope,
        session.subject,
      );
      await cibaStore.update(approved);

      // Record the consent the same way /consent does, so a later Authorization
      // Code Flow for this client skips the consent screen (OIDC Core 1.0 §3.1.2.4).
      await consentResolver?.recordConsent?.(
        approved.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      await consentResolver?.recordGrant?.(approved.subject, approved.clientId, approved.grantId);
      return { kind: 'completed', approved: true, clientId: approved.clientId };
    }

    const record = await cibaStore.findByAuthReqId(authReqId);
    await denyCibaRequest({
      authReqId,
      subject: session.subject,
      csrfToken,
      store: cibaStore,
    });
    return { kind: 'completed', approved: false, clientId: record?.clientId ?? '' };
  } catch (error) {
    return verificationFailure(error);
  }
}
