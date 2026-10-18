import { describe, expect, it } from 'vitest';
import { formPost, TEST_ISSUER } from '../../../../../test-support/context.js';
import { rs256Key, staticKeyProvider } from '../../../../../test-support/keys.js';
import { createApp } from '../../../../app.js';
import type { ClientRegistration } from '../../../../config.js';
import { createClientKeyResolver, createClientResolver, registerClient } from '../../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../../db/memory/database.js';
import { createProviderStores } from '../../../../db/memory/stores.js';
import { registerUser } from '../../../../db/memory/users.js';
import { cibaAuthenticationRequestStore } from '../../store.js';

const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';

function basic(clientId: string, secret: string): string {
  return 'Basic ' + btoa(`${clientId}:${secret}`);
}

/** The provider with a CIBA client and a user named by a fresh sub (the CIBA store is shared). */
async function appWithCibaClient(client: Partial<ClientRegistration> = {}) {
  const db = createEmptyDatabase();
  const subject = 'user-' + crypto.randomUUID();
  await registerUser(db, { sub: subject });
  await registerClient(db, {
    clientId: 'call-center',
    clientSecret: 'call-center-secret',
    redirectUris: [],
    grantTypes: [CIBA_GRANT],
    tokenEndpointAuthMethods: ['client_secret_basic'],
    ...client,
  });
  const app = createApp({
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: createProviderStores(db),
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    config: { issuer: TEST_ISSUER },
  });
  return { app, subject };
}

describe('backchannelAuthenticationApp', () => {
  // CIBA Core 1.0 §7.1 - §7.3: the whole pipeline behind POST /backchannel_authentication.
  it('should acknowledge a request for a known user with an auth_req_id it can poll with', async () => {
    const { app, subject } = await appWithCibaClient();

    const response = await app.request(
      formPost('/backchannel_authentication', { scope: 'openid email', login_hint: subject, binding_message: 'W4SCT' }, {
        Authorization: basic('call-center', 'call-center-secret'),
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toEqual({ auth_req_id: body['auth_req_id'], expires_in: 120, interval: 5 });
    expect(await cibaAuthenticationRequestStore.findByAuthReqId(String(body['auth_req_id']))).toMatchObject({
      clientId: 'call-center',
      subject,
      scope: ['openid', 'email'],
      bindingMessage: 'W4SCT',
      status: 'pending',
    });
  });

  it('should answer a wrong client secret with 401 invalid_client and WWW-Authenticate', async () => {
    const { app, subject } = await appWithCibaClient();

    const response = await app.request(
      formPost('/backchannel_authentication', { scope: 'openid', login_hint: subject }, {
        Authorization: basic('call-center', 'wrong'),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(await response.json()).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' });
  });

  // CIBA Core 1.0 §13: unknown_user_id, without echoing the hint (PII, §15).
  it('should answer a login_hint that matches no user with 400 unknown_user_id', async () => {
    const { app } = await appWithCibaClient();

    const response = await app.request(
      formPost('/backchannel_authentication', { scope: 'openid', login_hint: 'nobody@example.com' }, {
        Authorization: basic('call-center', 'call-center-secret'),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'unknown_user_id',
      error_description: 'The login_hint could not be matched to a user',
    });
  });

  // CIBA Core 1.0 §7.2: exactly one of the three hints is required.
  it('should answer a request without a hint with 400 invalid_request', async () => {
    const { app } = await appWithCibaClient();

    const response = await app.request(
      formPost('/backchannel_authentication', { scope: 'openid' }, {
        Authorization: basic('call-center', 'call-center-secret'),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Exactly one of login_hint, id_token_hint or login_hint_token is required',
    });
  });

  // CIBA Core 1.0 §4 / §7.1: the provider offers poll only; ping and push are client metadata it cannot serve.
  it('should answer a client registered for the ping delivery mode with 400 unauthorized_client', async () => {
    const { app, subject } = await appWithCibaClient({ backchannelTokenDeliveryMode: 'ping' });

    const response = await app.request(
      formPost('/backchannel_authentication', { scope: 'openid', login_hint: subject }, {
        Authorization: basic('call-center', 'call-center-secret'),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'unauthorized_client',
      error_description: 'This provider only supports the poll token delivery mode',
    });
  });
});
