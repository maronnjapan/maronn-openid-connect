import { computeAtHash, type TokenClientInfo } from '@maronn-openid-connect/core';
import { createInMemoryCibaAuthenticationRequestStore } from '@maronn-openid-connect/experimental/ciba';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwtPayload, pendingCibaRecord } from '../../../../test-support/browser-flows.js';
import { providerContext, TEST_ISSUER } from '../../../../test-support/context.js';
import { registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import type { TokenRequestBody } from '../../../endpoints/token/response.js';
import { redeemCibaRequest } from './dispatch-ciba.js';

const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;

const tokenClient: TokenClientInfo = {
  clientId: 'ciba-client',
  grantTypes: [CIBA_GRANT, 'refresh_token'],
  tokenEndpointAuthMethods: ['client_secret_basic'],
};

function cibaRequest(authReqId: string): TokenRequestBody {
  return { grant_type: CIBA_GRANT, auth_req_id: authReqId } as TokenRequestBody;
}

/** A token endpoint context with a fresh CIBA store, and the record saved in it. */
async function tokenContext(record = pendingCibaRecord()) {
  const db = createEmptyDatabase();
  await registerClient(db, { ...tokenClient, clientSecret: 'ciba-secret', redirectUris: [] });
  const provider = await providerContext({ db });
  const store = createInMemoryCibaAuthenticationRequestStore();
  provider.c.set('cibaAuthenticationRequestStore', store);
  await store.save(record);
  return { ...provider, store, record };
}

function approved(overrides: Parameters<typeof pendingCibaRecord>[0] = {}) {
  return pendingCibaRecord({
    status: 'approved',
    authTime: 1_700_000_000,
    approvedScope: ['openid', 'profile'],
    grantId: 'grant-1',
    ...overrides,
  });
}

describe('redeemCibaRequest', () => {
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
      await redeemCibaRequest(c, { grant_type: 'refresh_token' } as TokenRequestBody, tokenClient, 'ciba-client'),
    ).toBeUndefined();
  });

  // CIBA Core 1.0 §11 poll-mode state machine, every answer a 400 OAuth error.
  describe('Polling', () => {
    it('should answer invalid_request without auth_req_id', async () => {
      const { c } = await tokenContext();

      await expect(redeemCibaRequest(c, cibaRequest(''), tokenClient, 'ciba-client')).rejects.toMatchObject({
        response: {
          status: 400,
          body: { error: 'invalid_request', error_description: 'Missing required parameter: auth_req_id' },
        },
      });
    });

    it('should answer authorization_pending and record the poll while the request is pending', async () => {
      const { c, record } = await tokenContext();

      await expect(redeemCibaRequest(c, cibaRequest(record.authReqId), tokenClient, 'ciba-client')).rejects.toMatchObject({
        response: {
          status: 400,
          body: { error: 'authorization_pending', error_description: 'The authentication request is still pending' },
        },
      });
      expect(record.lastPolledAt).toEqual(NOW);
    });

    it('should answer slow_down and raise the interval by 5 seconds when polled within the interval', async () => {
      const { c, record } = await tokenContext(pendingCibaRecord({ lastPolledAt: new Date(NOW.getTime() - 1_000) }));

      await expect(redeemCibaRequest(c, cibaRequest(record.authReqId), tokenClient, 'ciba-client')).rejects.toMatchObject({
        response: { status: 400, body: { error: 'slow_down' } },
      });
      expect(record.interval).toBe(10);
    });

    it('should answer access_denied and delete a denied request', async () => {
      const { c, store, record } = await tokenContext(pendingCibaRecord({ status: 'denied' }));

      await expect(redeemCibaRequest(c, cibaRequest(record.authReqId), tokenClient, 'ciba-client')).rejects.toMatchObject({
        response: { status: 400, body: { error: 'access_denied' } },
      });
      expect(await store.findByAuthReqId(record.authReqId)).toBeNull();
    });

    // CIBA Core 1.0 §11: an auth_req_id issued to another client is invalid_grant, and stays.
    it('should answer invalid_grant for an auth_req_id issued to another client', async () => {
      const { c, store, record } = await tokenContext(approved({ clientId: 'other-client' }));

      await expect(redeemCibaRequest(c, cibaRequest(record.authReqId), tokenClient, 'ciba-client')).rejects.toMatchObject({
        response: { status: 400, body: { error: 'invalid_grant' } },
      });
      expect(await store.findByAuthReqId(record.authReqId)).toBe(record);
    });
  });

  describe('Approved', () => {
    it('should issue an access token and an ID Token, store the access token and consume the request', async () => {
      const { c, store, stores, signingKey, record } = await tokenContext(approved());

      const response = await redeemCibaRequest(c, cibaRequest(record.authReqId), tokenClient, 'ciba-client');
      const body = (await response?.json()) as Record<string, string>;
      const accessToken = body['access_token'] ?? '';

      expect(response?.status).toBe(200);
      expect(response?.headers.get('Cache-Control')).toBe('no-store');
      expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'openid profile' });
      expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'id_token', 'scope', 'token_type']);
      // OIDC Core 1.0 §3.1.3.6: no nonce, the auth_time of the approval.
      expect(decodeJwtPayload(body['id_token'] ?? '')).toEqual({
        iss: TEST_ISSUER,
        sub: 'alice',
        aud: 'ciba-client',
        exp: NOW_SECONDS + 3600,
        iat: NOW_SECONDS,
        at_hash: await computeAtHash(accessToken, signingKey.privateKey),
        auth_time: 1_700_000_000,
      });
      expect(await stores.accessTokenStore.get(accessToken)).toMatchObject({
        sub: 'alice',
        clientId: 'ciba-client',
        scope: ['openid', 'profile'],
        grantId: 'grant-1',
      });
      expect(await store.findByAuthReqId(record.authReqId)).toBeNull();
    });

    // OIDC Core 1.0 §11: offline_access survived the backchannel endpoint's policy.
    it('should also issue a refresh token of the same grant when the approved scope has offline_access', async () => {
      const { c, stores, record } = await tokenContext(approved({ approvedScope: ['openid', 'offline_access'] }));

      const response = await redeemCibaRequest(c, cibaRequest(record.authReqId), tokenClient, 'ciba-client');
      const body = (await response?.json()) as Record<string, string>;

      expect(await stores.refreshTokenStore.get(body['refresh_token'] ?? '')).toMatchObject({
        subject: 'alice',
        clientId: 'ciba-client',
        scope: ['openid', 'offline_access'],
        grantId: 'grant-1',
        used: false,
        expiresAt: NOW_SECONDS + 7_776_000,
      });
    });
  });
});
