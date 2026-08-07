import { describe, expect, it } from 'vitest';
import {
  applyOfflineAccessPolicy,
  buildDeviceAuthorizationResponse,
  createDeviceAuthorizationRecord,
  processDeviceAuthorizationRequest,
  validateDeviceAuthorizationScope,
  validateDeviceGrantAllowed,
  type DeviceAuthorizationClient,
} from './device-authorization-request.js';
import { DeviceAuthorizationError } from './errors.js';
import { DEVICE_CODE_GRANT_TYPE } from './store.js';
import { NOW, createInMemoryDeviceAuthorizationStore, makeRecord } from './test-helpers.js';

const ISSUER = 'http://localhost:3000';

const DEVICE_CLIENT: DeviceAuthorizationClient = {
  clientId: 'tv-app',
  grantTypes: [DEVICE_CODE_GRANT_TYPE],
};

const DEVICE_AND_REFRESH_CLIENT: DeviceAuthorizationClient = {
  clientId: 'tv-app-refresh',
  grantTypes: [DEVICE_CODE_GRANT_TYPE, 'refresh_token'],
};

describe('validateDeviceGrantAllowed', () => {
  it('should accept a client registered for the device_code grant', () => {
    expect(() => validateDeviceGrantAllowed(DEVICE_CLIENT)).not.toThrow();
  });

  it('should reject a client whose grantTypes omit the device_code URN', () => {
    const client: DeviceAuthorizationClient = {
      clientId: 'web-app',
      grantTypes: ['authorization_code'],
    };

    expect(() => validateDeviceGrantAllowed(client)).toThrowError(
      new DeviceAuthorizationError(
        'unauthorized_client',
        'The client is not authorized to use the device_code grant',
      ),
    );
  });

  it('should reject a client with no registered grantTypes at all', () => {
    expect(() => validateDeviceGrantAllowed({ clientId: 'unknown' })).toThrowError(
      DeviceAuthorizationError,
    );
  });

  it('should set the error code to unauthorized_client', () => {
    const error = (() => {
      try {
        validateDeviceGrantAllowed({ clientId: 'web-app', grantTypes: [] });
        return null;
      } catch (caught) {
        return caught as DeviceAuthorizationError;
      }
    })();

    expect(error?.code).toBe('unauthorized_client');
  });
});

describe('validateDeviceAuthorizationScope', () => {
  // RFC 8628 §3.1 では scope は OPTIONAL だが、本 OP は authorize と同じ
  // プロファイル制限（scope 必須・openid 必須）を課す。
  it('should return the parsed scope values when openid is present', () => {
    expect(validateDeviceAuthorizationScope('openid profile')).toEqual(['openid', 'profile']);
  });

  it('should collapse repeated whitespace between scope values', () => {
    expect(validateDeviceAuthorizationScope('  openid   email  ')).toEqual(['openid', 'email']);
  });

  it('should remove duplicate scope values', () => {
    expect(validateDeviceAuthorizationScope('openid openid profile')).toEqual([
      'openid',
      'profile',
    ]);
  });

  it('should reject a missing scope with invalid_request', () => {
    expect(() => validateDeviceAuthorizationScope(undefined)).toThrowError(
      new DeviceAuthorizationError('invalid_request', 'Missing required parameter: scope'),
    );
  });

  it('should reject a blank scope with invalid_request', () => {
    expect(() => validateDeviceAuthorizationScope('   ')).toThrowError(
      new DeviceAuthorizationError('invalid_request', 'Missing required parameter: scope'),
    );
  });

  it('should reject a scope without openid with invalid_scope', () => {
    expect(() => validateDeviceAuthorizationScope('profile email')).toThrowError(
      new DeviceAuthorizationError('invalid_scope', 'The openid scope is required'),
    );
  });
});

