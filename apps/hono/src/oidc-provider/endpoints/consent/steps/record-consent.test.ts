import type { AuthorizationCodeData } from '@maronn-openid-connect/core';
import { describe, expect, it, vi } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { REDIRECT_URI, TRANSACTION_ID, sampleTransaction } from '../../../../test-support/screens.js';
import { recordConsentDecision } from './record-consent.js';

const session = { subject: 'alice', authTime: 1700000000, sessionId: 'sid-1' };

const authCodeData: AuthorizationCodeData = {
  code: 'code-1',
  grantId: 'grant-1',
  clientId: 'client-1',
  redirectUri: REDIRECT_URI,
  redirectUriExplicit: true,
  scope: ['openid', 'profile'],
  subject: 'alice',
  used: false,
  expiresAt: 1700000300,
};

describe('recordConsentDecision', () => {
  // OIDC Core 1.0 §3.1.2.1: a later prompt=none confirms the consent without UI.
  it('should record the granted scopes so a later request finds the consent', async () => {
    const { c, stores } = await providerContext();

    await recordConsentDecision(c, TRANSACTION_ID, sampleTransaction(), session, authCodeData, ['openid', 'profile']);

    expect(await stores.consentStore.hasConsent('alice', 'client-1', ['openid', 'profile'])).toBe(true);
  });

  it('should record the grant of the code under the consent', async () => {
    const { c, db } = await providerContext();

    await recordConsentDecision(c, TRANSACTION_ID, sampleTransaction(), session, authCodeData, ['openid']);

    expect([...(db.consentGrants.get('alice')?.get('client-1') ?? [])]).toEqual(['grant-1']);
  });

  it('should discard the login hand-off and keep the browser session', async () => {
    const { c, db, stores } = await providerContext();
    await stores.authSessionStore.set(TRANSACTION_ID, session);
    await stores.browserSessionStore.set('sid-1', { subject: 'alice', authTime: 1700000000 });

    await recordConsentDecision(c, TRANSACTION_ID, sampleTransaction(), session, authCodeData, ['openid']);

    expect(db.authSessions.has(TRANSACTION_ID)).toBe(false);
    expect(db.browserSessions.has('sid-1')).toBe(true);
  });

  it('should work with a consentResolver that implements only recordConsent', async () => {
    const { c } = await providerContext();
    const recordConsent = vi.fn(async () => {});
    c.set('consentResolver', { hasConsent: async () => false, recordConsent });

    await recordConsentDecision(c, TRANSACTION_ID, sampleTransaction(), session, authCodeData, ['openid']);

    expect(recordConsent).toHaveBeenCalledWith('alice', 'client-1', ['openid']);
  });
});
