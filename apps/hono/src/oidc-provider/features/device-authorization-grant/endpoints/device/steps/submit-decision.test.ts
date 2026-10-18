import { issueVerificationBinding } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { describe, expect, it } from 'vitest';
import {
  cookieHeaderOf,
  pendingDeviceRecord,
  SESSION_AUTH_TIME,
  signInBrowser,
} from '../../../../../../test-support/browser-flows.js';
import { providerContext, requestTo } from '../../../../../../test-support/context.js';
import { createEmptyDatabase } from '../../../../../db/memory/database.js';
import { createProviderStores } from '../../../../../db/memory/stores.js';
import { buildClearedDeviceBindingCookie, buildDeviceBindingCookie } from '../../../cookies.js';
import { InMemoryDeviceAuthorizationStore } from '../../../store.js';
import { submitDeviceDecision } from './submit-decision.js';

/**
 * A pending record whose binding was issued, and a context for POST
 * /device/approve from a browser with alice's OP session (unless signedIn is
 * false) and the binding cookie (unless binding is false).
 */
async function decisionContext(input: { signedIn?: boolean; binding?: boolean } = {}) {
  const db = createEmptyDatabase();
  const session = await signInBrowser(createProviderStores(db), 'alice');
  const store = new InMemoryDeviceAuthorizationStore();
  const record = pendingDeviceRecord({ scope: ['openid', 'email'] });
  await store.save(record);
  const { bindingSecret, csrfToken } = await issueVerificationBinding(record, store);
  const cookies = [
    ...(input.signedIn === false ? [] : [session.cookie]),
    ...(input.binding === false ? [] : [cookieHeaderOf([buildDeviceBindingCookie('BCDFGHJK', bindingSecret, 600)])]),
  ];
  const { c, db: database, stores } = await providerContext({
    db,
    request: requestTo('/device/approve', { method: 'POST', headers: { Cookie: cookies.join('; ') } }),
  });
  c.set('deviceAuthorizationStore', store);
  return { c, db: database, stores, record, csrfToken };
}

describe('submitDeviceDecision', () => {
  it('should answer invalid_user_code when the code matches no pending record', async () => {
    const { c, csrfToken } = await decisionContext();

    expect(await submitDeviceDecision(c, { userCode: 'ZZZZ-ZZZZ', csrfToken, decision: 'approve' })).toEqual({
      kind: 'invalid_user_code',
      userCode: 'ZZZZ-ZZZZ',
    });
  });

  it('should answer session_required and leave the record pending without an OP session', async () => {
    const { c, record, csrfToken } = await decisionContext({ signedIn: false });

    expect(await submitDeviceDecision(c, { userCode: 'BCDF-GHJK', csrfToken, decision: 'approve' })).toEqual({
      kind: 'session_required',
    });
    expect(record.status).toBe('pending');
  });

  // RFC 8628 §5.4: without the binding cookie a forged approval (consent coercion) is refused.
  it('should answer a 403 error and leave the record pending without the binding cookie', async () => {
    const { c, record, csrfToken } = await decisionContext({ binding: false });

    expect(await submitDeviceDecision(c, { userCode: 'BCDF-GHJK', csrfToken, decision: 'approve' })).toEqual({
      kind: 'error',
      error: 'Device verification binding is missing',
      statusCode: 403,
    });
    expect(record.status).toBe('pending');
  });

  it('should answer a 403 error when the csrf_token does not match the record', async () => {
    const { c, record } = await decisionContext();

    expect(await submitDeviceDecision(c, { userCode: 'BCDF-GHJK', csrfToken: 'forged', decision: 'approve' })).toEqual({
      kind: 'error',
      error: 'CSRF token mismatch',
      statusCode: 403,
    });
    expect(record.status).toBe('pending');
  });

  // RFC 8628 §3.3 / §3.5: the device receives tokens for the approved record on its next poll.
  it('should approve the record for the session user, record the consent and clear the binding cookie', async () => {
    const { c, db, stores, record, csrfToken } = await decisionContext();

    const outcome = await submitDeviceDecision(c, { userCode: 'BCDF-GHJK', csrfToken, decision: 'approve' });

    expect(outcome).toEqual({
      kind: 'completed',
      approved: true,
      clientId: 'device-client',
      cookies: [buildClearedDeviceBindingCookie('BCDFGHJK')],
    });
    expect(record).toMatchObject({
      status: 'approved',
      subject: 'alice',
      authTime: SESSION_AUTH_TIME,
      approvedScope: ['openid', 'email'],
      bindingHash: null,
      csrfToken: null,
    });
    expect(record.grantId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // OIDC Core 1.0 §3.1.2.4: a later authorization code flow skips the consent screen.
    expect(await stores.consentStore.hasConsent('alice', 'device-client', ['openid', 'email'])).toBe(true);
    expect([...(db.consentGrants.get('alice')?.get('device-client') ?? [])]).toEqual([record.grantId]);
  });

  it('should deny the record for any decision other than approve and record no consent', async () => {
    const { c, stores, record, csrfToken } = await decisionContext();

    const outcome = await submitDeviceDecision(c, { userCode: 'BCDF-GHJK', csrfToken, decision: 'deny' });

    expect(outcome).toEqual({
      kind: 'completed',
      approved: false,
      clientId: 'device-client',
      cookies: [buildClearedDeviceBindingCookie('BCDFGHJK')],
    });
    expect(record).toMatchObject({ status: 'denied', bindingHash: null, csrfToken: null });
    expect(await stores.consentStore.hasConsent('alice', 'device-client', ['openid'])).toBe(false);
  });
});
