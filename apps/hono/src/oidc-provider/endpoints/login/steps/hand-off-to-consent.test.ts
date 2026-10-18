import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { TRANSACTION_ID } from '../../../../test-support/screens.js';
import { handOffToConsent } from './hand-off-to-consent.js';

describe('handOffToConsent', () => {
  it('should store the subject, auth_time and session id for the consent step of the transaction', async () => {
    const { c, db } = await providerContext();

    await handOffToConsent(c, TRANSACTION_ID, 'alice', 'sid-1', 1700000000);

    expect(db.authSessions.get(TRANSACTION_ID)).toEqual({ subject: 'alice', authTime: 1700000000, sessionId: 'sid-1' });
  });

  // OIDC Core 1.0 §3.1.2.3: the session cookie travels with the answer.
  it('should answer authenticated with the session cookie', async () => {
    const { c } = await providerContext();

    expect(await handOffToConsent(c, TRANSACTION_ID, 'alice', 'sid-1', 1700000000)).toEqual({
      kind: 'authenticated',
      cookies: ['session_id=sid-1; HttpOnly; Secure; SameSite=Lax; Path=/'],
    });
  });
});
