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
import { hybridResponseTypeHandler } from './response-type.js';

const NOW_SECONDS = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
const AUTH_TIME = NOW_SECONDS - 30;

/** Answer the stored Hybrid Flow transaction of the signed-in End-User. */
async function respond(
  responseType: 'code id_token token' | 'code id_token' | 'code token',
  input: { options?: Partial<OidcProviderOptions>; responseMode?: AuthorizationResponseMode; scope?: string } = {},
) {
  const context = await providerContext({ options: input.options });
  await registerTestClient(context.db);
  const transaction = transactionOf({ responseType, scope: input.scope ?? 'openid profile' });
  await storeTransaction(context.stores, transaction);
  const outcome = await hybridResponseTypeHandler.respond(context.c, {
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

describe('hybridResponseTypeHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // OIDC Core 1.0 §3.3.1.1
  it('should answer response_type=code id_token, code token and code id_token token', () => {
    expect(hybridResponseTypeHandler.names).toEqual(['code id_token', 'code token', 'code id_token token']);
  });

  describe('Authorization response', () => {
    // OIDC Core 1.0 §3.3.2.5 / RFC 9207 §2: the code, the tokens, the state and
    // iss in the fragment, the default response mode of the response type.
    it('should redirect with the code, the access token, the ID Token, the state and iss in the fragment', async () => {
      const { db, outcome } = await respond('code id_token token');

      const { target, params } = fragmentOf(outcome);
      expect(target).toBe(REDIRECT_URI);
      expect(params).toEqual({
        code: [...db.codes.keys()][0],
        access_token: [...db.accessTokens.keys()][0],
        token_type: 'Bearer',
        expires_in: '3600',
        scope: 'openid profile',
        id_token: expect.any(String),
        state: STATE,
        iss: TEST_ISSUER,
      });
    });

    // OIDC Core 1.0 §3.3.2.11: the ID Token carries the nonce of the request,
    // the time the End-User authenticated and the hash of the code.
    it('should issue the ID Token of response_type=code id_token for the End-User with the nonce, auth_time and c_hash', async () => {
      const { outcome } = await respond('code id_token');

      const { params } = fragmentOf(outcome);
      expect(Object.keys(params)).toEqual(['code', 'id_token', 'state', 'iss']);
      expect(decodeJwt(params['id_token'] ?? '').payload).toMatchObject({
        sub: SUBJECT,
        aud: CLIENT_ID,
        nonce: NONCE,
        auth_time: AUTH_TIME,
        c_hash: expect.any(String),
      });
    });

    it('should redirect with the code and the access token without an ID Token for response_type=code token', async () => {
      const { outcome } = await respond('code token');

      expect(Object.keys(fragmentOf(outcome).params)).toEqual([
        'code',
        'access_token',
        'token_type',
        'expires_in',
        'scope',
        'state',
        'iss',
      ]);
    });

    it('should hand the code, the tokens and the state to the response mode the request asked for', async () => {
      const { responseMode, respond: recorded } = recordingResponseMode('form_post');

      const { outcome } = await respond('code id_token', { responseMode });

      expect(outcome).toEqual({ kind: 'authorization_response', response: RECORDED_RESPONSE });
      expect(recorded.mock.calls).toEqual([
        [REDIRECT_URI, { code: expect.any(String), id_token: expect.any(String), state: STATE }],
      ]);
    });
  });

  describe('Grant', () => {
    // One-time use, as for a code (OAuth 2.1 §4.1.2).
    it('should delete the transaction', async () => {
      const { db } = await respond('code id_token token');

      expect(db.transactions.has('auth_txn:' + TRANSACTION_ID)).toBe(false);
    });

    // Withdrawing the consent revokes the code's grant: the access token of the
    // authorization endpoint and the tokens the token endpoint issues for the code.
    it('should record the one grant of the code and the access token under the consent of the End-User to the client', async () => {
      const { db } = await respond('code id_token token');

      const [code] = [...db.codes.values()];
      const [accessToken] = [...db.accessTokens.values()];
      expect(accessToken?.grantId).toBe(code?.grantId);
      expect(db.consentGrants.get(SUBJECT)?.get(CLIENT_ID)).toEqual(new Set([code?.grantId]));
    });

    it('should answer without recording a grant when the consent resolver does not record grants', async () => {
      const { db, outcome } = await respond('code token', {
        options: { consentResolver: { hasConsent: async () => true } },
      });

      expect(Object.keys(fragmentOf(outcome).params)).toEqual([
        'code',
        'access_token',
        'token_type',
        'expires_in',
        'scope',
        'state',
        'iss',
      ]);
      expect(db.consentGrants.size).toBe(0);
    });

    // The scope of the transaction is what the scope policy left.
    it('should issue the code and the tokens for the scope of the transaction', async () => {
      const { db, outcome } = await respond('code token', { scope: 'openid' });

      expect(fragmentOf(outcome).params['scope']).toBe('openid');
      expect([...db.codes.values()].map((record) => record.scope)).toEqual([['openid']]);
      expect([...db.accessTokens.values()].map((record) => record.scope)).toEqual([['openid']]);
    });
  });
});
