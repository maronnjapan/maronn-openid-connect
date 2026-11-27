import type { Jwk } from '@maronn-openid-connect/core';
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, requestTo } from '../../../../test-support/context';
import { dpopKey, dpopProof, signDpopProof, type DpopKey } from '../../../../test-support/dpop';
import { decodeJwt, signRs256Jwt } from '../../../../test-support/jwt';
import { rs256Key } from '../../../../test-support/keys';
import { POST as push } from '../../../(par)/par/route';
import { GET as authorize } from '../../../authorize/route';
import { POST as token } from '../../../token/route';
import { SESSION_COOKIE_NAME } from '../../cookies';
import { createDatabase, registerClient } from '../../db';
import { config, stores } from '../../provider';
import { parStore } from '../par/store';
import { DpopError } from './errors';
import type { DpopPublicJwk } from './jwk';
import { bindPushedDpopKey } from './par';
import { verifyDpopRequestProof } from './proof';

// The proof checks as a spy that runs them, so a test can make them fail with
// a code they never throw at the PAR endpoint.
vi.mock('./proof', async (importOriginal) => {
  const original = await importOriginal<typeof import('./proof')>();
  return { ...original, verifyDpopRequestProof: vi.fn(original.verifyDpopRequestProof) };
});

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) and the par feature its pushed
// requests in one parStore, both for the whole file: the tests share the
// client beforeAll registers, every request_uri a test pushes is new, and
// every DPoP proof has a jti of its own.

