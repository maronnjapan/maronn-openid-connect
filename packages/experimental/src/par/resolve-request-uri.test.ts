import { describe, it, expect } from 'vitest';
import {
  PushedRequestUriError,
  assertPushedRequestUsed,
  resolvePushedRequestUri,
} from './resolve-request-uri.js';
import { PAR_REQUEST_URI_PREFIX } from './store.js';
import type {
  PushedAuthorizationRecord,
  PushedAuthorizationRequestStore,
} from './store.js';

const REQUEST_URI = `${PAR_REQUEST_URI_PREFIX}6esc_11ACC5bwc014ltc14eY22c`;

/** 解決失敗時の固定文言（失敗種別を外部から区別させないため）。 */
const OPAQUE_DESCRIPTION = 'The request_uri is invalid, expired, or has already been used';

const PUSHED_PARAMS: Record<string, string> = {
  response_type: 'code',
  client_id: 'web-app',
  redirect_uri: 'https://client.example/cb',
  scope: 'openid profile',
  state: 'af0ifjsldkj',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
};

function createRecord(overrides: Partial<PushedAuthorizationRecord> = {}): PushedAuthorizationRecord {
  return {
    requestUri: REQUEST_URI,
    clientId: 'web-app',
    params: { ...PUSHED_PARAMS },
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
    expiresAt: new Date('2026-07-29T00:01:00.000Z'),
    ...overrides,
  };
}

class SingleRecordStore implements PushedAuthorizationRequestStore {
  readonly consumedKeys: string[] = [];
  private record: PushedAuthorizationRecord | null;

  constructor(record: PushedAuthorizationRecord | null) {
    this.record = record;
  }

  async save(record: PushedAuthorizationRecord): Promise<void> {
    this.record = record;
  }

  async consume(requestUri: string): Promise<PushedAuthorizationRecord | null> {
    this.consumedKeys.push(requestUri);
    if (!this.record || this.record.requestUri !== requestUri) return null;
    const consumed = this.record;
    this.record = null;
    return consumed;
  }
}

