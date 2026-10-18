import type { TokenClientInfo } from '@maronn-openid-connect/core';
import { DEVICE_CODE_GRANT_TYPE } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingDeviceRecord } from '../../../../test-support/fixtures';
import { decodeJwt } from '../../../../test-support/jwt';
import { providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import { jsonResponseOf } from '../../../../test-support/responses';
import { stores } from '../../provider';
import { dispatchDeviceCode } from './grant';
import { deviceAuthorizationStore } from './store';

// The device authorization store and provider.ts's stores live for the whole
// file, so every test saves a record with a device_code of its own
// (pendingDeviceRecord() makes a new one each time).

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW = new Date('2026-01-01T00:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;

const deviceClient: TokenClientInfo = {
  clientId: 'device-client',
  grantTypes: [DEVICE_CODE_GRANT_TYPE, 'refresh_token'],
  tokenEndpointAuthMethods: ['none'],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function deviceCodeRequest(deviceCode: string): Record<string, string> {
  return { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: deviceCode, client_id: 'device-client' };
}

describe('dispatchDeviceCode', () => {
  it('should return undefined for another grant_type', async () => {
    const keys = providerSigningKeys(await rs256Key());

    expect(await dispatchDeviceCode({ grant_type: 'authorization_code', code: 'code-1' }, deviceClient, keys)).toBeUndefined();
  });

  // RFC 8628 §3.5 / RFC 6749 §5.1: the token response of an approved device authorization.
  it('should answer an approved device_code with an access token and an ID Token', async () => {
    const record = pendingDeviceRecord({
      status: 'approved',
      subject: 'alice',
      authTime: NOW_SECONDS - 60,
      approvedScope: ['openid', 'profile'],
      grantId: 'grant-device-approved',
    });
    await deviceAuthorizationStore.save(record);

    const response = await dispatchDeviceCode(deviceCodeRequest(record.deviceCode), deviceClient, providerSigningKeys(await rs256Key()));
    const parts = await jsonResponseOf(response);
    const body = parts?.body as Record<string, unknown>;

    expect(parts).toMatchObject({ status: 200, cacheControl: 'no-store', pragma: 'no-cache' });
    expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'id_token', 'scope', 'token_type']);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'openid profile' });
    expect(decodeJwt(body['id_token'] as string).payload).toMatchObject({
      iss: 'https://op.example.com',
      sub: 'alice',
      aud: 'device-client',
      auth_time: NOW_SECONDS - 60,
    });
    expect(await stores.accessTokenStore.get(body['access_token'] as string)).toMatchObject({
      sub: 'alice',
      clientId: 'device-client',
      scope: ['openid', 'profile'],
      grantId: 'grant-device-approved',
    });
  });

  // RFC 8628 §3.5 / RFC 6749 §5.2: every other state is an OAuth error in the JSON shape, never cached.
  describe('Errors', () => {
    it('should answer a pending device_code with authorization_pending', async () => {
      const record = pendingDeviceRecord();
      await deviceAuthorizationStore.save(record);

      const response = await dispatchDeviceCode(deviceCodeRequest(record.deviceCode), deviceClient, providerSigningKeys(await rs256Key()));

      expect(await jsonResponseOf(response)).toEqual({
        status: 400,
        contentType: 'application/json',
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: { error: 'authorization_pending', error_description: 'The authorization request is still pending' },
      });
    });

    it('should answer a device_code the OP does not know with invalid_grant', async () => {
      const response = await dispatchDeviceCode(
        deviceCodeRequest('device-code-unknown'),
        deviceClient,
        providerSigningKeys(await rs256Key()),
      );

      expect(await jsonResponseOf(response)).toEqual({
        status: 400,
        contentType: 'application/json',
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: {
          error: 'invalid_grant',
          error_description: 'The device_code is invalid, expired, or was issued to another client',
        },
      });
    });

    it('should answer a client that did not register the device_code grant with unauthorized_client', async () => {
      const response = await dispatchDeviceCode(
        deviceCodeRequest('device-code-any'),
        { ...deviceClient, grantTypes: ['authorization_code'] },
        providerSigningKeys(await rs256Key()),
      );

      expect(await jsonResponseOf(response)).toMatchObject({
        status: 400,
        body: { error: 'unauthorized_client', error_description: 'The client is not authorized to use the device_code grant' },
      });
    });
  });
});
