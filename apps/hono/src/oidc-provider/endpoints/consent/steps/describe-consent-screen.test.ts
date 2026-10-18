import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { CSRF_TOKEN, TRANSACTION_ID, sampleTransaction } from '../../../../test-support/screens.js';
import { RESTRICTED_SCOPE_SUBJECTS } from '../../../scopes.js';
import { describeConsentScreen } from './describe-consent-screen.js';

describe('describeConsentScreen', () => {
  it('should describe the csrf_token, the client and the requested scopes', async () => {
    const { c, stores } = await providerContext();
    await stores.authSessionStore.set(TRANSACTION_ID, { subject: 'alice', authTime: 1700000000 });

    expect(await describeConsentScreen(c, TRANSACTION_ID, sampleTransaction({ scope: 'openid  profile email' }))).toEqual({
      kind: 'screen',
      csrfToken: CSRF_TOKEN,
      clientId: 'client-1',
      scopes: ['openid', 'profile', 'email'],
    });
  });

  describe('Scope policy', () => {
    beforeEach(() => {
      RESTRICTED_SCOPE_SUBJECTS['reports.read'] = ['bob'];
    });
    afterEach(() => {
      delete RESTRICTED_SCOPE_SUBJECTS['reports.read'];
    });

    // RFC 6749 §3.3: only what this End-User can be granted is asked for.
    it('should leave out the scopes the authenticated End-User cannot be granted', async () => {
      const { c, stores } = await providerContext();
      await stores.authSessionStore.set(TRANSACTION_ID, { subject: 'alice', authTime: 1700000000 });

      const screen = await describeConsentScreen(c, TRANSACTION_ID, sampleTransaction({ scope: 'openid reports.read' }));

      expect(screen.scopes).toEqual(['openid']);
    });

    it('should show the request as it is when no End-User is authenticated for the transaction', async () => {
      const { c } = await providerContext();

      const screen = await describeConsentScreen(c, TRANSACTION_ID, sampleTransaction({ scope: 'openid reports.read' }));

      expect(screen.scopes).toEqual(['openid', 'reports.read']);
    });
  });
});