describe('applyOfflineAccessPolicy', () => {
  // OIDC Core 1.0 §11: 許可条件を満たさない offline_access は無視する（エラーにしない）。
  it('should keep offline_access when the feature is enabled and the client allows refresh', () => {
    const result = applyOfflineAccessPolicy(['openid', 'offline_access'], {
      client: DEVICE_AND_REFRESH_CLIENT,
      refreshTokenFeatureEnabled: true,
    });

    expect(result).toEqual(['openid', 'offline_access']);
  });

  it('should drop offline_access when the refresh-token feature is disabled', () => {
    const result = applyOfflineAccessPolicy(['openid', 'offline_access'], {
      client: DEVICE_AND_REFRESH_CLIENT,
      refreshTokenFeatureEnabled: false,
    });

    expect(result).toEqual(['openid']);
  });

  it('should drop offline_access when the client is not registered for refresh_token', () => {
    const result = applyOfflineAccessPolicy(['openid', 'offline_access'], {
      client: DEVICE_CLIENT,
      refreshTokenFeatureEnabled: true,
    });

    expect(result).toEqual(['openid']);
  });

  it('should leave a scope without offline_access unchanged', () => {
    const result = applyOfflineAccessPolicy(['openid', 'profile'], {
      client: DEVICE_CLIENT,
      refreshTokenFeatureEnabled: false,
    });

    expect(result).toEqual(['openid', 'profile']);
  });
});

describe('createDeviceAuthorizationRecord', () => {
  it('should save a pending record under the generated device_code', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const record = await createDeviceAuthorizationRecord({
      clientId: 'tv-app',
      scope: ['openid'],
      store,
      expiresIn: 600,
      interval: 5,
      now: NOW,
    });

    expect(await store.findByDeviceCode(record.deviceCode)).toEqual(record);
  });

  it('should initialize the record with the full pending state', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const record = await createDeviceAuthorizationRecord({
      clientId: 'tv-app',
      scope: ['openid', 'profile'],
      store,
      expiresIn: 600,
      interval: 5,
      now: NOW,
    });

    expect(record).toMatchObject({
      clientId: 'tv-app',
      scope: ['openid', 'profile'],
      status: 'pending',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 600_000),
      interval: 5,
      lastPolledAt: null,
      csrfToken: null,
      bindingHash: null,
      loginAttempts: 0,
    });
  });

  it('should generate a 256-bit URL-safe device_code (RFC 8628 §5.2)', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const record = await createDeviceAuthorizationRecord({
      clientId: 'tv-app',
      scope: ['openid'],
      store,
      expiresIn: 600,
      interval: 5,
    });

    // 32 バイトの Base64URL は 43 文字（padding なし）。
    expect(record.deviceCode).toHaveLength(43);
  });

  it('should store the normalized user_code as the lookup key', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const record = await createDeviceAuthorizationRecord({
      clientId: 'tv-app',
      scope: ['openid'],
      store,
      expiresIn: 600,
      interval: 5,
    });

    expect(await store.findByUserCode(record.userCode)).toEqual(record);
  });

  it('should keep the display form separate from the lookup key', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const record = await createDeviceAuthorizationRecord({
      clientId: 'tv-app',
      scope: ['openid'],
      store,
      expiresIn: 600,
      interval: 5,
    });

    expect(record.userCodeDisplay).toBe(
      record.userCode.slice(0, 4) + '-' + record.userCode.slice(4),
    );
  });
});

describe('buildDeviceAuthorizationResponse', () => {
  // RFC 8628 §3.2 の応答フィールド。
  it('should build all six response fields from the record and issuer', () => {
    const record = makeRecord({
      deviceCode: 'dc-value',
      userCode: 'WDJBMJHT',
      userCodeDisplay: 'WDJB-MJHT',
      interval: 5,
    });

    expect(buildDeviceAuthorizationResponse(record, ISSUER)).toEqual({
      device_code: 'dc-value',
      user_code: 'WDJB-MJHT',
      verification_uri: 'http://localhost:3000/device',
      verification_uri_complete: 'http://localhost:3000/device?user_code=WDJB-MJHT',
      expires_in: 600,
      interval: 5,
    });
  });

  it('should derive expires_in from the record lifetime', () => {
    const record = makeRecord({
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 300_000),
    });

    expect(buildDeviceAuthorizationResponse(record, ISSUER).expires_in).toBe(300);
  });

  it('should report the record interval, including one raised by slow_down', () => {
    const record = makeRecord({ interval: 10 });

    expect(buildDeviceAuthorizationResponse(record, ISSUER).interval).toBe(10);
  });
});

