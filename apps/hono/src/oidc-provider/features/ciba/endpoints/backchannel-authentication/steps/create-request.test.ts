import type { TokenClientInfo } from '@maronn-openid-connect/core';
import { createInMemoryCibaAuthenticationRequestStore } from '@maronn-openid-connect/experimental/ciba';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingCibaRecord } from '../../../../../../test-support/browser-flows.js';
import { providerContext } from '../../../../../../test-support/context.js';
import { createEmptyDatabase } from '../../../../../db/memory/database.js';
import { registerUser } from '../../../../../db/memory/users.js';
import { createBackchannelAuthenticationRequest } from './create-request.js';

const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';
const NOW = new Date('2026-01-01T00:00:00.000Z');

const cibaClient: TokenClientInfo = {
  clientId: 'ciba-client',
  grantTypes: [CIBA_GRANT],
  tokenEndpointAuthMethods: ['client_secret_basic'],
};

/** A context whose user store has alice, with a fresh CIBA store (default cibaUserResolver of feature.ts). */
async function cibaContext() {
  const db = createEmptyDatabase();
  await registerUser(db, { sub: 'alice' });
  const { c } = await providerContext({ db });
  const store = createInMemoryCibaAuthenticationRequestStore();
  c.set('cibaAuthenticationRequestStore', store);
  return { c, store };
}

describe('createBackchannelAuthenticationRequest', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // CIBA Core 1.0 §7.3: auth_req_id, expires_in (120, config.ts) and interval (5).
  it('should save a pending request for the user of login_hint and answer its auth_req_id', async () => {
    const { c, store } = await cibaContext();

    const response = (await createBackchannelAuthenticationRequest(
      c,
      { scope: 'openid profile', login_hint: 'alice', binding_message: 'W4SCT', acr_values: 'urn:acr:pwd' },
      cibaClient,
    )) as { auth_req_id: string; expires_in: number; interval: number };

    expect(response).toEqual({ auth_req_id: response.auth_req_id, expires_in: 120, interval: 5 });
    expect(response.auth_req_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.findByAuthReqId(response.auth_req_id)).toEqual({
      authReqId: response.auth_req_id,
      clientId: 'ciba-client',
      subject: 'alice',
      scope: ['openid', 'profile'],
      bindingMessage: 'W4SCT',
      acrValues: 'urn:acr:pwd',
      status: 'pending',
      createdAt: NOW,
      expiresAt: new Date('2026-01-01T00:02:00.000Z'),
      interval: 5,
      lastPolledAt: null,
      csrfToken: null,
    });
  });

  // CIBA Core 1.0 §13: no user matches the hint.
  it('should reject a login_hint that matches no user with unknown_user_id', async () => {
    const { c } = await cibaContext();

    await expect(
      createBackchannelAuthenticationRequest(c, { scope: 'openid', login_hint: 'mallory' }, cibaClient),
    ).rejects.toMatchObject({
      code: 'unknown_user_id',
      errorDescription: 'The login_hint could not be matched to a user',
    });
  });

  // CIBA Core 1.0 §7.1: the server MAY use requested_expiry; it is clamped to [30, 120].
  it('should clamp requested_expiry to the configured lifetime', async () => {
    const { c } = await cibaContext();

    expect(
      await createBackchannelAuthenticationRequest(
        c,
        { scope: 'openid', login_hint: 'alice', requested_expiry: '3600' },
        cibaClient,
      ),
    ).toMatchObject({ expires_in: 120 });
    expect(
      await createBackchannelAuthenticationRequest(c, { scope: 'openid', login_hint: 'alice', requested_expiry: '1' }, cibaClient),
    ).toMatchObject({ expires_in: 30 });
  });

  // CIBA Core 1.0 §7.1: client authentication is mandatory, which a public client cannot do.
  it('should reject a public client with unauthorized_client', async () => {
    const { c } = await cibaContext();

    await expect(
      createBackchannelAuthenticationRequest(
        c,
        { scope: 'openid', login_hint: 'alice' },
        { ...cibaClient, tokenEndpointAuthMethods: ['none'] },
      ),
    ).rejects.toMatchObject({ code: 'unauthorized_client' });
  });

  // maxPendingPerSubject is 10 (config.ts): the flood defense for the approval screen.
  it('should refuse an eleventh pending request for the same user with invalid_request', async () => {
    const { c, store } = await cibaContext();
    for (let index = 0; index < 10; index++) {
      await store.save(pendingCibaRecord());
    }

    await expect(
      createBackchannelAuthenticationRequest(c, { scope: 'openid', login_hint: 'alice' }, cibaClient),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      errorDescription: 'Too many pending authentication requests for this user',
    });
  });

  // OIDC Core 1.0 §11: offline_access that can never be granted is ignored.
  describe('offline_access', () => {
    it('should drop offline_access for a client not registered for refresh_token', async () => {
      const { c, store } = await cibaContext();

      const response = (await createBackchannelAuthenticationRequest(
        c,
        { scope: 'openid offline_access', login_hint: 'alice' },
        cibaClient,
      )) as { auth_req_id: string };

      expect((await store.findByAuthReqId(response.auth_req_id))?.scope).toEqual(['openid']);
    });

    it('should keep offline_access for a client registered for refresh_token', async () => {
      const { c, store } = await cibaContext();

      const response = (await createBackchannelAuthenticationRequest(
        c,
        { scope: 'openid offline_access', login_hint: 'alice' },
        { ...cibaClient, grantTypes: [CIBA_GRANT, 'refresh_token'] },
      )) as { auth_req_id: string };

      expect((await store.findByAuthReqId(response.auth_req_id))?.scope).toEqual(['openid', 'offline_access']);
    });
  });
});
