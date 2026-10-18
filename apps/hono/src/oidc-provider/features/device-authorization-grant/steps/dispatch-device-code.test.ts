import { computeAtHash, type TokenClientInfo } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwtPayload, pendingDeviceRecord } from '../../../../test-support/browser-flows.js';
import { providerContext, TEST_ISSUER } from '../../../../test-support/context.js';
import { registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import type { TokenRequestBody } from '../../../endpoints/token/response.js';
import { InMemoryDeviceAuthorizationStore } from '../store.js';
import { redeemDeviceCode } from './dispatch-device-code.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;

const tokenClient: TokenClientInfo = {
  clientId: 'device-client',
  grantTypes: [DEVICE_GRANT, 'refresh_token'],
  tokenEndpointAuthMethods: ['none'],
};

function deviceCodeRequest(deviceCode: string): TokenRequestBody {
  return { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: 'device-client' } as TokenRequestBody;
}

/** A token endpoint context with a fresh device store, and the record saved in it. */
async function tokenContext(record = pendingDeviceRecord()) {
  const db = createEmptyDatabase();
  await registerClient(db, { ...tokenClient, redirectUris: [] });
  const provider = await providerContext({ db });
  const store = new InMemoryDeviceAuthorizationStore();
  provider.c.set('deviceAuthorizationStore', store);
  await store.save(record);
  return { ...provider, store, record };
}

function approved(overrides: Parameters<typeof pendingDeviceRecord>[0] = {}) {
  return pendingDeviceRecord({
    status: 'approved',
    subject: 'alice',
    authTime: 1_700_000_000,
    approvedScope: ['openid', 'profile'],
    grantId: 'grant-1',
    ...overrides,
  });
}

describe('redeemDeviceCode', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return undefined for another grant_type so the standard grants run', async () => {
    const { c } = await tokenContext();

    expect(
      await redeemDeviceCode(c, { grant_type: 'authorization_code' } as TokenRequestBody, tokenClient, 'device-client'),
    ).toBeUndefined();
  });

  // RFC 8628 §3.5 state machine, every answer a 400 OAuth error.
  describe('Polling', () => {
    it('should answer authorization_pending and record the poll while the record is pending', async () => {
      const { c, record } = await tokenContext();

      await expect(redeemDeviceCode(c, deviceCodeRequest(record.deviceCode), tokenClient, 'device-client')).rejects.toMatchObject({
        response: {
          status: 400,
          body: { error: 'authorization_pending', error_description: 'The authorization request is still pending' },
        },
      });
      expect(record.lastPolledAt).toEqual(NOW);
    });

    it('should answer slow_down and raise the interval by 5 seconds when polled within the interval', async () => {
      const { c, record } = await tokenContext(pendingDeviceRecord({ lastPolledAt: new Date(NOW.getTime() - 2_000) }));

      await expect(redeemDeviceCode(c, deviceCodeRequest(record.deviceCode), tokenClient, 'device-client')).rejects.toMatchObject({
        response: { status: 400, body: { error: 'slow_down' } },
      });
      expect(record.interval).toBe(10);
    });

    it('should answer access_denied and delete a denied record', async () => {
      const { c, store, record } = await tokenContext(pendingDeviceRecord({ status: 'denied' }));

      await expect(redeemDeviceCode(c, deviceCodeRequest(record.deviceCode), tokenClient, 'device-client')).rejects.toMatchObject({
        response: { status: 400, body: { error: 'access_denied' } },
      });
      expect(await store.findByDeviceCode(record.deviceCode)).toBeNull();
    });

    it('should answer expired_token for a record past its lifetime', async () => {
      const { c, record } = await tokenContext(approved({ expiresAt: NOW }));

      await expect(redeemDeviceCode(c, deviceCodeRequest(record.deviceCode), tokenClient, 'device-client')).rejects.toMatchObject({
        response: { status: 400, body: { error: 'expired_token' } },
      });
    });

    // RFC 6749 §5.2: the client is no longer registered for the grant.
    it('should answer unauthorized_client for a client not registered for the device_code grant', async () => {
      const { c, record } = await tokenContext(approved());

      await expect(
        redeemDeviceCode(c, deviceCodeRequest(record.deviceCode), { clientId: 'device-client', grantTypes: [] }, 'device-client'),
      ).rejects.toMatchObject({ response: { status: 400, body: { error: 'unauthorized_client' } } });
    });
  });

  describe('Approved', () => {
    // RFC 8628 §3.5 / RFC 6749 §5.1: the token response, once per device_code.
    it('should issue an access token and an ID Token, store the access token and consume the record', async () => {
      const { c, store, stores, signingKey, record } = await tokenContext(approved());

      const response = await redeemDeviceCode(c, deviceCodeRequest(record.deviceCode), tokenClient, 'device-client');
      const body = (await response?.json()) as Record<string, string>;
      const accessToken = body['access_token'] ?? '';

      expect(response?.status).toBe(200);
      expect(response?.headers.get('Cache-Control')).toBe('no-store');
      expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'openid profile' });
      expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'id_token', 'scope', 'token_type']);
      // OIDC Core 1.0 §3.1.3.6: no nonce and no c_hash, the auth_time of the approval.
      expect(decodeJwtPayload(body['id_token'] ?? '')).toEqual({
        iss: TEST_ISSUER,
        sub: 'alice',
        aud: 'device-client',
        exp: NOW_SECONDS + 3600,
        iat: NOW_SECONDS,
        at_hash: await computeAtHash(accessToken, signingKey.privateKey),
        auth_time: 1_700_000_000,
      });
      expect(await stores.accessTokenStore.get(accessToken)).toMatchObject({
        sub: 'alice',
        clientId: 'device-client',
        scope: ['openid', 'profile'],
        grantId: 'grant-1',
        expiresAt: NOW_SECONDS + 3600,
      });
      expect(await store.findByDeviceCode(record.deviceCode)).toBeNull();
    });

    // OIDC Core 1.0 §11: offline_access survived the device authorization endpoint's policy.
    it('should also issue a refresh token of the same grant when the approved scope has offline_access', async () => {
      const { c, stores, record } = await tokenContext(approved({ approvedScope: ['openid', 'offline_access'] }));

      const response = await redeemDeviceCode(c, deviceCodeRequest(record.deviceCode), tokenClient, 'device-client');
      const body = (await response?.json()) as Record<string, string>;

      expect(body['scope']).toBe('openid offline_access');
      expect(await stores.refreshTokenStore.get(body['refresh_token'] ?? '')).toMatchObject({
        subject: 'alice',
        clientId: 'device-client',
        scope: ['openid', 'offline_access'],
        grantId: 'grant-1',
        used: false,
        authTime: 1_700_000_000,
        originalIssuedAt: NOW_SECONDS,
        expiresAt: NOW_SECONDS + 7_776_000,
      });
    });

    // RFC 8628 §3.5: a replayed device_code cannot mint a second token.
    it('should answer invalid_grant when the same device_code is redeemed again', async () => {
      const { c, record } = await tokenContext(approved());
      await redeemDeviceCode(c, deviceCodeRequest(record.deviceCode), tokenClient, 'device-client');

      await expect(redeemDeviceCode(c, deviceCodeRequest(record.deviceCode), tokenClient, 'device-client')).rejects.toMatchObject({
        response: { status: 400, body: { error: 'invalid_grant' } },
      });
    });
  });
});
