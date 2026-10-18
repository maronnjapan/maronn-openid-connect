import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { TRANSACTION_ID, sampleTransaction, storeTransaction } from '../../../../test-support/screens.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { denyAuthorizationRequest } from './deny-authorization.js';

const ISSUER = 'https://op.example.com';

async function setUp(transaction = sampleTransaction()) {
  const db = createEmptyDatabase();
  await storeTransaction(db, transaction);
  const { c, stores } = await providerContext({ db });
  await stores.authSessionStore.set(TRANSACTION_ID, { subject: 'alice', authTime: 1700000000 });
  return { c, db, transaction };
}

describe('denyAuthorizationRequest', () => {
  // OIDC Core 1.0 §3.1.2.6 / RFC 9207 §2
  it('should answer access_denied with the state and iss of the request', async () => {
    const { c, transaction } = await setUp();

    expect(await denyAuthorizationRequest(c, TRANSACTION_ID, transaction, ISSUER)).toEqual({
      kind: 'authorization_response',
      location:
        'https://rp.example.com/callback?error=access_denied&state=state-1&iss=https%3A%2F%2Fop.example.com',
      cookies: ['__Host-oidc_txn=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'],
    });
  });

  it('should finish the transaction and discard the login hand-off', async () => {
    const { c, db, transaction } = await setUp();

    await denyAuthorizationRequest(c, TRANSACTION_ID, transaction, ISSUER);

    expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
    expect(db.authSessions.has(TRANSACTION_ID)).toBe(false);
  });

  it('should leave out state for a request that carried none', async () => {
    const { c, transaction } = await setUp(sampleTransaction({ state: undefined }));

    expect(await denyAuthorizationRequest(c, TRANSACTION_ID, transaction, ISSUER)).toMatchObject({
      location: 'https://rp.example.com/callback?error=access_denied&iss=https%3A%2F%2Fop.example.com',
    });
  });
});