const CLIENT_ID = 'dpop-par-client';
const CLIENT_SECRET = 'dpop-par-secret';
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const REDIRECT_URI = 'https://rp.example.com/callback';
const PAR_ENDPOINT = `${TEST_ISSUER}/par`;
/** RFC 7636 Appendix B: an example code_verifier and its S256 code_challenge. */
const CODE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const PUSHED_FIELDS = {
  response_type: 'code',
  redirect_uri: REDIRECT_URI,
  scope: 'openid',
  state: 'state-1',
  code_challenge: CODE_CHALLENGE,
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

const SAVED_MAX_AGE = config.dpopProofMaxAgeSeconds;
const SAVED_NONCE_REQUIRED = config.dpopNonceRequiredAtAuthorizationServer;

/** 2026-01-01T00:00:00Z in Unix seconds: the clock of the tests of the DPoP nonces. */
const NOW = 1_767_225_600;
/** The secret of the DPoP nonces of the tests (41 bytes). */
const NONCE_SECRET = 'dpop-nonce-secret-for-the-unit-tests-0001';
/**
 * The nonce the authorization server of https://op.example.com (TEST_ISSUER)
 * issues at NOW with NONCE_SECRET and the random bytes 0x00 to 0x0b, computed
 * apart from the code under test with the HMAC of node:crypto (see
 * nonce.test.ts).
 */
const AUTHORIZATION_SERVER_NONCE_AT_NOW = 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qlRn_qjLCd4ScDSkutyR475dsXalwZpCxni6jPVshAI';
/** The nonce the resource server of TEST_ISSUER issues at NOW, with the same secret and random bytes. */
const RESOURCE_SERVER_NONCE_AT_NOW = 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qMJbK4hF-YMMuV93-YOisKgT890kG1mcLWrlBS0Hgvc';
/** The form of a nonce of this OP (RFC 9449 §8.1): the base64url of 20 bytes, a dot and the base64url of an HMAC-SHA256. */
const NONCE_FORM = /^[A-Za-z0-9_-]{27}\.[A-Za-z0-9_-]{43}$/;
const NONCE_REQUIRED = 'Authorization server requires nonce in DPoP proof';
const STALE_NONCE = 'The DPoP proof nonce is not a nonce the authorization server recently provided';

beforeAll(async () => {
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
});

afterEach(() => {
  config.dpopProofMaxAgeSeconds = SAVED_MAX_AGE;
  config.dpopNonceRequiredAtAuthorizationServer = SAVED_NONCE_REQUIRED;
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

/** A DPoP proof for the PAR endpoint, signed by key (a new one unless given), with the claims of overrides (a nonce, or none). */
async function nonceProof(overrides: Record<string, unknown> = {}, key?: DpopKey): Promise<string> {
  return dpopProof(key ?? (await dpopKey()), { htm: 'POST', htu: PAR_ENDPOINT }, overrides);
}

/** The Authorization header of client_secret_basic for the client, with secret. */
function basicAuthorization(secret = CLIENT_SECRET): string {
  return `Basic ${btoa(`${CLIENT_ID}:${secret}`)}`;
}

/** A pushed authorization request of the client, with the fields over the usual code flow parameters and the headers. */
function pushedRequest(fields: Record<string, string> = {}, headers: Record<string, string> = {}, secret = CLIENT_SECRET): Request {
  return new Request(PAR_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuthorization(secret), ...headers },
    body: new URLSearchParams({ ...PUSHED_FIELDS, ...fields }).toString(),
  });
}

/** The parameters the PAR endpoint stored under the request_uri of its 201 (consumed, so /authorize can no longer use them). */
async function storedParamsOf(response: Response): Promise<Record<string, string> | undefined> {
  const { request_uri: requestUri } = (await response.json()) as { request_uri: string };
  return (await parStore.consume(requestUri))?.params;
}

/** The status and the JSON body of a response. */
async function answerOf(response: Response): Promise<[number, unknown]> {
  return [response.status, await response.json()];
}

/** A browser signed in as a subject of its own who consented to openid for the client, and its Cookie header. */
async function signedInBrowser(): Promise<string> {
  const id = crypto.randomUUID();
  await stores.browserSessionStore.set(`dpop-par-session-${id}`, { subject: `dpop-par-user-${id}`, authTime: Math.floor(Date.now() / 1000) - 60 });
  await stores.consentStore.grant(`dpop-par-user-${id}`, CLIENT_ID, ['openid']);
  return `${SESSION_COOKIE_NAME}=dpop-par-session-${id}`;
}

describe('bindPushedDpopKey', () => {
  // RFC 9449 §10.1: the key of the DPoP header is used as if it were sent as dpop_jkt.
  it('should store the pushed request with the key of the DPoP proof as its dpop_jkt', async () => {
    const response = await push(pushedRequest({}, { DPoP: await parProof(await clientKey()) }));

    expect(response.status).toBe(201);
    expect(await storedParamsOf(response)).toEqual({ ...PUSHED_FIELDS, client_id: CLIENT_ID, dpop_jkt: CLIENT_JKT });
  });

  // RFC 9449 §10.1: the subsequent token request is rejected unless it has a proof of the same key.
  it('should bind the code issued for the request_uri to the key of the DPoP proof of the pushed request', async () => {
    const key = await clientKey();
    const pushed = await push(pushedRequest({}, { DPoP: await parProof(key) }));
    const { request_uri: requestUri } = (await pushed.json()) as { request_uri: string };
    const authorization = await authorize(
      new NextRequest(
        requestTo(`/authorize?${new URLSearchParams({ client_id: CLIENT_ID, request_uri: requestUri })}`, {
          headers: { Cookie: await signedInBrowser() },
        }),
      ),
    );
    const code = new URL(authorization.headers.get('Location') ?? '').searchParams.get('code') ?? '';
    const exchange = async (proof?: string) =>
      token(
        new Request(`${TEST_ISSUER}/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: basicAuthorization(),
            ...(proof === undefined ? {} : { DPoP: proof }),
          },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER }).toString(),
        }),
      );

    const storedCode = await stores.authCodeStore.get(code);
    const withoutProof = await exchange();
    const withOtherKey = await exchange(await dpopProof(await dpopKey(), { htm: 'POST', htu: `${TEST_ISSUER}/token` }));
    const withKey = await exchange(await dpopProof(key, { htm: 'POST', htu: `${TEST_ISSUER}/token` }));
    const body = (await withKey.json()) as { access_token: string; token_type: string };

    expect(storedCode).toMatchObject({ cnf: { jkt: CLIENT_JKT } });
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
    const response = await push(pushedRequest({ dpop_jkt: CLIENT_JKT }, { DPoP: await parProof(await clientKey()) }));

    expect(response.status).toBe(201);
    expect(await storedParamsOf(response)).toEqual({ ...PUSHED_FIELDS, client_id: CLIENT_ID, dpop_jkt: CLIENT_JKT });
  });

  // RFC 6749 §3.1: an empty parameter is the same as no parameter, so the key of the proof is used.
  it('should replace an empty pushed dpop_jkt with the key of the DPoP proof', async () => {
    const response = await push(pushedRequest({ dpop_jkt: '' }, { DPoP: await parProof(await clientKey()) }));

    expect(response.status).toBe(201);
    expect(await storedParamsOf(response)).toEqual({ ...PUSHED_FIELDS, client_id: CLIENT_ID, dpop_jkt: CLIENT_JKT });
  });

  // RFC 9449 §10.1: when both are used, a dpop_jkt of another key than the proof MUST be rejected.
  it('should reject a pushed dpop_jkt of another key than the DPoP proof, and store nothing', async () => {
    const save = vi.spyOn(parStore, 'save');

    const response = await push(pushedRequest({ dpop_jkt: OTHER_JKT }, { DPoP: await parProof(await clientKey()) }));

    expect(await answerOf(response)).toEqual([
      400,
      { error: 'invalid_dpop_proof', error_description: 'dpop_jkt does not match the key of the DPoP proof' },
    ]);
    expect([response.headers.get('Cache-Control'), response.headers.get('Pragma')]).toEqual(['no-cache, no-store', 'no-cache']);
    expect(save).not.toHaveBeenCalled();
  });

  // RFC 9449 §4.3: the proof of a pushed request is checked as any other, with the URI of the PAR endpoint.
  it('should reject a DPoP proof made for another endpoint, and store nothing', async () => {
    const save = vi.spyOn(parStore, 'save');

    const response = await push(pushedRequest({}, { DPoP: await dpopProof(await clientKey(), { htm: 'POST', htu: `${TEST_ISSUER}/token` }) }));

    expect(await answerOf(response)).toEqual([
      400,
      { error: 'invalid_dpop_proof', error_description: 'The DPoP proof htu claim does not match the request URI' },
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  // RFC 9449 §4.3: a request has at most one DPoP header.
  it('should reject a pushed request with two DPoP headers', async () => {
    const key = await clientKey();
    const request = pushedRequest();
    request.headers.append('DPoP', await parProof(key));
    request.headers.append('DPoP', await parProof(key));

    const response = await push(request);

    expect(await answerOf(response)).toEqual([
      400,
      { error: 'invalid_dpop_proof', error_description: 'More than one DPoP header is not allowed' },
    ]);
  });

  // RFC 9126 §2.1: the pushed request is validated as the authorization endpoint would (RFC 9449 §10).
  it('should reject a pushed dpop_jkt that is not a thumbprint, and store nothing', async () => {
    const save = vi.spyOn(parStore, 'save');

    const response = await push(pushedRequest({ dpop_jkt: 'not-a-thumbprint' }));

    expect(await answerOf(response)).toEqual([400, { error: 'invalid_request', error_description: INVALID_DPOP_JKT }]);
    expect([response.headers.get('Cache-Control'), response.headers.get('Pragma')]).toEqual(['no-cache, no-store', 'no-cache']);
    expect(save).not.toHaveBeenCalled();
  });

  it('should reject a pushed dpop_jkt that is not a thumbprint before it checks the DPoP proof, and remember no jti', async () => {
    const proof = await parProof(await clientKey());
    const consume = vi.spyOn(stores.clientAssertionJtiStore, 'consume');

    const rejected = await push(pushedRequest({ dpop_jkt: 'not-a-thumbprint' }, { DPoP: proof }));
    const consumedOnRejection = consume.mock.calls.length;
    const accepted = await push(pushedRequest({}, { DPoP: proof }));

    expect(await answerOf(rejected)).toEqual([400, { error: 'invalid_request', error_description: INVALID_DPOP_JKT }]);
    expect(consumedOnRejection).toBe(0);
    expect(accepted.status).toBe(201);
  });

  // The proof is checked once the client is authenticated, as at the token endpoint.
  it('should remember no jti of a good proof sent with a pushed request that fails client authentication', async () => {
    const proof = await parProof(await clientKey());
    const consume = vi.spyOn(stores.clientAssertionJtiStore, 'consume');

    const rejected = await push(pushedRequest({}, { DPoP: proof }, 'wrong-secret'));
    const consumedOnRejection = consume.mock.calls.length;
    const accepted = await push(pushedRequest({}, { DPoP: proof }));

    expect([rejected.status, consumedOnRejection]).toEqual([401, 0]);
    expect(accepted.status).toBe(201);
    expect(await storedParamsOf(accepted)).toEqual({ ...PUSHED_FIELDS, client_id: CLIENT_ID, dpop_jkt: CLIENT_JKT });
  });

  // RFC 9449 §11.1: a proof is used once.
  it('should reject a DPoP proof used for a second pushed request', async () => {
    const proof = await parProof(await clientKey());

    const first = await push(pushedRequest({}, { DPoP: proof }));
    const replay = await push(pushedRequest({}, { DPoP: proof }));

    expect(first.status).toBe(201);
    expect(await answerOf(replay)).toEqual([
      400,
      { error: 'invalid_dpop_proof', error_description: 'The DPoP proof has already been used' },
    ]);
  });

  it('should store a pushed request without a DPoP header as it came, its dpop_jkt included', async () => {
    const withJkt = await push(pushedRequest({ dpop_jkt: OTHER_JKT }));
    const withoutJkt = await push(pushedRequest());

    expect([await storedParamsOf(withJkt), await storedParamsOf(withoutJkt)]).toEqual([
      { ...PUSHED_FIELDS, client_id: CLIENT_ID, dpop_jkt: OTHER_JKT },
      { ...PUSHED_FIELDS, client_id: CLIENT_ID },
    ]);
  });

  // The rejection is an answer of the route, so POST puts the CORS headers of the endpoint on it.
  it('should keep the CORS headers on a rejected DPoP proof', async () => {
    const response = await push(
      pushedRequest({}, { Origin: TEST_ISSUER, DPoP: await dpopProof(await clientKey(), { htm: 'POST', htu: `${TEST_ISSUER}/token` }) }),
    );

    expect(response.status).toBe(400);
    expect([response.headers.get('Access-Control-Allow-Origin'), response.headers.get('Access-Control-Expose-Headers')]).toEqual([
      TEST_ISSUER,
      'WWW-Authenticate,DPoP-Nonce',
    ]);
  });

  // A window that is not a non-negative finite number is a misconfiguration, not a bad proof.
  it('should answer server_error when the iat window of the DPoP settings is not a number', async () => {
    config.dpopProofMaxAgeSeconds = Number.NaN;

    const response = await push(pushedRequest({}, { DPoP: await parProof(await clientKey()) }));

    expect(await answerOf(response)).toEqual([500, { error: 'server_error' }]);
  });

  // invalid_grant and invalid_token are codes of the token endpoint and of a protected resource, not of PAR.
  it.each(['invalid_grant', 'invalid_token'] as const)('should answer server_error for a DPoP failure of the code %s', async (code) => {
    vi.mocked(verifyDpopRequestProof).mockRejectedValueOnce(new DpopError(code, 'A failure the PAR endpoint does not answer'));

    const response = await push(pushedRequest({}, { DPoP: await parProof(await clientKey()) }));

    expect(await answerOf(response)).toEqual([500, { error: 'server_error' }]);
  });

  it('should return the pushed parameters with dpop_jkt set to the key of the proof, or nothing without a DPoP header', async () => {
    const pushedParams = { client_id: CLIENT_ID, response_type: 'code' };
    const proof = await parProof(await clientKey());

    expect([
      await bindPushedDpopKey(new Request(PAR_ENDPOINT, { method: 'POST', headers: { DPoP: proof } }), pushedParams),
      await bindPushedDpopKey(new Request(PAR_ENDPOINT, { method: 'POST' }), pushedParams),
    ]).toEqual([{ dpopBoundParams: { client_id: CLIENT_ID, response_type: 'code', dpop_jkt: CLIENT_JKT } }, {}]);
  });

  // RFC 9449 §8 / §11.3: where the authorization server requires its nonce, the proof check after client
  // authentication checks the nonce again with the signature, and answers use_dpop_nonce as PAR answers its errors.
  it('should answer use_dpop_nonce to a proof without a nonce when dpopNonceRequiredAtAuthorizationServer is true', async () => {
    config.dpopNonceRequiredAtAuthorizationServer = true;
    const proof = await parProof(await clientKey());

    const { dpopRejection } = await bindPushedDpopKey(new Request(PAR_ENDPOINT, { method: 'POST', headers: { DPoP: proof } }), { client_id: CLIENT_ID });

    expect(await answerOf(dpopRejection as Response)).toEqual([
      400,
      { error: 'use_dpop_nonce', error_description: 'Authorization server requires nonce in DPoP proof' },
    ]);
  });
});

describe('requirePushedDpopNonce', () => {
  beforeEach(() => {
    config.dpopNonceRequiredAtAuthorizationServer = true;
    vi.stubEnv('OIDC_DPOP_NONCE_SECRET', NONCE_SECRET);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // RFC 9449 §8 Figure 20: 400 use_dpop_nonce with the nonce to use in DPoP-Nonce, as PAR answers its errors
  // (RFC 9126 §2.3), with the CORS headers that let a browser read the nonce.
  it('should answer a DPoP proof without a nonce with use_dpop_nonce and a nonce to use, and store nothing', async () => {
    const save = vi.spyOn(parStore, 'save');

    const response = await push(pushedRequest({}, { DPoP: await nonceProof(), Origin: TEST_ISSUER }));

    expect(await answerOf(response)).toEqual([400, { error: 'use_dpop_nonce', error_description: NONCE_REQUIRED }]);
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
    expect([response.headers.get('Cache-Control'), response.headers.get('Pragma')]).toEqual(['no-cache, no-store', 'no-cache']);
    expect([response.headers.get('Access-Control-Allow-Origin'), response.headers.get('Access-Control-Expose-Headers')]).toEqual([
      TEST_ISSUER,
      'WWW-Authenticate,DPoP-Nonce',
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  // RFC 9449 §8 / §8.2: the retry with the nonce is pushed, and the 201 carries the nonce to use next.
  it('should push the retry with the nonce it gave, bound to the key of the proof, with the next nonce', async () => {
    const key = await dpopKey();
    const nonce = (await push(pushedRequest({}, { DPoP: await nonceProof({}, key) }))).headers.get('DPoP-Nonce') ?? '';

    const retry = await push(pushedRequest({}, { DPoP: await nonceProof({ nonce }, key) }));

    expect(retry.status).toBe(201);
    expect(retry.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
    expect(retry.headers.get('DPoP-Nonce')).not.toBe(nonce);
    expect((await storedParamsOf(retry))?.dpop_jkt).toBe(key.jkt);
  });

  // The nonce is checked before client authentication: a request that would fail it is answered use_dpop_nonce first.
  it('should check the nonce before the client is authenticated', async () => {
    const response = await push(pushedRequest({}, { DPoP: await nonceProof() }, 'wrong-secret'));

    expect(await answerOf(response)).toEqual([400, { error: 'use_dpop_nonce', error_description: NONCE_REQUIRED }]);
  });

  // The nonce is checked before client authentication, so the retry can send the same client assertion.
  it('should not use up the client assertion of a request rejected for its nonce', async () => {
    const pkjwtClientId = `dpop-par-pkjwt-client-${crypto.randomUUID()}`;
    const clientKey = await rs256Key('dpop-par-nonce-pkjwt-key');
    await registerClient(createDatabase(), {
      clientId: pkjwtClientId,
      redirectUris: [REDIRECT_URI],
      tokenEndpointAuthMethods: ['private_key_jwt'],
      keys: { private_key_jwt: { keys: [{ ...(clientKey.publicJwk as Jwk), kid: clientKey.keyId }] } },
    });
    const assertion = await signRs256Jwt(
      { iss: pkjwtClientId, sub: pkjwtClientId, aud: PAR_ENDPOINT, iat: NOW, exp: NOW + 60, jti: `dpop-par-nonce-assertion-${crypto.randomUUID()}` },
      clientKey,
    );
    const fields = { client_id: pkjwtClientId, client_assertion_type: JWT_BEARER, client_assertion: assertion };
    const key = await dpopKey();
    const first = await push(pushedRequest(fields, { Authorization: '', DPoP: await nonceProof({}, key) }));

    const retry = await push(pushedRequest(fields, { Authorization: '', DPoP: await nonceProof({ nonce: first.headers.get('DPoP-Nonce') }, key) }));

    expect([first.status, retry.status]).toEqual([400, 201]);
  });

  // RFC 9449 §4.3: the proof is decoded before client authentication to read its nonce, so a JOSE header that
  // is not of a DPoP proof is rejected then too, with the nonce to use next.
  it('should reject a proof whose typ is not dpop+jwt before the client is authenticated, with the nonce to use', async () => {
    const proof = await signDpopProof(
      await dpopKey(),
      { jti: `dpop-par-nonce-typ-jwt-${crypto.randomUUID()}`, htm: 'POST', htu: PAR_ENDPOINT, iat: NOW, nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW },
      { typ: 'JWT' },
    );

    const response = await push(pushedRequest({}, { DPoP: proof }, 'wrong-secret'));

    expect(await answerOf(response)).toEqual([
      400,
      { error: 'invalid_dpop_proof', error_description: 'The DPoP proof typ header must be dpop+jwt' },
    ]);
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
  });

  // The PAR endpoint and the token endpoint are the same authorization server: a nonce of either is good at both.
  it('should accept a nonce the authorization server issued with the secret of OIDC_DPOP_NONCE_SECRET', async () => {
    const response = await push(pushedRequest({}, { DPoP: await nonceProof({ nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW }) }));

    expect(response.status).toBe(201);
  });

  // RFC 9449 §9: a nonce of the resource server is not accepted by the authorization server.
  it('should reject a nonce of the resource server', async () => {
    const response = await push(pushedRequest({}, { DPoP: await nonceProof({ nonce: RESOURCE_SERVER_NONCE_AT_NOW }) }));

    expect(await answerOf(response)).toEqual([400, { error: 'use_dpop_nonce', error_description: STALE_NONCE }]);
  });

  // RFC 9449 §8: every response to a DPoP request carries the nonce to use next, the other errors too.
  it.each([
    ['a proof for another endpoint', `${TEST_ISSUER}/token`, CLIENT_SECRET, 400, 'invalid_dpop_proof'],
    ['a request that fails client authentication', PAR_ENDPOINT, 'wrong-secret', 401, 'invalid_client'],
  ])('should give the nonce to use next with the error of %s', async (_name, htu, secret, status, error) => {
    const proof = await dpopProof(await dpopKey(), { htm: 'POST', htu }, { nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW });

    const response = await push(pushedRequest({}, { DPoP: proof }, secret));

    expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([status, error]);
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
  });

  // RFC 9449 §11.3: a server that provides no nonce requires none.
  it.each([
    ['without a nonce', {}],
    ['with a nonce the server never issued', { nonce: 'a-nonce-of-another-server' }],
  ])('should neither give nor require a nonce when dpopNonceRequiredAtAuthorizationServer is false: a proof %s', async (_name, claims) => {
    config.dpopNonceRequiredAtAuthorizationServer = false;

    const response = await push(pushedRequest({}, { DPoP: await nonceProof(claims) }));

    expect(response.status).toBe(201);
    expect(response.headers.has('DPoP-Nonce')).toBe(false);
  });

  it('should give no nonce to a request without a DPoP header', async () => {
    const response = await push(pushedRequest());

    expect(response.status).toBe(201);
    expect(response.headers.has('DPoP-Nonce')).toBe(false);
  });

  // RFC 2104 §3: a secret shorter than 32 bytes is a misconfiguration, not a bad request.
  it('should answer server_error when the secret of the DPoP nonces is shorter than 32 bytes', async () => {
    vi.stubEnv('OIDC_DPOP_NONCE_SECRET', 'a'.repeat(31));

    const response = await push(pushedRequest({}, { DPoP: await nonceProof() }));

    expect(await answerOf(response)).toEqual([500, { error: 'server_error' }]);
  });
});
