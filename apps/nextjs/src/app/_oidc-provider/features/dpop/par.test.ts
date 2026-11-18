import { NextRequest } from 'next/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, requestTo } from '../../../../test-support/context';
import { dpopKey, dpopProof } from '../../../../test-support/dpop';
import { POST as push } from '../../../(par)/par/route';
import { GET as authorize } from '../../../authorize/route';
import { createDatabase, registerClient } from '../../db';
import { stores } from '../../provider';
import { bindPushedDpopKey } from './par';

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) for the whole file.

const CLIENT_ID = 'dpop-par-client';
const CLIENT_SECRET = 'dpop-par-secret';
const REDIRECT_URI = 'https://rp.example.com/callback';
const PAR_ENDPOINT = `${TEST_ISSUER}/par`;
/** RFC 7636 Appendix B: the S256 code_challenge of its example code_verifier. */
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
// RFC 7638 §3.1: the thumbprint of its example key.
const OTHER_JKT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';

beforeAll(async () => {
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
});

afterEach(() => vi.restoreAllMocks());

/** A pushed authorization request of the client, with the given fields and headers. */
function pushedRequest(fields: Record<string, string> = {}, headers: Record<string, string> = {}): Request {
  return new Request(PAR_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      ...headers,
    },
    body: new URLSearchParams({
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: 'openid',
      state: 'state-1',
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: 'S256',
      ...fields,
    }).toString(),
  });
}

/** Push the request, open /authorize with its request_uri, and return the status of the push and the cnf of the transaction /authorize stored. */
async function pushAndAuthorize(request: Request): Promise<{ status: number; transactionCnf: unknown[] }> {
  const pushed = await push(request);
  const { request_uri: requestUri } = (await pushed.json()) as { request_uri: string };
  const put = vi.spyOn(stores.transactionStore, 'put');
  await authorize(new NextRequest(requestTo(`/authorize?${new URLSearchParams({ client_id: CLIENT_ID, request_uri: requestUri })}`)));
  return { status: pushed.status, transactionCnf: put.mock.calls.map((call) => (call[1] as { cnf?: unknown }).cnf) };
}

describe('bindPushedDpopKey', () => {
  // RFC 9449 §10.1: the DPoP header of PAR binds the authorization code to its key.
  it('should carry the key of the DPoP proof to the transaction /authorize opens for the request_uri', async () => {
    const key = await dpopKey();

    const { status, transactionCnf } = await pushAndAuthorize(
      pushedRequest({}, { DPoP: await dpopProof(key, { htm: 'POST', htu: PAR_ENDPOINT }) }),
    );

    expect(status).toBe(201);
    expect(transactionCnf).toEqual([{ jkt: key.jkt }]);
  });

  it('should accept a dpop_jkt of the same key as the DPoP proof', async () => {
    const key = await dpopKey();

    const response = await push(pushedRequest({ dpop_jkt: key.jkt }, { DPoP: await dpopProof(key, { htm: 'POST', htu: PAR_ENDPOINT }) }));

    expect(response.status).toBe(201);
  });

  it('should reject a dpop_jkt of another key than the DPoP proof', async () => {
    const key = await dpopKey();

    const response = await push(pushedRequest({ dpop_jkt: OTHER_JKT }, { DPoP: await dpopProof(key, { htm: 'POST', htu: PAR_ENDPOINT }) }));

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({
      error: 'invalid_dpop_proof',
      error_description: 'dpop_jkt does not match the key of the DPoP proof',
    });
  });

  it('should reject a DPoP proof made for another endpoint', async () => {
    const key = await dpopKey();

    const response = await push(pushedRequest({}, { DPoP: await dpopProof(key, { htm: 'POST', htu: `${TEST_ISSUER}/token` }) }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_dpop_proof',
      error_description: 'The DPoP proof htu claim does not match the request URI',
    });
  });

  it('should push a request without a DPoP header as it is, its dpop_jkt included', async () => {
    const { status, transactionCnf } = await pushAndAuthorize(pushedRequest({ dpop_jkt: OTHER_JKT }));

    expect(status).toBe(201);
    expect(transactionCnf).toEqual([{ jkt: OTHER_JKT }]);
  });

  it('should return the pushed parameters with dpop_jkt set to the key of the proof, or nothing without a DPoP header', async () => {
    const key = await dpopKey();
    const pushedParams = { client_id: CLIENT_ID, response_type: 'code' };
    const proof = await dpopProof(key, { htm: 'POST', htu: PAR_ENDPOINT });

    expect([
      await bindPushedDpopKey(new Request(PAR_ENDPOINT, { method: 'POST', headers: { DPoP: proof } }), pushedParams),
      await bindPushedDpopKey(new Request(PAR_ENDPOINT, { method: 'POST' }), pushedParams),
    ]).toEqual([{ dpopBoundParams: { ...pushedParams, dpop_jkt: key.jkt } }, {}]);
  });
});
