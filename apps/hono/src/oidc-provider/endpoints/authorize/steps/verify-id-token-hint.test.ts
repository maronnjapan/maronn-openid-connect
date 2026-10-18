import { describe, expect, it } from 'vitest';
import {
  authorizationRedirectOf,
  idTokenHintFor,
  REDIRECT_URI,
  STATE,
  storeTransaction,
  SUBJECT,
  TRANSACTION_ID,
  transactionOf,
} from '../../../../test-support/authorize.js';
import { providerContext, TEST_ISSUER } from '../../../../test-support/context.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { verifyIdTokenHint } from './verify-id-token-hint.js';

describe('verifyIdTokenHint', () => {
  describe('Verified hint', () => {
    it('should return no subject when the request carries no id_token_hint', async () => {
      const { c } = await providerContext();

      expect(await verifyIdTokenHint(c, TRANSACTION_ID, transactionOf(), TEST_ISSUER, undefined)).toEqual({
        verifiedHintSubject: undefined,
      });
    });

    // OIDC Core 1.0 §3.1.2.1: the hint is an ID Token the OP itself issued,
    // verified against the OP's ID Token signing keys by default.
    it('should return the subject of a hint the provider signed for the client', async () => {
      const { c, signingKey } = await providerContext();
      const transaction = transactionOf({ idTokenHint: await idTokenHintFor(signingKey) });

      expect(await verifyIdTokenHint(c, TRANSACTION_ID, transaction, TEST_ISSUER, undefined)).toEqual({
        verifiedHintSubject: SUBJECT,
      });
    });
  });

  // OIDC Core 1.0 §3.1.2.1: a hint that does not verify is a redirectable
  // error, and the transaction is dropped.
  describe('Rejected hint', () => {
    it('should redirect login_required and drop the transaction for a hint issued to another client', async () => {
      const { c, db, signingKey, stores } = await providerContext();
      const transaction = transactionOf({ idTokenHint: await idTokenHintFor(signingKey, { aud: 'other-client' }) });
      await storeTransaction(stores, transaction);

      const outcome = await verifyIdTokenHint(c, TRANSACTION_ID, transaction, TEST_ISSUER, undefined);

      expect(authorizationRedirectOf(outcome)).toEqual({
        target: REDIRECT_URI,
        params: {
          error: 'login_required',
          error_description: 'id_token_hint aud does not match expected audience',
          state: STATE,
          iss: TEST_ISSUER,
        },
      });
      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
    });

    it('should redirect login_required for a hint signed with a key the provider does not publish', async () => {
      const { c } = await providerContext();
      const foreignKey = await rs256Key('foreign-key');
      const transaction = transactionOf({ idTokenHint: await idTokenHintFor(foreignKey) });

      const outcome = await verifyIdTokenHint(c, TRANSACTION_ID, transaction, TEST_ISSUER, undefined);

      expect(authorizationRedirectOf(outcome).params).toEqual({
        error: 'login_required',
        error_description: 'No JWK matched the id_token_hint header',
        state: STATE,
        iss: TEST_ISSUER,
      });
    });

    it('should redirect login_required with the failure message when the key set cannot be loaded', async () => {
      const { c, signingKey } = await providerContext();
      c.set('jwksProvider', () => {
        throw new Error('JWKS is unavailable');
      });
      const transaction = transactionOf({ idTokenHint: await idTokenHintFor(signingKey) });

      const outcome = await verifyIdTokenHint(c, TRANSACTION_ID, transaction, TEST_ISSUER, undefined);

      expect(authorizationRedirectOf(outcome).params).toEqual({
        error: 'login_required',
        error_description: 'JWKS is unavailable',
        state: STATE,
        iss: TEST_ISSUER,
      });
    });

    it('should redirect login_required and drop the transaction when no jwksProvider is configured', async () => {
      const { c, db, signingKey, stores } = await providerContext();
      c.set('jwksProvider', undefined);
      const transaction = transactionOf({ idTokenHint: await idTokenHintFor(signingKey) });
      await storeTransaction(stores, transaction);

      const outcome = await verifyIdTokenHint(c, TRANSACTION_ID, transaction, TEST_ISSUER, undefined);

      expect(authorizationRedirectOf(outcome).params).toEqual({
        error: 'login_required',
        error_description: 'jwksProvider is not configured; cannot verify id_token_hint',
        state: STATE,
        iss: TEST_ISSUER,
      });
      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
    });
  });
});
