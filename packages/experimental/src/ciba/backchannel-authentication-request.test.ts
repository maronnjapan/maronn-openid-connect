import { describe, expect, it } from 'vitest';
import {
  BINDING_MESSAGE_MAX_LENGTH,
  processBackchannelAuthenticationRequest,
} from './backchannel-authentication-request.js';
import { BackchannelAuthenticationError } from './errors.js';
import { createInMemoryCibaAuthenticationRequestStore } from './store.js';
import { makeClient, makeRecord } from './test-helpers.js';

function makeInput(
  overrides: Partial<Parameters<typeof processBackchannelAuthenticationRequest>[0]> = {},
) {
  return {
    params: { scope: 'openid', login_hint: 'testuser' },
    client: makeClient(),
    store: createInMemoryCibaAuthenticationRequestStore(),
    config: { authReqIdExpiresIn: 120, pollingInterval: 5, maxPendingPerSubject: 10 },
    refreshTokenFeatureEnabled: true,
    resolveUser: (loginHint: string) =>
      loginHint === 'testuser' ? { subject: 'testuser' } : null,
    ...overrides,
  };
}

async function expectError(
  input: Parameters<typeof processBackchannelAuthenticationRequest>[0],
  code: string,
): Promise<BackchannelAuthenticationError> {
  try {
    await processBackchannelAuthenticationRequest(input);
  } catch (error) {
    expect(error).toBeInstanceOf(BackchannelAuthenticationError);
    const typed = error as BackchannelAuthenticationError;
    expect(typed.code).toBe(code);
    expect(typed.statusCode).toBe(400);
    return typed;
  }
  throw new Error('expected processBackchannelAuthenticationRequest to throw');
}

