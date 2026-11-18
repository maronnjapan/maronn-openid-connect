import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, formPost, requestTo } from '../../../../test-support/context.js';
import { dpopKey, dpopProof } from '../../../../test-support/dpop.js';
import { TEST_CODE_CHALLENGE, basicAuthorization, providerApp } from '../../../../test-support/feature-endpoints.js';
import { registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';

const REDIRECT_URI = 'https://rp.example.com/callback';
const PAR_ENDPOINT = `${TEST_ISSUER}/par`;
// RFC 7638 §3.1: the thumbprint of its example key.
const OTHER_JKT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';

async function appWithClient() {
  const db = createEmptyDatabase();
  await registerClient(db, {
    clientId: 'par-client',
    clientSecret: 'par-secret',
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
  return { db, ...(await providerApp(db)) };
}

function pushedRequest(fields: Record<string, string> = {}, headers: Record<string, string> = {}): Request {
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
    { Authorization: basicAuthorization('par-client', 'par-secret'), ...headers },
  );
}

describe('bindPushedDpopKey', () => {
  // RFC 9449 §10.1: the DPoP header of PAR binds the authorization code to its key.
  it('should carry the key of the DPoP proof to the transaction /authorize opens for the request_uri', async () => {
    const key = await dpopKey();
    const { app, db } = await appWithClient();

    const pushed = await app.request(pushedRequest({}, { DPoP: await dpopProof(key, { htm: 'POST', htu: PAR_ENDPOINT }) }));
    const { request_uri: requestUri } = (await pushed.json()) as { request_uri: string };
    await app.request(requestTo(`/authorize?${new URLSearchParams({ client_id: 'par-client', request_uri: requestUri })}`));

    expect(pushed.status).toBe(201);
    expect([...db.transactions.values()].map((entry) => (entry.value as { cnf?: unknown }).cnf)).toEqual([{ jkt: key.jkt }]);
  });

  it('should accept a dpop_jkt of the same key as the DPoP proof', async () => {
    const key = await dpopKey();
    const { app } = await appWithClient();

    const response = await app.request(
      pushedRequest({ dpop_jkt: key.jkt }, { DPoP: await dpopProof(key, { htm: 'POST', htu: PAR_ENDPOINT }) }),
    );

    expect(response.status).toBe(201);
  });

  it('should reject a dpop_jkt of another key than the DPoP proof', async () => {
    const key = await dpopKey();
    const { app } = await appWithClient();

    const response = await app.request(
      pushedRequest({ dpop_jkt: OTHER_JKT }, { DPoP: await dpopProof(key, { htm: 'POST', htu: PAR_ENDPOINT }) }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store');
    expect(await response.json()).toEqual({
      error: 'invalid_dpop_proof',
      error_description: 'dpop_jkt does not match the key of the DPoP proof',
    });
  });

  it('should reject a DPoP proof made for another endpoint', async () => {
    const key = await dpopKey();
    const { app } = await appWithClient();

    const response = await app.request(pushedRequest({}, { DPoP: await dpopProof(key, { htm: 'POST', htu: `${TEST_ISSUER}/token` }) }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_dpop_proof',
      error_description: 'The DPoP proof htu claim does not match the request URI',
    });
  });

  it('should push a request without a DPoP header as it is, its dpop_jkt included', async () => {
    const { app, db } = await appWithClient();

    const pushed = await app.request(pushedRequest({ dpop_jkt: OTHER_JKT }));
    const { request_uri: requestUri } = (await pushed.json()) as { request_uri: string };
    await app.request(requestTo(`/authorize?${new URLSearchParams({ client_id: 'par-client', request_uri: requestUri })}`));

    expect(pushed.status).toBe(201);
    expect([...db.transactions.values()].map((entry) => (entry.value as { cnf?: unknown }).cnf)).toEqual([{ jkt: OTHER_JKT }]);
  });
});