describe('resolvePushedRequestUri', () => {
  describe('URN prefix matching', () => {
    it('should return null when request_uri is absent so the normal flow continues', async () => {
      const store = new SingleRecordStore(createRecord());

      const resolved = await resolvePushedRequestUri({
        params: { client_id: 'web-app', response_type: 'code' },
        store,
      });

      expect(resolved).toBe(null);
    });

    it('should return null for a URL-form request_uri so core rejects it with request_uri_not_supported', async () => {
      // OIDC Core 1.0 §6.2 の URL 形式は本機能の対象外（specification.md 非目標）。
      const store = new SingleRecordStore(createRecord());

      const resolved = await resolvePushedRequestUri({
        params: { client_id: 'web-app', request_uri: 'https://client.example/request.jwt' },
        store,
      });

      expect(resolved).toBe(null);
    });

    it('should not touch the store when the prefix does not match', async () => {
      const store = new SingleRecordStore(createRecord());

      await resolvePushedRequestUri({
        params: { client_id: 'web-app', request_uri: 'https://client.example/request.jwt' },
        store,
      });

      expect(store.consumedKeys).toEqual([]);
    });
  });

  describe('successful resolution', () => {
    it('should expand the pushed parameters and drop request_uri', async () => {
      // RFC 9126 §4: the authorization server MUST validate the expanded request as it
      // would any other authorization request, so request_uri is removed before the
      // core pipeline sees it.
      const store = new SingleRecordStore(createRecord());

      const resolved = await resolvePushedRequestUri({
        params: { client_id: 'web-app', request_uri: REQUEST_URI },
        store,
        now: new Date('2026-07-29T00:00:30.000Z'),
      });

      expect(resolved).toEqual(PUSHED_PARAMS);
    });

    it('should ignore extra query parameters and keep the pushed values authoritative', async () => {
      const store = new SingleRecordStore(createRecord());

      const resolved = await resolvePushedRequestUri({
        params: {
          client_id: 'web-app',
          request_uri: REQUEST_URI,
          scope: 'openid admin',
          redirect_uri: 'https://attacker.example/cb',
        },
        store,
        now: new Date('2026-07-29T00:00:30.000Z'),
      });

      expect(resolved).toEqual(PUSHED_PARAMS);
    });

    it('should pass the request_uri to the store as an opaque key', async () => {
      const store = new SingleRecordStore(createRecord());

      await resolvePushedRequestUri({
        params: { client_id: 'web-app', request_uri: REQUEST_URI },
        store,
        now: new Date('2026-07-29T00:00:30.000Z'),
      });

      expect(store.consumedKeys).toEqual([REQUEST_URI]);
    });

    it('should strip a request_uri that a store implementation left in the record', async () => {
      const store = new SingleRecordStore(
        createRecord({ params: { ...PUSHED_PARAMS, request_uri: REQUEST_URI } }),
      );

      const resolved = await resolvePushedRequestUri({
        params: { client_id: 'web-app', request_uri: REQUEST_URI },
        store,
        now: new Date('2026-07-29T00:00:30.000Z'),
      });

      expect(resolved).toEqual(PUSHED_PARAMS);
    });
  });

  describe('resolution failures', () => {
    it('should reject an unknown request_uri with invalid_request_uri', async () => {
      const store = new SingleRecordStore(null);

      await expect(
        resolvePushedRequestUri({
          params: { client_id: 'web-app', request_uri: REQUEST_URI },
          store,
        }),
      ).rejects.toThrowError(new PushedRequestUriError('invalid_request_uri', OPAQUE_DESCRIPTION));
    });

    it('should reject the second use of the same request_uri', async () => {
      // RFC 9126 §7.3: the request_uri is single use; consume() removes it atomically.
      const store = new SingleRecordStore(createRecord());
      await resolvePushedRequestUri({
        params: { client_id: 'web-app', request_uri: REQUEST_URI },
        store,
        now: new Date('2026-07-29T00:00:30.000Z'),
      });

      await expect(
        resolvePushedRequestUri({
          params: { client_id: 'web-app', request_uri: REQUEST_URI },
          store,
          now: new Date('2026-07-29T00:00:31.000Z'),
        }),
      ).rejects.toThrowError(new PushedRequestUriError('invalid_request_uri', OPAQUE_DESCRIPTION));
    });

    it('should reject an expired request_uri', async () => {
      // RFC 9126 §4: "An expired request_uri MUST be rejected as invalid."
      const store = new SingleRecordStore(createRecord());

      await expect(
        resolvePushedRequestUri({
          params: { client_id: 'web-app', request_uri: REQUEST_URI },
          store,
          now: new Date('2026-07-29T00:01:00.001Z'),
        }),
      ).rejects.toThrowError(new PushedRequestUriError('invalid_request_uri', OPAQUE_DESCRIPTION));
    });

    it('should accept a request_uri used exactly at its expiry instant', async () => {
      const store = new SingleRecordStore(createRecord());

      const resolved = await resolvePushedRequestUri({
        params: { client_id: 'web-app', request_uri: REQUEST_URI },
        store,
        now: new Date('2026-07-29T00:01:00.000Z'),
      });

      expect(resolved).toEqual(PUSHED_PARAMS);
    });

    it('should reject a request_uri presented by another client', async () => {
      // RFC 9126 §2.2: "The request_uri value ... MUST be bound to the client that
      // posted the authorization request."
      const store = new SingleRecordStore(createRecord());

      await expect(
        resolvePushedRequestUri({
          params: { client_id: 'other-app', request_uri: REQUEST_URI },
          store,
          now: new Date('2026-07-29T00:00:30.000Z'),
        }),
      ).rejects.toThrowError(new PushedRequestUriError('invalid_request_uri', OPAQUE_DESCRIPTION));
    });

    it('should reject a request_uri presented without client_id', async () => {
      const store = new SingleRecordStore(createRecord());

      await expect(
        resolvePushedRequestUri({
          params: { request_uri: REQUEST_URI },
          store,
          now: new Date('2026-07-29T00:00:30.000Z'),
        }),
      ).rejects.toThrowError(new PushedRequestUriError('invalid_request_uri', OPAQUE_DESCRIPTION));
    });

    it('should consume the record even when the client_id does not match', async () => {
      // 不一致でもレコードを残さないことで、正しい client_id による再試行を許さない。
      const store = new SingleRecordStore(createRecord());
      await resolvePushedRequestUri({
        params: { client_id: 'other-app', request_uri: REQUEST_URI },
        store,
        now: new Date('2026-07-29T00:00:30.000Z'),
      }).catch(() => undefined);

      await expect(
        resolvePushedRequestUri({
          params: { client_id: 'web-app', request_uri: REQUEST_URI },
          store,
          now: new Date('2026-07-29T00:00:31.000Z'),
        }),
      ).rejects.toThrowError(new PushedRequestUriError('invalid_request_uri', OPAQUE_DESCRIPTION));
    });

    it('should report the same error code and description for every failure kind', async () => {
      // 存在確認オラクル化の防止（specification.md セキュリティ要件）。
      const unknown = await resolvePushedRequestUri({
        params: { client_id: 'web-app', request_uri: REQUEST_URI },
        store: new SingleRecordStore(null),
      }).catch((error: unknown) => error as PushedRequestUriError);
      const expired = await resolvePushedRequestUri({
        params: { client_id: 'web-app', request_uri: REQUEST_URI },
        store: new SingleRecordStore(createRecord()),
        now: new Date('2026-07-29T01:00:00.000Z'),
      }).catch((error: unknown) => error as PushedRequestUriError);
      const mismatched = await resolvePushedRequestUri({
        params: { client_id: 'other-app', request_uri: REQUEST_URI },
        store: new SingleRecordStore(createRecord()),
        now: new Date('2026-07-29T00:00:30.000Z'),
      }).catch((error: unknown) => error as PushedRequestUriError);

      expect([unknown.code, expired.code, mismatched.code]).toEqual([
        'invalid_request_uri',
        'invalid_request_uri',
        'invalid_request_uri',
      ]);
      expect([unknown.errorDescription, expired.errorDescription, mismatched.errorDescription]).toEqual([
        OPAQUE_DESCRIPTION,
        OPAQUE_DESCRIPTION,
        OPAQUE_DESCRIPTION,
      ]);
    });
  });
});