describe('processBackchannelAuthenticationRequest', () => {
  describe('Success response (CIBA Section 7.3)', () => {
    it('should return auth_req_id, expires_in and interval for a minimal request', async () => {
      const result = await processBackchannelAuthenticationRequest(makeInput());

      expect(result.expires_in).toBe(120);
      expect(result.interval).toBe(5);
      expect(typeof result.auth_req_id).toBe('string');
    });

    // CIBA Section 7.3: at least 128 bits of entropy; this implementation mints
    // 256 bits (32 bytes), which Base64URL-encodes to 43 characters.
    it('should mint a 256-bit auth_req_id in the Base64URL character set', async () => {
      const result = await processBackchannelAuthenticationRequest(makeInput());

      expect(result.auth_req_id.length).toBe(43);
      expect(/^[A-Za-z0-9_-]{43}$/.test(result.auth_req_id)).toBe(true);
    });

    it('should issue a distinct auth_req_id for every request', async () => {
      const input = makeInput();
      const first = await processBackchannelAuthenticationRequest(input);
      const second = await processBackchannelAuthenticationRequest(input);

      expect(first.auth_req_id === second.auth_req_id).toBe(false);
    });

    it('should save a pending record carrying the resolved subject and scope', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      const result = await processBackchannelAuthenticationRequest(makeInput({ store }));
      const record = await store.findByAuthReqId(result.auth_req_id);

      expect(record).toMatchObject({
        clientId: 'ciba-client',
        subject: 'testuser',
        scope: ['openid'],
        status: 'pending',
        interval: 5,
        lastPolledAt: null,
        csrfToken: null,
      });
    });

    it('should store the validated binding_message on the record', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      const result = await processBackchannelAuthenticationRequest(makeInput({
        store,
        params: { scope: 'openid', login_hint: 'testuser', binding_message: 'AB-123' },
      }));
      const record = await store.findByAuthReqId(result.auth_req_id);

      expect(record?.bindingMessage).toBe('AB-123');
    });

    it('should store acr_values as advisory data on the record', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      const result = await processBackchannelAuthenticationRequest(makeInput({
        store,
        params: { scope: 'openid', login_hint: 'testuser', acr_values: 'urn:example:loa:2' },
      }));
      const record = await store.findByAuthReqId(result.auth_req_id);

      expect(record?.acrValues).toBe('urn:example:loa:2');
    });

    // CIBA Section 7.1: "The server MAY use this value" — this implementation
    // clamps requested_expiry into [30, authReqIdExpiresIn].
    it('should honor a requested_expiry inside the allowed range', async () => {
      const result = await processBackchannelAuthenticationRequest(makeInput({
        params: { scope: 'openid', login_hint: 'testuser', requested_expiry: '60' },
      }));

      expect(result.expires_in).toBe(60);
    });

    it('should clamp requested_expiry below 30 up to 30', async () => {
      const result = await processBackchannelAuthenticationRequest(makeInput({
        params: { scope: 'openid', login_hint: 'testuser', requested_expiry: '5' },
      }));

      expect(result.expires_in).toBe(30);
    });

    it('should clamp requested_expiry above the configured lifetime down to it', async () => {
      const result = await processBackchannelAuthenticationRequest(makeInput({
        params: { scope: 'openid', login_hint: 'testuser', requested_expiry: '999999' },
      }));

      expect(result.expires_in).toBe(120);
    });

    it('should set expiresAt from the injected now and the clamped expiry', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      const now = new Date('2026-09-02T00:00:00.000Z');
      const result = await processBackchannelAuthenticationRequest(makeInput({
        store,
        now,
        params: { scope: 'openid', login_hint: 'testuser', requested_expiry: '60' },
      }));
      const record = await store.findByAuthReqId(result.auth_req_id);

      expect(record?.createdAt).toEqual(now);
      expect(record?.expiresAt).toEqual(new Date(now.getTime() + 60_000));
    });

    // CIBA Section 7.1: client_notification_token is only meaningful for the
    // Ping / Push modes this implementation does not offer, and user_code is
    // not supported (backchannel_user_code_parameter_supported defaults false).
    it('should ignore client_notification_token and user_code', async () => {
      const result = await processBackchannelAuthenticationRequest(makeInput({
        params: {
          scope: 'openid',
          login_hint: 'testuser',
          client_notification_token: 'notify-me',
          user_code: '1234',
        },
      }));

      expect(result.expires_in).toBe(120);
    });

    // RFC 6749 Section 3.1: unrecognized parameters are ignored.
    it('should ignore unknown parameters', async () => {
      const result = await processBackchannelAuthenticationRequest(makeInput({
        params: { scope: 'openid', login_hint: 'testuser', unknown_param: 'x' },
      }));

      expect(result.expires_in).toBe(120);
    });
  });

  describe('Client validation', () => {
    // CIBA Section 7.1 requires client authentication, which auth method 'none'
    // can never satisfy — a deliberate profile restriction on public clients.
    it('should reject a public client (auth method none) with unauthorized_client', async () => {
      const error = await expectError(
        makeInput({ client: makeClient({ tokenEndpointAuthMethod: 'none', clientSecret: undefined }) }),
        'unauthorized_client',
      );

      expect(error.errorDescription).toBe(
        'Public clients are not allowed to use the CIBA grant type',
      );
    });

    it('should reject a client that did not register the CIBA grant', async () => {
      const error = await expectError(
        makeInput({ client: makeClient({ grantTypes: ['authorization_code'] }) }),
        'unauthorized_client',
      );

      expect(error.errorDescription).toBe(
        'The client is not authorized to use the CIBA grant',
      );
    });

    it('should treat missing grantTypes as the authorization_code default and reject', async () => {
      await expectError(
        makeInput({ client: makeClient({ grantTypes: undefined }) }),
        'unauthorized_client',
      );
    });

    // This OP only offers Poll delivery, so a client registered for ping or
    // push cannot be served (CIBA Section 4 advertises ['poll'] only).
    it('should reject a client registered for the ping delivery mode', async () => {
      const error = await expectError(
        makeInput({ client: makeClient({ backchannelTokenDeliveryMode: 'ping' }) }),
        'unauthorized_client',
      );

      expect(error.errorDescription).toBe(
        'This provider only supports the poll token delivery mode',
      );
    });

    it('should reject a client registered for the push delivery mode', async () => {
      await expectError(
        makeInput({ client: makeClient({ backchannelTokenDeliveryMode: 'push' }) }),
        'unauthorized_client',
      );
    });

    it('should accept a client explicitly registered for poll', async () => {
      const result = await processBackchannelAuthenticationRequest(
        makeInput({ client: makeClient({ backchannelTokenDeliveryMode: 'poll' }) }),
      );

      expect(typeof result.auth_req_id).toBe('string');
    });
  });

  describe('Hint validation (CIBA Section 7.1 / 7.2)', () => {
    it('should reject a request with no hint', async () => {
      const error = await expectError(
        makeInput({ params: { scope: 'openid' } }),
        'invalid_request',
      );

      expect(error.errorDescription).toBe(
        'Exactly one of login_hint, id_token_hint or login_hint_token is required',
      );
    });

    it('should reject a request with two hints', async () => {
      const error = await expectError(
        makeInput({ params: { scope: 'openid', login_hint: 'testuser', id_token_hint: 'x' } }),
        'invalid_request',
      );

      expect(error.errorDescription).toBe(
        'Exactly one of login_hint, id_token_hint or login_hint_token is required',
      );
    });

    // id_token_hint / login_hint_token are outside this feature's initial
    // scope; presenting one alone is a malformed request, not unknown_user_id.
    it('should reject id_token_hint alone as an unsupported hint type', async () => {
      const error = await expectError(
        makeInput({ params: { scope: 'openid', id_token_hint: 'x' } }),
        'invalid_request',
      );

      expect(error.errorDescription).toBe(
        'Only login_hint is supported by this provider',
      );
    });

    it('should reject login_hint_token alone as an unsupported hint type', async () => {
      const error = await expectError(
        makeInput({ params: { scope: 'openid', login_hint_token: 'x' } }),
        'invalid_request',
      );

      expect(error.errorDescription).toBe(
        'Only login_hint is supported by this provider',
      );
    });

    it('should treat an empty login_hint as absent', async () => {
      await expectError(
        makeInput({ params: { scope: 'openid', login_hint: '' } }),
        'invalid_request',
      );
    });

    // CIBA Section 7.1.1: signed authentication requests are not supported.
    it('should reject a request parameter (signed authentication request)', async () => {
      const error = await expectError(
        makeInput({ params: { scope: 'openid', login_hint: 'testuser', request: 'ey.x.y' } }),
        'invalid_request',
      );

      expect(error.errorDescription).toBe(
        'Signed authentication requests are not supported',
      );
    });
  });

  describe('Scope validation', () => {
    it('should reject a missing scope', async () => {
      const error = await expectError(
        makeInput({ params: { login_hint: 'testuser' } }),
        'invalid_request',
      );

      expect(error.errorDescription).toBe('Missing required parameter: scope');
    });

    it('should reject a scope without openid', async () => {
      const error = await expectError(
        makeInput({ params: { scope: 'profile', login_hint: 'testuser' } }),
        'invalid_scope',
      );

      expect(error.errorDescription).toBe('The openid scope is required');
    });

    it('should normalize whitespace and deduplicate scope values', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      const result = await processBackchannelAuthenticationRequest(makeInput({
        store,
        params: { scope: '  openid  profile openid ', login_hint: 'testuser' },
      }));
      const record = await store.findByAuthReqId(result.auth_req_id);

      expect(record?.scope).toEqual(['openid', 'profile']);
    });

    // OIDC Core 1.0 Section 11: offline_access that could never be granted is
    // dropped silently rather than rejected.
    it('should drop offline_access when the refresh-token feature is disabled', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      const result = await processBackchannelAuthenticationRequest(makeInput({
        store,
        refreshTokenFeatureEnabled: false,
        client: makeClient({
          grantTypes: ['urn:openid:params:grant-type:ciba', 'refresh_token'],
        }),
        params: { scope: 'openid offline_access', login_hint: 'testuser' },
      }));
      const record = await store.findByAuthReqId(result.auth_req_id);

      expect(record?.scope).toEqual(['openid']);
    });

    it('should drop offline_access when the client did not register refresh_token', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      const result = await processBackchannelAuthenticationRequest(makeInput({
        store,
        refreshTokenFeatureEnabled: true,
        params: { scope: 'openid offline_access', login_hint: 'testuser' },
      }));
      const record = await store.findByAuthReqId(result.auth_req_id);

      expect(record?.scope).toEqual(['openid']);
    });

    it('should keep offline_access when the feature and registration both allow it', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      const result = await processBackchannelAuthenticationRequest(makeInput({
        store,
        refreshTokenFeatureEnabled: true,
        client: makeClient({
          grantTypes: ['urn:openid:params:grant-type:ciba', 'refresh_token'],
        }),
        params: { scope: 'openid offline_access', login_hint: 'testuser' },
      }));
      const record = await store.findByAuthReqId(result.auth_req_id);

      expect(record?.scope).toEqual(['openid', 'offline_access']);
    });
  });

  describe('binding_message validation (CIBA Section 7.1)', () => {
    it('should accept a binding message of exactly the maximum length', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      const message = 'a'.repeat(BINDING_MESSAGE_MAX_LENGTH);
      const result = await processBackchannelAuthenticationRequest(makeInput({
        store,
        params: { scope: 'openid', login_hint: 'testuser', binding_message: message },
      }));
      const record = await store.findByAuthReqId(result.auth_req_id);

      expect(record?.bindingMessage).toBe(message);
    });

    it('should reject a binding message longer than the maximum', async () => {
      const error = await expectError(
        makeInput({
          params: {
            scope: 'openid',
            login_hint: 'testuser',
            binding_message: 'a'.repeat(BINDING_MESSAGE_MAX_LENGTH + 1),
          },
        }),
        'invalid_binding_message',
      );

      expect(error.errorDescription).toBe(
        'binding_message must be 1 to 100 characters without control characters',
      );
    });

    it('should reject an empty binding message', async () => {
      await expectError(
        makeInput({
          params: { scope: 'openid', login_hint: 'testuser', binding_message: '' },
        }),
        'invalid_binding_message',
      );
    });

    it('should reject a binding message containing control characters', async () => {
      await expectError(
        makeInput({
          params: { scope: 'openid', login_hint: 'testuser', binding_message: 'ok\nline' },
        }),
        'invalid_binding_message',
      );
    });
  });

  describe('requested_expiry validation', () => {
    it('should reject a non-integer requested_expiry', async () => {
      const error = await expectError(
        makeInput({
          params: { scope: 'openid', login_hint: 'testuser', requested_expiry: '12.5' },
        }),
        'invalid_request',
      );

      expect(error.errorDescription).toBe(
        'requested_expiry must be a positive integer',
      );
    });

    it('should reject zero', async () => {
      await expectError(
        makeInput({
          params: { scope: 'openid', login_hint: 'testuser', requested_expiry: '0' },
        }),
        'invalid_request',
      );
    });

    it('should reject a negative value', async () => {
      await expectError(
        makeInput({
          params: { scope: 'openid', login_hint: 'testuser', requested_expiry: '-5' },
        }),
        'invalid_request',
      );
    });

    it('should reject a non-numeric value', async () => {
      await expectError(
        makeInput({
          params: { scope: 'openid', login_hint: 'testuser', requested_expiry: 'soon' },
        }),
        'invalid_request',
      );
    });
  });

  describe('User resolution (CIBA Section 13 unknown_user_id)', () => {
    it('should reject an unresolvable login_hint with unknown_user_id', async () => {
      const error = await expectError(
        makeInput({ params: { scope: 'openid', login_hint: 'nobody' } }),
        'unknown_user_id',
      );

      expect(error.errorDescription).toBe(
        'The login_hint could not be matched to a user',
      );
    });

    // The resolver failing and the user not existing must not be
    // distinguishable, so the same fixed wording is used for both.
    it('should answer a throwing resolver with the same fixed wording', async () => {
      const error = await expectError(
        makeInput({
          resolveUser: () => {
            throw new Error('backend down');
          },
        }),
        'unknown_user_id',
      );

      expect(error.errorDescription).toBe(
        'The login_hint could not be matched to a user',
      );
    });

    it('should accept a resolver returning a promise', async () => {
      const result = await processBackchannelAuthenticationRequest(makeInput({
        resolveUser: async () => ({ subject: 'testuser' }),
      }));

      expect(typeof result.auth_req_id).toBe('string');
    });
  });

  describe('Pending request flood control', () => {
    it('should reject a request when the subject already has the maximum pending requests', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      for (let i = 0; i < 10; i++) {
        await store.save(makeRecord({
          authReqId: `pending-${i}`,
          expiresAt: new Date(Date.now() + 60_000),
        }));
      }

      const error = await expectError(makeInput({ store }), 'invalid_request');

      expect(error.errorDescription).toBe(
        'Too many pending authentication requests for this user',
      );
    });

    it('should count only the same subject toward the limit', async () => {
      const store = createInMemoryCibaAuthenticationRequestStore();
      for (let i = 0; i < 10; i++) {
        await store.save(makeRecord({
          authReqId: `pending-${i}`,
          subject: 'otheruser',
          expiresAt: new Date(Date.now() + 60_000),
        }));
      }

      const result = await processBackchannelAuthenticationRequest(makeInput({ store }));

      expect(typeof result.auth_req_id).toBe('string');
    });
  });
});
