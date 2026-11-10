import { describe, expect, it } from 'vitest';
import { processCibaGrant, validateCibaGrantAllowed } from './ciba-grant.js';
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

async function captureGrantError(
  input: Parameters<typeof processCibaGrant>[0],
): Promise<CibaGrantError> {
  try {
    await processCibaGrant(input);
  } catch (error) {
    return error as CibaGrantError;
  }
  throw new Error('expected processCibaGrant to throw');
}

describe('validateCibaGrantAllowed', () => {
  it('should accept a client registered for the CIBA grant', () => {
    expect(() => validateCibaGrantAllowed(makeClient())).not.toThrow();
  });

  // RFC 6749 §5.2: the authenticated client must be registered for the grant
  // type it presents. The backchannel endpoint already enforces this at
  // request time; the token endpoint must enforce it again at redemption time
  // (the registration can change between the two).
  it('should reject a client whose grantTypes omit the CIBA URN', () => {
    expect(() =>
      validateCibaGrantAllowed(makeClient({ grantTypes: ['authorization_code'] })),
    ).toThrowError(
      new CibaGrantError('unauthorized_client', 'The client is not authorized to use the CIBA grant'),
    );
  });

  it('should reject a client without grantTypes', () => {
    expect(() => validateCibaGrantAllowed(makeClient({ grantTypes: undefined }))).toThrowError(
      new CibaGrantError('unauthorized_client', 'The client is not authorized to use the CIBA grant'),
    );
  });
});

describe('processCibaGrant', () => {
  describe('Request validation (CIBA Section 10.1)', () => {
    it('should reject a client no longer registered for the CIBA grant before evaluating the record', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord());

      const error = await captureGrantError(makeInput({ store, client: makeClient({ grantTypes: ['authorization_code'] }) }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('unauthorized_client');
      expect(error.statusCode).toBe(400);

      expect(error.errorDescription).toBe('The client is not authorized to use the CIBA grant');
      // The record is untouched: no state transition happened for the
      // deauthorized caller.
      const record = await store.findByAuthReqId('auth-req-id-value');
      expect(record).toMatchObject({ status: 'pending', lastPolledAt: null });
    });

    it('should reject a missing auth_req_id with invalid_request', async () => {
      const error = await captureGrantError(makeInput({ params: {} }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('invalid_request');
      expect(error.statusCode).toBe(400);

      expect(error.errorDescription).toBe('Missing required parameter: auth_req_id');
    });

    it('should reject an empty auth_req_id with invalid_request', async () => {
      const error = await captureGrantError(makeInput({ params: { auth_req_id: '' } }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('invalid_request');
      expect(error.statusCode).toBe(400);
    });

    it('should reject an unknown auth_req_id with invalid_grant', async () => {
      const error = await captureGrantError(makeInput());
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('invalid_grant');
      expect(error.statusCode).toBe(400);

      expect(error.errorDescription).toBe(
        'The auth_req_id is invalid, expired, or was issued to another client',
      );
    });

    // CIBA Section 11: "invalid or was issued to another Client" share one
    // wording so a client cannot probe which auth_req_id values exist.
    it('should reject another client\'s auth_req_id with the same wording', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord());

      const error = await captureGrantError(makeInput({ store, client: makeClient({ clientId: 'other-client' }) }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('invalid_grant');
      expect(error.statusCode).toBe(400);

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

      const error = await captureGrantError(makeInput({ store }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('authorization_pending');
      expect(error.statusCode).toBe(400);

      expect(error.errorDescription).toBe('The authentication request is still pending');
      expect((await store.findByAuthReqId('auth-req-id-value'))?.lastPolledAt).toEqual(NOW);
    });

    it('should answer slow_down and raise the interval by 5 when polled inside the interval', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ lastPolledAt: new Date(NOW.getTime() - 2_000) }));

      const error = await captureGrantError(makeInput({ store }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('slow_down');
      expect(error.statusCode).toBe(400);

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

      const error = await captureGrantError(makeInput({ store }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('slow_down');
      expect(error.statusCode).toBe(400);
      const error2 = await captureGrantError(makeInput({ store, now: new Date(NOW.getTime() + 6_000) }));
      expect(error2).toBeInstanceOf(CibaGrantError);
      expect(error2.code).toBe('slow_down');
      expect(error2.statusCode).toBe(400);

      expect((await store.findByAuthReqId('auth-req-id-value'))?.interval).toBe(15);
    });

    it('should answer authorization_pending again once the interval has passed', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ lastPolledAt: new Date(NOW.getTime() - 6_000) }));

      const error = await captureGrantError(makeInput({ store }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('authorization_pending');
      expect(error.statusCode).toBe(400);
    });

    it('should answer expired_token and delete the record when it expired', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ expiresAt: new Date(NOW.getTime() - 1_000) }));

      const error = await captureGrantError(makeInput({ store }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('expired_token');
      expect(error.statusCode).toBe(400);

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

      const error = await captureGrantError(makeInput({ store }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('expired_token');
      expect(error.statusCode).toBe(400);
    });

    it('should answer access_denied and delete the record after the user denied', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ status: 'denied' }));

      const error = await captureGrantError(makeInput({ store }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('access_denied');
      expect(error.statusCode).toBe(400);

      expect(error.errorDescription).toBe(
        'The end-user denied the authentication request',
      );
      expect(await store.findByAuthReqId('auth-req-id-value')).toBe(null);
    });

    it('should answer invalid_grant when polling again after access_denied', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ status: 'denied' }));
      const error = await captureGrantError(makeInput({ store }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('access_denied');
      expect(error.statusCode).toBe(400);

      const error2 = await captureGrantError(makeInput({ store }));
      expect(error2).toBeInstanceOf(CibaGrantError);
      expect(error2.code).toBe('invalid_grant');
      expect(error2.statusCode).toBe(400);
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

      const error = await captureGrantError(makeInput({ store }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('invalid_grant');
      expect(error.statusCode).toBe(400);
    });

    it('should reject an approved record missing its approval context', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      await store.save(makeRecord({ status: 'approved' }));

      const error = await captureGrantError(makeInput({ store }));
      expect(error).toBeInstanceOf(CibaGrantError);
      expect(error.code).toBe('invalid_grant');
      expect(error.statusCode).toBe(400);
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