describe('assertPushedRequestUsed', () => {
  it('should pass when a URN-form request_uri is present', () => {
    expect(assertPushedRequestUsed({ client_id: 'web-app', request_uri: REQUEST_URI })).toBe(undefined);
  });

  it('should reject a request without request_uri when PAR is required', () => {
    // RFC 9126 §5: require_pushed_authorization_requests=true means the AS rejects
    // authorization requests that were not pushed.
    expect(() => assertPushedRequestUsed({ client_id: 'web-app', response_type: 'code' })).toThrowError(
      new PushedRequestUriError('invalid_request', 'Pushed authorization requests are required by this authorization server'),
    );
  });

  it('should reject a URL-form request_uri when PAR is required', () => {
    expect(() =>
      assertPushedRequestUsed({ client_id: 'web-app', request_uri: 'https://client.example/request.jwt' }),
    ).toThrowError(
      new PushedRequestUriError('invalid_request', 'Pushed authorization requests are required by this authorization server'),
    );
  });
});

describe('PushedRequestUriError', () => {
  it('should sanitize the error description to the RFC 6749 §5.2 character set', () => {
    expect(new PushedRequestUriError('invalid_request_uri', 'bad "quoted"\nvalue').errorDescription).toBe(
      'bad ?quoted??value',
    );
  });

  it('should expose the error code used by the authorization endpoint', () => {
    expect(new PushedRequestUriError('invalid_request_uri', OPAQUE_DESCRIPTION).code).toBe(
      'invalid_request_uri',
    );
  });
});
