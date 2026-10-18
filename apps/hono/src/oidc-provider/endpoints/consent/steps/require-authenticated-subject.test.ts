import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { TRANSACTION_ID } from '../../../../test-support/screens.js';
import { requireAuthenticatedSubject } from './require-authenticated-subject.js';

describe('requireAuthenticatedSubject', () => {
  it('should return the subject the login step stored for the transaction', async () => {
    const { c, stores } = await providerContext();
    await stores.authSessionStore.set(TRANSACTION_ID, { subject: 'alice', authTime: 1700000000, sessionId: 'sid-1' });

    expect(await requireAuthenticatedSubject(c, TRANSACTION_ID)).toEqual({
      subject: 'alice',
      authTime: 1700000000,
      sessionId: 'sid-1',
    });
  });

  it('should return undefined when the login step was skipped', async () => {
    const { c, stores } = await providerContext();
    await stores.authSessionStore.set('another-transaction', { subject: 'alice', authTime: 1700000000 });

    expect(await requireAuthenticatedSubject(c, TRANSACTION_ID)).toBeUndefined();
  });
});
