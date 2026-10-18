import type { OidcProviderOptions } from '../../../app.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizationRedirectOf,
  CLIENT_ID,
  CODE_CHALLENGE,
  NONCE,
  recordingResponseMode,
  REDIRECT_URI,
  SESSION_ID,
  STATE,
  storeTransaction,
  SUBJECT,
  TRANSACTION_ID,
  transactionOf,
} from '../../../../test-support/authorize.js';
import { providerContext, TEST_ISSUER } from '../../../../test-support/context.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { issueAuthorizationCodeResponse } from './issue-authorization-code.js';

const NOW_SECONDS = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
const AUTH_TIME = NOW_SECONDS - 30;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;

/** Issue the code for the stored transaction of the signed-in End-User. */
async function issue(
  input: { options?: Partial<OidcProviderOptions>; responseMode?: AuthorizationResponseMode } = {},
) {
  const context = await providerContext({ options: input.options });
  const transaction = transactionOf({ scope: 'openid profile' });
  await storeTransaction(context.stores, transaction);
  const outcome = await issueAuthorizationCodeResponse(context.c, {
    transactionId: TRANSACTION_ID,
    transaction,
    session: { subject: SUBJECT, authTime: AUTH_TIME, sessionId: SESSION_ID },
    issuer: TEST_ISSUER,
    responseMode: input.responseMode,
  });
  return { ...context, outcome };
}

describe('issueAuthorizationCodeResponse', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Authorization response', () => {
    // OIDC Core 1.0 §3.1.2.5 / RFC 9207 §2
    it('should redirect to the redirect_uri with the stored code, the state and iss', async () => {
      const { db, outcome } = await issue();

      const { target, params } = authorizationRedirectOf(outcome);

      expect(target).toBe(REDIRECT_URI);
      expect(params).toEqual({ code: expect.stringMatching(RANDOM_VALUE), state: STATE, iss: TEST_ISSUER });
      expect([...db.codes.keys()]).toEqual([params['code']]);
    });

    it('should hand the code and the state to the response mode the request asked for', async () => {
      const { responseMode, redirect } = recordingResponseMode();

      const { db, outcome } = await issue({ responseMode });

      expect(outcome).toEqual({ kind: 'authorization_response', location: 'https://rp.example.com/callback?response=recorded' });
      expect(redirect.mock.calls).toEqual([[REDIRECT_URI, { code: [...db.codes.keys()][0], state: STATE }]]);
    });
  });

  describe('Stored code', () => {
    // OIDC Core 1.0 §3.1.3.1: the code carries the request for the token endpoint
    // and is short-lived (authorizationCodeTtl, 300 seconds by default).
    it('should store the code with the request of the transaction, the session and a five-minute lifetime', async () => {
      const { db } = await issue();

      expect([...db.codes.values()]).toEqual([
        {
          code: expect.stringMatching(RANDOM_VALUE),
          grantId: expect.stringMatching(RANDOM_VALUE),
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          redirectUriExplicit: true,
          scope: ['openid', 'profile'],
          subject: SUBJECT,
          used: false,
          expiresAt: NOW_SECONDS + 300,
          authTime: AUTH_TIME,
          codeChallenge: CODE_CHALLENGE,
          codeChallengeMethod: 'S256',
          nonce: NONCE,
          sessionId: SESSION_ID,
          transactionId: TRANSACTION_ID,
        },
      ]);
    });

    it('should give the code the lifetime the provider settings configure', async () => {
      const { db } = await issue({ options: { config: { authorizationCodeTtl: 60 } } });

      expect([...db.codes.values()].map((code) => code.expiresAt)).toEqual([NOW_SECONDS + 60]);
    });

    // OAuth 2.1 §4.1.2: a transaction yields one code at most.
    it('should delete the transaction', async () => {
      const { db } = await issue();

      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
    });

    // Removing the End-User's consent later revokes the tokens of this grant.
    it('should record the grant under the consent of the End-User to the client', async () => {
      const { db } = await issue();

      const [code] = [...db.codes.values()];
      expect(db.consentGrants.get(SUBJECT)?.get(CLIENT_ID)).toEqual(new Set([code?.grantId]));
    });

    it('should issue the code without recording a grant when the consent resolver does not record grants', async () => {
      const { db, outcome } = await issue({
        options: { consentResolver: { hasConsent: async () => true } },
      });

      expect(authorizationRedirectOf(outcome).params).toEqual({
        code: [...db.codes.keys()][0],
        state: STATE,
        iss: TEST_ISSUER,
      });
      expect(db.consentGrants.size).toBe(0);
    });
  });
});
