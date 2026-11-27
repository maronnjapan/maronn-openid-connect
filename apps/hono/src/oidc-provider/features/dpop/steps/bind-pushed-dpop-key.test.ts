import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUBJECT, signIn } from '../../../../test-support/authorize.js';
import { TEST_ISSUER, formPost, providerContext, requestTo } from '../../../../test-support/context.js';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop.js';
import { TEST_CODE_CHALLENGE, basicAuthorization, providerApp } from '../../../../test-support/feature-endpoints.js';
import { decodeJwt } from '../../../../test-support/token.js';
import type { ProviderConfig } from '../../../config.js';
import { registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase, type MemoryDatabase } from '../../../db/memory/database.js';
import { parStore } from '../../par/store.js';
import { DpopError } from '../errors.js';
import type { DpopPublicJwk } from '../jwk.js';
import { verifyDpopRequestProof } from '../proof.js';
import { bindPushedDpopKey } from './bind-pushed-dpop-key.js';

// The proof checks as a spy that runs them, so a test can make them fail with
// a code they never throw at the PAR endpoint.
vi.mock('../proof.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../proof.js')>();
  return { ...original, verifyDpopRequestProof: vi.fn(original.verifyDpopRequestProof) };
});

const CLIENT_ID = 'par-client';
const CLIENT_SECRET = 'par-secret';
const REDIRECT_URI = 'https://rp.example.com/callback';
const PAR_ENDPOINT = `${TEST_ISSUER}/par`;
/** The code_verifier of RFC 7636 Appendix B, whose S256 code_challenge is TEST_CODE_CHALLENGE. */
const CODE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PUSHED_FIELDS = {
  response_type: 'code',
  redirect_uri: REDIRECT_URI,
  scope: 'openid',
  state: 'state-1',
  code_challenge: TEST_CODE_CHALLENGE,
  code_challenge_method: 'S256',
};
/** The public members of a fixed ES256 key of the client. */
const CLIENT_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'fRpodt9wPIUUgQ1hGhE8DtMGQBGi29NF7XnC0c7SOr8',
  y: 'Ef7IgJphGPsp1sWHQRgaKNXWt6YyO0kQxWmZyJLPIdg',
};
/** The JWK Thumbprint (RFC 7638) of CLIENT_JWK, computed apart from the code under test. */
const CLIENT_JKT = 'PMLq-jbHKgCzJJln9PRqQ1RgHEYeATn_s2hFUH5rWPg';
/** The dpop_jkt of the authorization request of RFC 9449 Figure 25 (the thumbprint of RFC 7638 §3.1): another key than CLIENT_JWK. */
const OTHER_JKT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';
const INVALID_DPOP_JKT = 'dpop_jkt must be a base64url SHA-256 JWK Thumbprint';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The fixed key of the client, whose thumbprint is CLIENT_JKT. */
async function clientKey(): Promise<DpopKey> {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { ...CLIENT_JWK, d: 'DNHZTjp2Hcgb7U89vt8F5HIh0MfzhrEqNeEw7sXWvgE' },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  return { alg: 'ES256', privateKey, publicJwk: CLIENT_JWK as DpopPublicJwk, jkt: CLIENT_JKT };
}

/** A DPoP proof of key for the PAR endpoint. */
function parProof(key: DpopKey): Promise<string> {
  return dpopProof(key, { htm: 'POST', htu: PAR_ENDPOINT });
}

