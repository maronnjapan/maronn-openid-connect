import type { TokenClientInfo } from '@maronn-openid-connect/core';
import { CIBA_GRANT_TYPE } from '@maronn-openid-connect/experimental/ciba';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingCibaRecord } from '../../../../test-support/fixtures';
import { decodeJwt } from '../../../../test-support/jwt';
import { providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import { jsonResponseOf } from '../../../../test-support/responses';
import { stores } from '../../provider';
import { dispatchCiba } from './grant';
import { cibaAuthenticationRequestStore } from './store';

// The CIBA store and provider.ts's stores live for the whole file, so every
// test saves a request with an auth_req_id of its own (pendingCibaRecord()
// makes a new one each time).

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW = new Date('2026-01-01T00:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;

const cibaClient: TokenClientInfo = {
  clientId: 'ciba-client',
  grantTypes: [CIBA_GRANT_TYPE],
  tokenEndpointAuthMethods: ['client_secret_basic'],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function cibaRequest(authReqId: string): Record<string, string> {
  return { grant_type: CIBA_GRANT_TYPE, auth_req_id: authReqId };
}

describe('dispatchCiba', () => {
  it('should return undefined for another grant_type', async () => {
    const keys = providerSigningKeys(await rs256Key());

    expect(await dispatchCiba({ grant_type: 'authorization_code', code: 'code-1' }, cibaClient, keys)).toBeUndefined();
  });

  // CIBA Core 1.0 §10.1.1 / RFC 6749 §5.1: the token response of an approved request.
  it('should answer an approved auth_req_id with an access token and an ID Token', async () => {
    const record = pendingCibaRecord({
      status: 'approved',
      authTime: NOW_SECONDS - 30,
      grantId: 'grant-ciba-approved',
    });
    await cibaAuthenticationRequestStore.save(record);

    const response = await dispatchCiba(cibaRequest(record.authReqId), cibaClient, providerSigningKeys(await rs256Key()));
    const parts = await jsonResponseOf(response);
    const body = parts?.body as Record<string, unknown>;

    expect(parts).toMatchObject({ status: 200, cacheControl: 'no-store', pragma: 'no-cache' });
    expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'id_token', 'scope', 'token_type']);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'openid profile' });
    expect(decodeJwt(body['id_token'] as string).payload).toMatchObject({
      iss: 'https://op.example.com',
      sub: 'alice',
      aud: 'ciba-client',
      auth_time: NOW_SECONDS - 30,
    });
    expect(await stores.accessTokenStore.get(body['access_token'] as string)).toMatchObject({
      sub: 'alice',
      clientId: 'ciba-client',
      scope: ['openid', 'profile'],
      grantId: 'grant-ciba-approved',
    });
  });

  // CIBA Core 1.0 §11 / RFC 6749 §5.2: every other state is an OAuth error in the JSON shape, never cached.
  describe('Errors', () => {
    it('should answer a pending auth_req_id with authorization_pending', async () => {
      const record = pendingCibaRecord();
      await cibaAuthenticationRequestStore.save(record);

      const response = await dispatchCiba(cibaRequest(record.authReqId), cibaClient, providerSigningKeys(await rs256Key()));

      expect(await jsonResponseOf(response)).toEqual({
        status: 400,
        contentType: 'application/json',
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: { error: 'authorization_pending', error_description: 'The authentication request is still pending' },
      });
    });

    it('should answer an auth_req_id the OP does not know with invalid_grant', async () => {
      const response = await dispatchCiba(cibaRequest('auth-req-unknown'), cibaClient, providerSigningKeys(await rs256Key()));

      expect(await jsonResponseOf(response)).toEqual({
        status: 400,
        contentType: 'application/json',
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: {
          error: 'invalid_grant',
          error_description: 'The auth_req_id is invalid, expired, or was issued to another client',
        },
      });
    });

    it('should answer a client that did not register the CIBA grant with unauthorized_client', async () => {
      const response = await dispatchCiba(
        cibaRequest('auth-req-any'),
        { ...cibaClient, grantTypes: ['authorization_code'] },
        providerSigningKeys(await rs256Key()),
      );

      expect(await jsonResponseOf(response)).toMatchObject({
        status: 400,
        body: { error: 'unauthorized_client', error_description: 'The client is not authorized to use the CIBA grant' },
      });
    });
  });
});
