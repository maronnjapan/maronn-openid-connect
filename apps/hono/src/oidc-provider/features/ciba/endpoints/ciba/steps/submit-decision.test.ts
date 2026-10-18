import { createInMemoryCibaAuthenticationRequestStore } from '@maronn-openid-connect/experimental/ciba';
import { describe, expect, it } from 'vitest';
import { pendingCibaRecord, SESSION_AUTH_TIME, signInBrowser } from '../../../../../../test-support/browser-flows.js';
import { providerContext, requestTo } from '../../../../../../test-support/context.js';
import { createEmptyDatabase } from '../../../../../db/memory/database.js';
import { createProviderStores } from '../../../../../db/memory/stores.js';
import { submitCibaDecision } from './submit-decision.js';

/**
 * A pending request for alice whose csrf_token the listing issued, and a
 * context for POST /ciba/approve from a browser with alice's OP session
 * (unless signedIn is false).
 */
async function decisionContext(input: { signedIn?: boolean; subject?: string } = {}) {
  const db = createEmptyDatabase();
  const session = await signInBrowser(createProviderStores(db), 'alice');
  const headers: Record<string, string> = input.signedIn === false ? {} : { Cookie: session.cookie };
  const { c, stores } = await providerContext({ db, request: requestTo('/ciba/approve', { method: 'POST', headers }) });
  const store = createInMemoryCibaAuthenticationRequestStore();
  const record = pendingCibaRecord({ subject: input.subject ?? 'alice', csrfToken: 'csrf-1' });
  await store.save(record);
  c.set('cibaAuthenticationRequestStore', store);
  return { c, db, stores, record };
}

describe('submitCibaDecision', () => {
  it('should answer session_required and leave the request pending without an OP session', async () => {
    const { c, record } = await decisionContext({ signedIn: false });

    expect(await submitCibaDecision(c, { authReqId: record.authReqId, csrfToken: 'csrf-1', decision: 'approve' })).toEqual({
      kind: 'session_required',
    });
    expect(record.status).toBe('pending');
  });

  it('should answer invalid_decision for a decision that is neither approve nor deny', async () => {
    const { c, record } = await decisionContext();

    expect(await submitCibaDecision(c, { authReqId: record.authReqId, csrfToken: 'csrf-1', decision: 'maybe' })).toEqual({
      kind: 'invalid_decision',
    });
    expect(record.status).toBe('pending');
  });

  // CIBA Core 1.0 §11: the client receives tokens for the approved request on its next poll.
  it('should approve the request with the session auth_time, record the consent and the grant', async () => {
    const { c, db, stores, record } = await decisionContext();

    expect(await submitCibaDecision(c, { authReqId: record.authReqId, csrfToken: 'csrf-1', decision: 'approve' })).toEqual({
      kind: 'completed',
      approved: true,
      clientId: 'ciba-client',
    });
    expect(record).toMatchObject({
      status: 'approved',
      authTime: SESSION_AUTH_TIME,
      approvedScope: ['openid', 'profile'],
      csrfToken: null,
    });
    expect(record.grantId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // OIDC Core 1.0 §3.1.2.4: a later authorization code flow skips the consent screen.
    expect(await stores.consentStore.hasConsent('alice', 'ciba-client', ['openid', 'profile'])).toBe(true);
    expect([...(db.consentGrants.get('alice')?.get('ciba-client') ?? [])]).toEqual([record.grantId]);
  });

  it('should deny the request and record no consent', async () => {
    const { c, stores, record } = await decisionContext();

    expect(await submitCibaDecision(c, { authReqId: record.authReqId, csrfToken: 'csrf-1', decision: 'deny' })).toEqual({
      kind: 'completed',
      approved: false,
      clientId: 'ciba-client',
    });
    expect(record).toMatchObject({ status: 'denied', csrfToken: null });
    expect(await stores.consentStore.hasConsent('alice', 'ciba-client', ['openid'])).toBe(false);
  });

  // The approval is bound to the OP session: another user's request cannot be decided.
  it("should answer a 403 error and leave another user's request pending", async () => {
    const { c, record } = await decisionContext({ subject: 'bob' });

    expect(await submitCibaDecision(c, { authReqId: record.authReqId, csrfToken: 'csrf-1', decision: 'approve' })).toEqual({
      kind: 'error',
      error: 'The authentication request could not be verified',
      statusCode: 403,
    });
    expect(record.status).toBe('pending');
  });

  it('should answer a 403 error when the csrf_token does not match the request', async () => {
    const { c, record } = await decisionContext();

    expect(await submitCibaDecision(c, { authReqId: record.authReqId, csrfToken: 'forged', decision: 'deny' })).toEqual({
      kind: 'error',
      error: 'The authentication request could not be verified',
      statusCode: 403,
    });
    expect(record.status).toBe('pending');
  });
});