/** The provider app with the client of client_secret_basic, on a database of its own. */
async function appWithClient(config: Partial<ProviderConfig> = {}) {
  const db = createEmptyDatabase();
  await registerClient(db, {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
  return { db, ...(await providerApp(db, { config })) };
}

/** A pushed authorization request of the client, with the fields over the usual code flow parameters and the headers. */
function pushedRequest(fields: Record<string, string> = {}, headers: Record<string, string> = {}, secret = CLIENT_SECRET): Request {
  return formPost('/par', { ...PUSHED_FIELDS, ...fields }, { Authorization: basicAuthorization(CLIENT_ID, secret), ...headers });
}

/** The parameters the PAR endpoint stored under the request_uri of its 201 (consumed, so /authorize can no longer use them). */
async function storedParamsOf(response: Response): Promise<Record<string, string> | undefined> {
  const { request_uri: requestUri } = (await response.json()) as { request_uri: string };
  return (await parStore.consume(requestUri))?.params;
}

/** The cnf of every code stored in the database ('none' for a code without one). */
function codeConfirmations(db: MemoryDatabase): unknown[] {
  return [...db.codes.values()].map((code) => {
    const value = code as unknown as Record<string, unknown>;
    return 'cnf' in value ? value['cnf'] : 'none';
  });
}

/** The status and the JSON body of a response. */
async function answerOf(response: Response): Promise<[number, unknown]> {
  return [response.status, await response.json()];
}

describe('bindPushedDpopKey', () => {
  // RFC 9449 §10.1: the key of the DPoP header is used as if it were sent as dpop_jkt.
  it('should store the pushed request with the key of the DPoP proof as its dpop_jkt', async () => {
    const { app } = await appWithClient();

    const response = await app.request(pushedRequest({}, { DPoP: await parProof(await clientKey()) }));

    expect(response.status).toBe(201);
    expect(await storedParamsOf(response)).toEqual({ ...PUSHED_FIELDS, client_id: CLIENT_ID, dpop_jkt: CLIENT_JKT });
  });

  // RFC 9449 §10.1: the subsequent token request is rejected unless it has a proof of the same key.
  it('should bind the code issued for the request_uri to the key of the DPoP proof of the pushed request', async () => {
    const key = await clientKey();
    const { app, db, stores } = await appWithClient();
    const pushed = await app.request(pushedRequest({}, { DPoP: await parProof(key) }));
    const { request_uri: requestUri } = (await pushed.json()) as { request_uri: string };
    const cookie = await signIn(stores);
    await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);
    const authorization = await app.request(
      requestTo(`/authorize?${new URLSearchParams({ client_id: CLIENT_ID, request_uri: requestUri })}`, { headers: { Cookie: cookie } }),
    );
    const code = new URL(authorization.headers.get('Location') ?? '').searchParams.get('code') ?? '';
    const exchange = async (proof?: string) =>
      app.request(
        formPost(
          '/token',
          { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER },
          { Authorization: basicAuthorization(CLIENT_ID, CLIENT_SECRET), ...(proof === undefined ? {} : { DPoP: proof }) },
        ),
      );

    const withoutProof = await exchange();
    const withOtherKey = await exchange(await dpopProof(await dpopKey(), { htm: 'POST', htu: `${TEST_ISSUER}/token` }));
    const withKey = await exchange(await dpopProof(key, { htm: 'POST', htu: `${TEST_ISSUER}/token` }));
    const body = (await withKey.json()) as { access_token: string; token_type: string };

    expect(codeConfirmations(db)).toEqual([{ jkt: CLIENT_JKT }]);
    expect(await answerOf(withoutProof)).toEqual([
      400,
      { error: 'invalid_grant', error_description: 'The grant is bound to a DPoP key, but no DPoP proof was sent' },
    ]);
    expect(await answerOf(withOtherKey)).toEqual([
      400,
      { error: 'invalid_grant', error_description: 'The DPoP proof key does not match the key the grant is bound to' },
    ]);
    expect([withKey.status, body.token_type, decodeJwt(body.access_token).payload['cnf']]).toEqual([200, 'DPoP', { jkt: CLIENT_JKT }]);
  });

  // RFC 9449 §10.1: both mechanisms may be used together when they name the same key.
  it('should accept a pushed dpop_jkt of the key of the DPoP proof', async () => {
    const { app } = await appWithClient();

    const response = await app.request(pushedRequest({ dpop_jkt: CLIENT_JKT }, { DPoP: await parProof(await clientKey()) }));

    expect(response.status).toBe(201);
    expect(await storedParamsOf(response)).toEqual({ ...PUSHED_FIELDS, client_id: CLIENT_ID, dpop_jkt: CLIENT_JKT });
  });

  // RFC 6749 §3.1: an empty parameter is the same as no parameter, so the key of the proof is used.
  it('should replace an empty pushed dpop_jkt with the key of the DPoP proof', async () => {
    const { app } = await appWithClient();

    const response = await app.request(pushedRequest({ dpop_jkt: '' }, { DPoP: await parProof(await clientKey()) }));

    expect(response.status).toBe(201);
    expect(await storedParamsOf(response)).toEqual({ ...PUSHED_FIELDS, client_id: CLIENT_ID, dpop_jkt: CLIENT_JKT });
  });

  // RFC 9449 §10.1: when both are used, a dpop_jkt of another key than the proof MUST be rejected.
  it('should reject a pushed dpop_jkt of another key than the DPoP proof, and store nothing', async () => {
    const { app } = await appWithClient();
    const save = vi.spyOn(parStore, 'save');

    const response = await app.request(pushedRequest({ dpop_jkt: OTHER_JKT }, { DPoP: await parProof(await clientKey()) }));

    expect(await answerOf(response)).toEqual([
      400,
      { error: 'invalid_dpop_proof', error_description: 'dpop_jkt does not match the key of the DPoP proof' },
    ]);
    expect([response.headers.get('Cache-Control'), response.headers.get('Pragma')]).toEqual(['no-cache, no-store', 'no-cache']);
    expect(save).not.toHaveBeenCalled();
  });

  // RFC 9449 §4.3: the proof of a pushed request is checked as any other, with the URI of the PAR endpoint.
  it('should reject a DPoP proof made for another endpoint, and store nothing', async () => {
    const { app } = await appWithClient();
    const save = vi.spyOn(parStore, 'save');

    const response = await app.request(
      pushedRequest({}, { DPoP: await dpopProof(await clientKey(), { htm: 'POST', htu: `${TEST_ISSUER}/token` }) }),
    );

    expect(await answerOf(response)).toEqual([
      400,
      { error: 'invalid_dpop_proof', error_description: 'The DPoP proof htu claim does not match the request URI' },
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  // RFC 9449 §4.3: a request has at most one DPoP header.
  it('should reject a pushed request with two DPoP headers', async () => {
    const key = await clientKey();
    const { app } = await appWithClient();
    const request = pushedRequest();
    request.headers.append('DPoP', await parProof(key));
    request.headers.append('DPoP', await parProof(key));

    const response = await app.request(request);

    expect(await answerOf(response)).toEqual([
      400,
      { error: 'invalid_dpop_proof', error_description: 'More than one DPoP header is not allowed' },
    ]);
  });

  // RFC 9126 §2.1: the pushed request is validated as the authorization endpoint would (RFC 9449 §10).
  it('should reject a pushed dpop_jkt that is not a thumbprint, and store nothing', async () => {
    const { app } = await appWithClient();
    const save = vi.spyOn(parStore, 'save');

    const response = await app.request(pushedRequest({ dpop_jkt: 'not-a-thumbprint' }));

    expect(await answerOf(response)).toEqual([400, { error: 'invalid_request', error_description: INVALID_DPOP_JKT }]);
    expect([response.headers.get('Cache-Control'), response.headers.get('Pragma')]).toEqual(['no-cache, no-store', 'no-cache']);
    expect(save).not.toHaveBeenCalled();
  });

  it('should reject a pushed dpop_jkt that is not a thumbprint before it checks the DPoP proof, and remember no jti', async () => {
    const { app, db } = await appWithClient();
    const proof = await parProof(await clientKey());

    const rejected = await app.request(pushedRequest({ dpop_jkt: 'not-a-thumbprint' }, { DPoP: proof }));
    const accepted = await app.request(pushedRequest({}, { DPoP: proof }));

    expect(await answerOf(rejected)).toEqual([400, { error: 'invalid_request', error_description: INVALID_DPOP_JKT }]);
    expect(db.clientAssertionJtis.size).toBe(1);
    expect(accepted.status).toBe(201);
  });

  // The proof is checked once the client is authenticated, as at the token endpoint.
  it('should remember no jti of a good proof sent with a pushed request that fails client authentication', async () => {
    const { app, db } = await appWithClient();
    const proof = await parProof(await clientKey());

    const rejected = await app.request(pushedRequest({}, { DPoP: proof }, 'wrong-secret'));
    const jtisAfterRejection = db.clientAssertionJtis.size;
    const accepted = await app.request(pushedRequest({}, { DPoP: proof }));

    expect([rejected.status, jtisAfterRejection]).toEqual([401, 0]);
    expect(accepted.status).toBe(201);
    expect(await storedParamsOf(accepted)).toEqual({ ...PUSHED_FIELDS, client_id: CLIENT_ID, dpop_jkt: CLIENT_JKT });
  });

  // RFC 9449 §11.1: a proof is used once.
  it('should reject a DPoP proof used for a second pushed request', async () => {
    const { app } = await appWithClient();
    const proof = await parProof(await clientKey());

    const first = await app.request(pushedRequest({}, { DPoP: proof }));
    const replay = await app.request(pushedRequest({}, { DPoP: proof }));

    expect(first.status).toBe(201);
    expect(await answerOf(replay)).toEqual([
      400,
      { error: 'invalid_dpop_proof', error_description: 'The DPoP proof has already been used' },
    ]);
  });

  it('should store a pushed request without a DPoP header as it came, its dpop_jkt included', async () => {
    const { app } = await appWithClient();

    const withJkt = await app.request(pushedRequest({ dpop_jkt: OTHER_JKT }));
    const withoutJkt = await app.request(pushedRequest());

    expect([await storedParamsOf(withJkt), await storedParamsOf(withoutJkt)]).toEqual([
      { ...PUSHED_FIELDS, client_id: CLIENT_ID, dpop_jkt: OTHER_JKT },
      { ...PUSHED_FIELDS, client_id: CLIENT_ID },
    ]);
  });

  // The rejection is built through the context, so the CORS middleware's headers stay on it.
  it('should keep the CORS headers on a rejected DPoP proof', async () => {
    const { app } = await appWithClient();

    const response = await app.request(
      pushedRequest({}, { Origin: 'https://rp.example.com', DPoP: await dpopProof(await clientKey(), { htm: 'POST', htu: `${TEST_ISSUER}/token` }) }),
    );

    expect(response.status).toBe(400);
    expect([response.headers.get('Access-Control-Allow-Origin'), response.headers.get('Access-Control-Expose-Headers')]).toEqual([
      '*',
      'WWW-Authenticate,DPoP-Nonce',
    ]);
  });

  // A window that is not a non-negative finite number is a misconfiguration, not a bad proof.
  it('should answer server_error when the iat window of the DPoP settings is not a number', async () => {
    const { app } = await appWithClient({ dpopProofMaxAgeSeconds: Number.NaN });

    const response = await app.request(pushedRequest({}, { DPoP: await parProof(await clientKey()) }));

    expect(await answerOf(response)).toEqual([500, { error: 'server_error' }]);
  });

  // invalid_grant and invalid_token are codes of the token endpoint and of a protected resource, not of PAR.
  it.each(['invalid_grant', 'invalid_token'] as const)('should answer server_error for a DPoP failure of the code %s', async (code) => {
    const { app } = await appWithClient();
    vi.mocked(verifyDpopRequestProof).mockRejectedValueOnce(new DpopError(code, 'A failure the PAR endpoint does not answer'));

    const response = await app.request(pushedRequest({}, { DPoP: await parProof(await clientKey()) }));

    expect(await answerOf(response)).toEqual([500, { error: 'server_error' }]);
  });

  it('should return the pushed parameters with dpop_jkt set to the key of the proof, or nothing without a DPoP header', async () => {
    const pushedParams = { client_id: CLIENT_ID, response_type: 'code' };
    const proof = await parProof(await clientKey());
    const withProof = await providerContext({ request: new Request(PAR_ENDPOINT, { method: 'POST', headers: { DPoP: proof } }) });
    const withoutProof = await providerContext({ request: new Request(PAR_ENDPOINT, { method: 'POST' }) });

    expect([await bindPushedDpopKey(withProof.c, pushedParams), await bindPushedDpopKey(withoutProof.c, pushedParams)]).toEqual([
      { dpopBoundParams: { client_id: CLIENT_ID, response_type: 'code', dpop_jkt: CLIENT_JKT } },
      {},
    ]);
  });

  // RFC 9449 §8 / §11.3: where the authorization server requires its nonce, the proof check after client
  // authentication checks the nonce again with the signature, and answers use_dpop_nonce as PAR answers its errors.
  it('should answer use_dpop_nonce to a proof without a nonce when dpopNonceRequiredAtAuthorizationServer is true', async () => {
    const proof = await parProof(await clientKey());
    const { c } = await providerContext({
      request: new Request(PAR_ENDPOINT, { method: 'POST', headers: { DPoP: proof } }),
      options: { config: { dpopNonceRequiredAtAuthorizationServer: true } },
    });

    const { dpopRejection } = await bindPushedDpopKey(c, { client_id: CLIENT_ID });

    expect(await answerOf(dpopRejection as Response)).toEqual([
      400,
      { error: 'use_dpop_nonce', error_description: 'Authorization server requires nonce in DPoP proof' },
    ]);
  });
});
