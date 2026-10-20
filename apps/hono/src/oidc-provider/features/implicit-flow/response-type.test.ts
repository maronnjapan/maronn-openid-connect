import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ID,
  NONCE,
  RECORDED_RESPONSE,
  recordingResponseMode,
  REDIRECT_URI,
  registerTestClient,
  SESSION_ID,
  STATE,
  storeTransaction,
  SUBJECT,
  TRANSACTION_ID,
  transactionOf,
} from '../../../test-support/authorize.js';
import { providerContext, TEST_ISSUER } from '../../../test-support/context.js';
import { decodeJwt } from '../../../test-support/token.js';
import type { OidcProviderOptions } from '../../app.js';
import type { AuthorizationResponseMode } from '../../endpoints/authorize/response-mode.js';
import { implicitResponseTypeHandler } from './response-type.js';

const NOW_SECONDS = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
const AUTH_TIME = NOW_SECONDS - 30;

/** Answer the stored Implicit Flow transaction of the signed-in End-User. */
async function respond(
  responseType: 'id_token token' | 'id_token',
  input: { options?: Partial<OidcProviderOptions>; responseMode?: AuthorizationResponseMode; scope?: string } = {},
) {
  const context = await providerContext({ options: input.options });
  await registerTestClient(context.db);
  const transaction = transactionOf({ responseType, scope: input.scope ?? 'openid profile' });
  await storeTransaction(context.stores, transaction);
  const outcome = await implicitResponseTypeHandler.respond(context.c, {
    transactionId: TRANSACTION_ID,
    transaction,
    session: { subject: SUBJECT, authTime: AUTH_TIME, sessionId: SESSION_ID },
    issuer: TEST_ISSUER,
    responseMode: input.responseMode,
  });
  return { ...context, outcome };
}

/** The redirect target and the parameters in the fragment of the outcome. */
function fragmentOf(outcome: unknown): { target: string; params: Record<string, string> } {
  expect(outcome).toMatchObject({ kind: 'authorization_response', response: { method: 'redirect', location: expect.any(String) } });
  const url = new URL((outcome as { response: { location: string } }).response.location);
  return { target: url.origin + url.pathname, params: Object.fromEntries(new URLSearchParams(url.hash.slice(1))) };
}

describe('implicitResponseTypeHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // OIDC Core 1.0 §3.2.2.1
  it('should answer response_type=id_token and id_token token', () => {
    expect(implicitResponseTypeHandler.names).toEqual(['id_token', 'id_token token']);
  });

  describe('Authorization response', () => {
    // OIDC Core 1.0 §3.2.2.5 / RFC 9207 §2: no code; the tokens, the state and
    // iss in the fragment, the default response mode of the response type.
    it('should redirect with the access token, the ID Token, the state and iss in the fragment', async () => {
      const { db, outcome } = await respond('id_token token');

      const { target, params } = fragmentOf(outcome);
      expect(target).toBe(REDIRECT_URI);
      expect(params).toEqual({
        access_token: expect.any(String),
        token_type: 'Bearer',
        expires_in: '3600',
        scope: 'openid profile',
        id_token: expect.any(String),
        state: STATE,
        iss: TEST_ISSUER,
      });
      expect(db.codes.size).toBe(0);
    });

    // OIDC Core 1.0 §3.2.2.10: the ID Token carries the nonce of the request
    // and the time the End-User authenticated.
    it('should issue the ID Token of response_type=id_token for the End-User with the nonce and auth_time', async () => {
      const { outcome } = await respond('id_token');

      const { params } = fragmentOf(outcome);
      expect(Object.keys(params)).toEqual(['id_token', 'state', 'iss']);
      expect(decodeJwt(params['id_token'] ?? '').payload).toMatchObject({
        sub: SUBJECT,
        aud: CLIENT_ID,
        nonce: NONCE,
        auth_time: AUTH_TIME,
      });
    });

    it('should hand the tokens and the state to the response mode the request asked for', async () => {
      const { responseMode, respond: recorded } = recordingResponseMode('form_post');

      const { outcome } = await respond('id_token', { responseMode });

      expect(outcome).toEqual({ kind: 'authorization_response', response: RECORDED_RESPONSE });
      expect(recorded.mock.calls).toEqual([[REDIRECT_URI, { id_token: expect.any(String), state: STATE }]]);
    });
  });

  describe('Grant', () => {
    // One-time use, as for a code (OAuth 2.1 §4.1.2).
    it('should delete the transaction', async () => {
      const { db } = await respond('id_token token');

      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
    });

    // Withdrawing the consent revokes the access token of the grant.
    it('should record the grant of the access token under the consent of the End-User to the client', async () => {
      const { db } = await respond('id_token token');

      const [record] = [...db.accessTokens.values()];
      expect(db.consentGrants.get(SUBJECT)?.get(CLIENT_ID)).toEqual(new Set([record?.grantId]));
    });

    it('should answer without recording a grant when the consent resolver does not record grants', async () => {
      const { db, outcome } = await respond('id_token token', {
        options: { consentResolver: { hasConsent: async () => true } },
      });

      expect(Object.keys(fragmentOf(outcome).params)).toEqual([
        'access_token',
        'token_type',
        'expires_in',
        'scope',
        'id_token',
        'state',
        'iss',
      ]);
      expect(db.consentGrants.size).toBe(0);
    });

    // The scope of the transaction is what the scope policy left.
    it('should issue the tokens for the scope of the transaction', async () => {
      const { db, outcome } = await respond('id_token token', { scope: 'openid' });

      expect(fragmentOf(outcome).params['scope']).toBe('openid');
      expect([...db.accessTokens.values()].map((record) => record.scope)).toEqual([['openid']]);
    });
  });
});