describe('processDeviceAuthorizationRequest', () => {
  it('should return the RFC 8628 §3.2 response for a valid request', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const response = await processDeviceAuthorizationRequest({
      params: { scope: 'openid profile' },
      client: DEVICE_CLIENT,
      issuer: ISSUER,
      refreshTokenFeatureEnabled: true,
      store,
      now: NOW,
    });

    expect(response).toMatchObject({
      verification_uri: 'http://localhost:3000/device',
      expires_in: 600,
      interval: 5,
    });
  });

  it('should default expires_in to 600 and interval to 5 seconds', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const response = await processDeviceAuthorizationRequest({
      params: { scope: 'openid' },
      client: DEVICE_CLIENT,
      issuer: ISSUER,
      refreshTokenFeatureEnabled: true,
      store,
      now: NOW,
    });

    expect([response.expires_in, response.interval]).toEqual([600, 5]);
  });

  it('should honor the configured expires_in and interval', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const response = await processDeviceAuthorizationRequest({
      params: { scope: 'openid' },
      client: DEVICE_CLIENT,
      issuer: ISSUER,
      expiresIn: 300,
      interval: 10,
      refreshTokenFeatureEnabled: true,
      store,
      now: NOW,
    });

    expect([response.expires_in, response.interval]).toEqual([300, 10]);
  });

  it('should build verification_uri_complete from the display user_code', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const response = await processDeviceAuthorizationRequest({
      params: { scope: 'openid' },
      client: DEVICE_CLIENT,
      issuer: ISSUER,
      refreshTokenFeatureEnabled: true,
      store,
      now: NOW,
    });

    expect(response.verification_uri_complete).toBe(
      'http://localhost:3000/device?user_code=' + response.user_code,
    );
  });

  it('should persist the record so it can be found by device_code', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const response = await processDeviceAuthorizationRequest({
      params: { scope: 'openid' },
      client: DEVICE_CLIENT,
      issuer: ISSUER,
      refreshTokenFeatureEnabled: true,
      store,
      now: NOW,
    });
    const record = await store.findByDeviceCode(response.device_code);

    expect(record).toMatchObject({ clientId: 'tv-app', status: 'pending', scope: ['openid'] });
  });

  it('should strip offline_access from the stored scope when refresh is unavailable', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const response = await processDeviceAuthorizationRequest({
      params: { scope: 'openid offline_access' },
      client: DEVICE_CLIENT,
      issuer: ISSUER,
      refreshTokenFeatureEnabled: false,
      store,
      now: NOW,
    });
    const record = await store.findByDeviceCode(response.device_code);

    expect(record?.scope).toEqual(['openid']);
  });

  it('should keep offline_access in the stored scope when refresh is available', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    const response = await processDeviceAuthorizationRequest({
      params: { scope: 'openid offline_access' },
      client: DEVICE_AND_REFRESH_CLIENT,
      issuer: ISSUER,
      refreshTokenFeatureEnabled: true,
      store,
      now: NOW,
    });
    const record = await store.findByDeviceCode(response.device_code);

    expect(record?.scope).toEqual(['openid', 'offline_access']);
  });

  it('should reject a request from a client without the device_code grant', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    await expect(
      processDeviceAuthorizationRequest({
        params: { scope: 'openid' },
        client: { clientId: 'web-app', grantTypes: ['authorization_code'] },
        issuer: ISSUER,
        refreshTokenFeatureEnabled: true,
        store,
      }),
    ).rejects.toThrowError(DeviceAuthorizationError);
  });

  it('should reject a request with no scope before creating a record', async () => {
    const store = createInMemoryDeviceAuthorizationStore();

    await processDeviceAuthorizationRequest({
      params: {},
      client: DEVICE_CLIENT,
      issuer: ISSUER,
      refreshTokenFeatureEnabled: true,
      store,
    }).catch(() => undefined);

    expect(store.records.size).toBe(0);
  });

  it('should issue a different device_code for every request', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const input = {
      params: { scope: 'openid' },
      client: DEVICE_CLIENT,
      issuer: ISSUER,
      refreshTokenFeatureEnabled: true,
      store,
    };

    const first = await processDeviceAuthorizationRequest(input);
    const second = await processDeviceAuthorizationRequest(input);

    expect(first.device_code === second.device_code).toBe(false);
  });

  it('should issue a different user_code for every request', async () => {
    const store = createInMemoryDeviceAuthorizationStore();
    const input = {
      params: { scope: 'openid' },
      client: DEVICE_CLIENT,
      issuer: ISSUER,
      refreshTokenFeatureEnabled: true,
      store,
    };

    const first = await processDeviceAuthorizationRequest(input);
    const second = await processDeviceAuthorizationRequest(input);

    expect(first.user_code === second.user_code).toBe(false);
  });
});
