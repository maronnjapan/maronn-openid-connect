import { describe, expect, it } from 'vitest';
import { processCibaGrant } from './ciba-grant.js';
import { CibaGrantError } from './errors.js';
import { createInMemoryCibaAuthenticationRequestStore } from './store.js';
import { NOW, makeClient, makeRecord } from './test-helpers.js';

function makeInput(
  overrides: Partial<Parameters<typeof processCibaGrant>[0]> = {},
) {
  return {
    params: { auth_req_id: 'auth-req-id-value' },
    client: makeClient(),
    store: createInMemoryCibaAuthenticationRequestStore(),
    now: NOW,
    ...overrides,
  };
}

async function expectGrantError(
  input: Parameters<typeof processCibaGrant>[0],
  code: string,
): Promise<CibaGrantError> {
  try {
    await processCibaGrant(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CibaGrantError);
    const typed = error as CibaGrantError;
    expect(typed.code).toBe(code);
    expect(typed.statusCode).toBe(400);
    return typed;
  }
  throw new Error('expected processCibaGrant to throw');
}

describe('processCibaGrant', () => {
  describe('Request validation (CIBA Section 10.1)', () => {
    it('should reject a missing auth_req_id with invalid_request', async () => {
      const error = await expectGrantError(makeInput({ params: {} }), 'invalid_request');

      expect(error.errorDescription).toBe('Missing required parameter: auth_req_id');
    });

    it('should reject an empty auth_req_id with invalid_request', async () => {
      await expectGrantError(makeInput({ params: { auth_req_id: '' } }), 'invalid_request');
    });

    it('should reject an unknown auth_req_id with invalid_grant', async () => {
      const error = await expectGrantError(makeInput(), 'invalid_grant');

      expect(error.errorDescription).toBe(
        'The auth_req_id is invalid, expired, or was issued to another client',
      );
    });

    // CIBA Section 11: "invalid or was issued to another Client" share one
    // wording so a client cannot probe which auth_req_id values exist.
    it('should reject another client\'s auth_req_id with the same wording', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord());

      const error = await expectGrantError(
        makeInput({ store, client: makeClient({ clientId: 'other-client' }) }),
        'invalid_grant',
      );

      expect(error.errorDescription).toBe(
        'The auth_req_id is invalid, expired, or was issued to another client',
      );
      // The record stays: the rightful client can still poll it.
      expect(await store.findByAuthReqId('auth-req-id-value')).not.toBe(null);
    });
  });

  describe('State machine (CIBA Section 11)', () => {
    it('should answer authorization_pending for a pending record and stamp lastPolledAt', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord());

      const error = await expectGrantError(makeInput({ store }), 'authorization_pending');

      expect(error.errorDescription).toBe('The authentication request is still pending');
      expect((await store.findByAuthReqId('auth-req-id-value'))?.lastPolledAt).toEqual(NOW);
    });

    it('should answer slow_down and raise the interval by 5 when polled inside the interval', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ lastPolledAt: new Date(NOW.getTime() - 2_000) }));

      const error = await expectGrantError(makeInput({ store }), 'slow_down');

      expect(error.errorDescription).toBe(
        'Polling too frequently. Increase the interval by 5 seconds.',
      );
      const record = await store.findByAuthReqId('auth-req-id-value');
      expect(record?.interval).toBe(10);
      expect(record?.lastPolledAt).toEqual(NOW);
    });

    // CIBA Section 11: "the interval MUST be increased by at least 5 seconds
    // for this and all subsequent requests" — the raise is persistent.
    it('should keep raising the interval on repeated fast polls', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ lastPolledAt: new Date(NOW.getTime() - 2_000) }));

      await expectGrantError(makeInput({ store }), 'slow_down');
      await expectGrantError(
        makeInput({ store, now: new Date(NOW.getTime() + 6_000) }),
        'slow_down',
      );

      expect((await store.findByAuthReqId('auth-req-id-value'))?.interval).toBe(15);
    });

    it('should answer authorization_pending again once the interval has passed', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ lastPolledAt: new Date(NOW.getTime() - 6_000) }));

      await expectGrantError(makeInput({ store }), 'authorization_pending');
    });

    it('should answer expired_token and delete the record when it expired', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ expiresAt: new Date(NOW.getTime() - 1_000) }));

      const error = await expectGrantError(makeInput({ store }), 'expired_token');

      expect(error.errorDescription).toBe(
        'The auth_req_id has expired. Start a new backchannel authentication request.',
      );
      expect(await store.findByAuthReqId('auth-req-id-value')).toBe(null);
    });

    // Expiry is evaluated before the polling pace: raising the interval of an
    // expired record would be meaningless, the client must learn the flow ended.
    it('should prefer expired_token over slow_down', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({
        expiresAt: new Date(NOW.getTime() - 1_000),
        lastPolledAt: new Date(NOW.getTime() - 1_000),
      }));

      await expectGrantError(makeInput({ store }), 'expired_token');
    });

    it('should answer access_denied and delete the record after the user denied', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ status: 'denied' }));

      const error = await expectGrantError(makeInput({ store }), 'access_denied');

      expect(error.errorDescription).toBe(
        'The end-user denied the authentication request',
      );
      expect(await store.findByAuthReqId('auth-req-id-value')).toBe(null);
    });

    it('should answer invalid_grant when polling again after access_denied', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ status: 'denied' }));
      await expectGrantError(makeInput({ store }), 'access_denied');

      await expectGrantError(makeInput({ store }), 'invalid_grant');
    });
  });

  describe('Token issuance data (approved record)', () => {
    function approvedRecord() {
      return makeRecord({
        status: 'approved',
        authTime: 1_760_000_000,
        approvedScope: ['openid', 'profile'],
        grantId: 'grant-1',
      });
    }

    it('should return the issuance data for an approved record', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(approvedRecord());

      const result = await processCibaGrant(makeInput({ store }));

      expect(result).toEqual({
        subject: 'testuser',
        clientId: 'ciba-client',
        scope: ['openid', 'profile'],
        authTime: 1_760_000_000,
        grantId: 'grant-1',
      });
    });

    it('should consume the record so a second redemption fails with invalid_grant', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(approvedRecord());
      await processCibaGrant(makeInput({ store }));

      await expectGrantError(makeInput({ store }), 'invalid_grant');
    });

    it('should reject an approved record missing its approval context', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ status: 'approved' }));

      await expectGrantError(makeInput({ store }), 'invalid_grant');
    });

    it('should fall back to the requested scope when approvedScope is absent', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({
        status: 'approved',
        authTime: 1_760_000_000,
        grantId: 'grant-1',
      }));

      const result = await processCibaGrant(makeInput({ store }));

      expect(result.scope).toEqual(['openid']);
    });
  });
});
