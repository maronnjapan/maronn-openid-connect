import { describe, expect, it } from 'vitest';
import { formPost, requestTo } from '../../../../../test-support/context.js';
import {
  TEST_CODE_CHALLENGE,
  basicAuthorization,
  providerApp,
} from '../../../../../test-support/feature-endpoints.js';
import { registerClient } from '../../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../../db/memory/database.js';

const REDIRECT_URI = 'https://rp.example.com/callback';

async function appWithClient() {
  const db = createEmptyDatabase();
  await registerClient(db, {
    clientId: 'par-client',
    clientSecret: 'par-secret',
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
  return providerApp(db);
}

function pushedRequest(fields: Record<string, string> = {}, secret = 'par-secret'): Request {
  return formPost(
    '/par',
    {
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: 'openid',
      state: 'state-1',
      code_challenge: TEST_CODE_CHALLENGE,
      code_challenge_method: 'S256',
      ...fields,
    },
    { Authorization: basicAuthorization('par-client', secret) },
  );
}

function authorizeWith(requestUri: string): Request {
  const query = new URLSearchParams({ client_id: 'par-client', request_uri: requestUri });
  return requestTo(`/authorize?${query}`, { headers: { Accept: 'application/json' } });
}

describe('parApp', () => {
  // RFC 9126 §2.2 / §4: the pushed request is answered with a request_uri that
  // /authorize expands once.
  it('should answer 201 with a request_uri that the authorization endpoint accepts once', async () => {
    const { app } = await appWithClient();

    const pushed = await app.request(pushedRequest());
    const body = (await pushed.json()) as { request_uri: string; expires_in: number };
    const first = await app.request(authorizeWith(body.request_uri));
    const replay = await app.request(authorizeWith(body.request_uri));

    expect(pushed.status).toBe(201);
    expect(pushed.headers.get('Cache-Control')).toBe('no-cache, no-store');
    expect(body.expires_in).toBe(60);
    expect(first.status).toBe(302);
    expect(first.headers.get('Location')).toBe('https://op.example.com/login');
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({
      error: 'invalid_request_uri',
      error_description: 'The request_uri is invalid, expired, or has already been used',
    });
  });

  // RFC 9126 §2.3 / RFC 6749 §5.2.
  it('should answer 401 invalid_client with a Basic challenge for a wrong client_secret', async () => {
    const { app } = await appWithClient();

    const response = await app.request(pushedRequest({}, 'wrong-secret'));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    });
  });

  // RFC 9126 §2.1: validated as the authorization endpoint would, and answered as JSON.
  it('should answer 400 invalid_request for a redirect_uri the client did not register', async () => {
    const { app } = await appWithClient();

    const response = await app.request(pushedRequest({ redirect_uri: 'https://attacker.example.com/cb' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'redirect_uri not registered',
    });
  });

  it('should answer 405 with Allow POST for a GET', async () => {
    const { app } = await appWithClient();

    const response = await app.request(requestTo('/par'));

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});
