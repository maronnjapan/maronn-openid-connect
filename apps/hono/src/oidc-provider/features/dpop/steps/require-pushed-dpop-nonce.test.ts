import type { Jwk } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, formPost } from '../../../../test-support/context.js';
import { dpopKey, dpopProof, signDpopProof, type DpopKey } from '../../../../test-support/dpop.js';
import { TEST_CODE_CHALLENGE, basicAuthorization, providerApp, signRs256Jwt } from '../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { NOW } from '../../../../test-support/token.js';
import type { ClientRegistration } from '../../../config.js';
import { registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { parStore } from '../../par/store.js';

const CLIENT_ID = 'par-nonce-client';
const CLIENT_SECRET = 'par-nonce-secret';
const PKJWT_CLIENT_ID = 'par-nonce-pkjwt-client';
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const REDIRECT_URI = 'https://rp.example.com/callback';
const RP_ORIGIN = 'https://rp.example.com';
const PAR_ENDPOINT = `${TEST_ISSUER}/par`;
const PUSHED_FIELDS = {
  response_type: 'code',
  redirect_uri: REDIRECT_URI,
  scope: 'openid',
  state: 'state-1',
  code_challenge: TEST_CODE_CHALLENGE,
  code_challenge_method: 'S256',
};
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * The provider app with the client of client_secret_basic (and otherClient
 * when given), the secret of the DPoP nonces of the tests and the settings of
 * config: by default, the authorization server requires its nonces.
 */
async function appWithClient(
  config: Record<string, unknown> = { dpopNonceRequiredAtAuthorizationServer: true },
  secret = NONCE_SECRET,
  otherClient?: ClientRegistration,
) {
  const db = createEmptyDatabase();
  await registerClient(db, {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
  if (otherClient !== undefined) await registerClient(db, otherClient);
  const { app } = await providerApp(db, { dpopNonceSecret: secret, config });
  return app;
}

/** A pushed authorization request of the client with the headers, authenticated with secret. */
function pushedRequest(headers: Record<string, string>, secret = CLIENT_SECRET): Request {
  return formPost('/par', PUSHED_FIELDS, { Authorization: basicAuthorization(CLIENT_ID, secret), ...headers });
}

/** A DPoP proof for the PAR endpoint, signed by key (a new one unless given), with the claims of overrides. */
async function parProof(overrides: Record<string, unknown> = {}, key?: DpopKey): Promise<string> {
  return dpopProof(key ?? (await dpopKey()), { htm: 'POST', htu: PAR_ENDPOINT }, overrides);
}

/** The status and the JSON body of a response. */
async function answerOf(response: Response): Promise<[number, unknown]> {
  return [response.status, await response.json()];
}

describe('requirePushedDpopNonce', () => {
  // RFC 9449 §8 Figure 20: 400 use_dpop_nonce with the nonce to use in DPoP-Nonce, as PAR answers its errors
  // (RFC 9126 §2.3), with the CORS headers that let a browser read the nonce.
  it('should answer a DPoP proof without a nonce with use_dpop_nonce and a nonce to use, and store nothing', async () => {
    const app = await appWithClient();
    const save = vi.spyOn(parStore, 'save');

    const response = await app.request(pushedRequest({ DPoP: await parProof(), Origin: RP_ORIGIN }));

    expect(await answerOf(response)).toEqual([400, { error: 'use_dpop_nonce', error_description: NONCE_REQUIRED }]);
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
    expect([response.headers.get('Cache-Control'), response.headers.get('Pragma')]).toEqual(['no-cache, no-store', 'no-cache']);
    expect([response.headers.get('Access-Control-Allow-Origin'), response.headers.get('Access-Control-Expose-Headers')]).toEqual([
      '*',
      'WWW-Authenticate,DPoP-Nonce',
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  // RFC 9449 §8 / §8.2: the retry with the nonce is pushed, and the 201 carries the nonce to use next.
  it('should push the retry with the nonce it gave, bound to the key of the proof, with the next nonce', async () => {
    const app = await appWithClient();
    const key = await dpopKey();
    const nonce = (await app.request(pushedRequest({ DPoP: await parProof({}, key) }))).headers.get('DPoP-Nonce') ?? '';

    const retry = await app.request(pushedRequest({ DPoP: await parProof({ nonce }, key) }));

    expect(retry.status).toBe(201);
    expect(retry.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
    expect(retry.headers.get('DPoP-Nonce')).not.toBe(nonce);
    const { request_uri: requestUri } = (await retry.json()) as { request_uri: string };
    expect((await parStore.consume(requestUri))?.params.dpop_jkt).toBe(key.jkt);
  });

  // The nonce is checked before client authentication: a request that would fail it is answered use_dpop_nonce first.
  it('should check the nonce before the client is authenticated', async () => {
    const app = await appWithClient();

    const response = await app.request(pushedRequest({ DPoP: await parProof() }, 'wrong-secret'));

    expect(await answerOf(response)).toEqual([400, { error: 'use_dpop_nonce', error_description: NONCE_REQUIRED }]);
  });

  // The nonce is checked before client authentication, so the retry can send the same client assertion.
  it('should not use up the client assertion of a request rejected for its nonce', async () => {
    const clientKey = await rs256Key('par-nonce-pkjwt-key');
    const app = await appWithClient(undefined, undefined, {
      clientId: PKJWT_CLIENT_ID,
      redirectUris: [REDIRECT_URI],
      tokenEndpointAuthMethods: ['private_key_jwt'],
      keys: { private_key_jwt: { keys: [{ ...(clientKey.publicJwk as Jwk), kid: clientKey.keyId }] } },
    });
    const assertion = await signRs256Jwt(
      { iss: PKJWT_CLIENT_ID, sub: PKJWT_CLIENT_ID, aud: PAR_ENDPOINT, iat: NOW, exp: NOW + 60, jti: 'par-nonce-assertion-1' },
      clientKey,
    );
    const fields = { ...PUSHED_FIELDS, client_id: PKJWT_CLIENT_ID, client_assertion_type: JWT_BEARER, client_assertion: assertion };
    const key = await dpopKey();
    const first = await app.request(formPost('/par', fields, { DPoP: await parProof({}, key) }));

    const retry = await app.request(formPost('/par', fields, { DPoP: await parProof({ nonce: first.headers.get('DPoP-Nonce') }, key) }));

    expect([first.status, retry.status]).toEqual([400, 201]);
  });

  // RFC 9449 §4.3: the proof is decoded before client authentication to read its nonce, so a JOSE header that
  // is not of a DPoP proof is rejected then too, with the nonce to use next.
  it('should reject a proof whose typ is not dpop+jwt before the client is authenticated, with the nonce to use', async () => {
    const app = await appWithClient();
    const proof = await signDpopProof(
      await dpopKey(),
      { jti: 'par-nonce-typ-jwt', htm: 'POST', htu: PAR_ENDPOINT, iat: NOW, nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW },
      { typ: 'JWT' },
    );

    const response = await app.request(pushedRequest({ DPoP: proof }, 'wrong-secret'));

    expect(await answerOf(response)).toEqual([
      400,
      { error: 'invalid_dpop_proof', error_description: 'The DPoP proof typ header must be dpop+jwt' },
    ]);
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
  });

  // The PAR endpoint and the token endpoint are the same authorization server: a nonce of either is good at both.
  it('should accept a nonce the authorization server issued with the secret of the options', async () => {
    const app = await appWithClient();

    const response = await app.request(pushedRequest({ DPoP: await parProof({ nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW }) }));

    expect(response.status).toBe(201);
  });

  // RFC 9449 §9: a nonce of the resource server is not accepted by the authorization server.
  it('should reject a nonce of the resource server', async () => {
    const app = await appWithClient();

    const response = await app.request(pushedRequest({ DPoP: await parProof({ nonce: RESOURCE_SERVER_NONCE_AT_NOW }) }));

    expect(await answerOf(response)).toEqual([400, { error: 'use_dpop_nonce', error_description: STALE_NONCE }]);
  });

  // RFC 9449 §8: every response to a DPoP request carries the nonce to use next, the other errors too.
  it.each([
    ['a proof for another endpoint', `${TEST_ISSUER}/token`, CLIENT_SECRET, 400, 'invalid_dpop_proof'],
    ['a request that fails client authentication', PAR_ENDPOINT, 'wrong-secret', 401, 'invalid_client'],
  ])('should give the nonce to use next with the error of %s', async (_name, htu, secret, status, error) => {
    const app = await appWithClient();
    const proof = await dpopProof(await dpopKey(), { htm: 'POST', htu }, { nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW });

    const response = await app.request(pushedRequest({ DPoP: proof }, secret));

    expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([status, error]);
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
  });

  // RFC 9449 §11.3: a server that provides no nonce requires none.
  it.each([
    ['without a nonce', {}],
    ['with a nonce the server never issued', { nonce: 'a-nonce-of-another-server' }],
  ])('should neither give nor require a nonce when dpopNonceRequiredAtAuthorizationServer is false: a proof %s', async (_name, claims) => {
    const app = await appWithClient({});

    const response = await app.request(pushedRequest({ DPoP: await parProof(claims) }));

    expect(response.status).toBe(201);
    expect(response.headers.has('DPoP-Nonce')).toBe(false);
  });

  it('should give no nonce to a request without a DPoP header', async () => {
    const app = await appWithClient();

    const response = await app.request(pushedRequest({}));

    expect(response.status).toBe(201);
    expect(response.headers.has('DPoP-Nonce')).toBe(false);
  });

  // RFC 2104 §3: a secret shorter than 32 bytes is a misconfiguration, not a bad request.
  it('should answer server_error when the secret of the DPoP nonces is shorter than 32 bytes', async () => {
    const app = await appWithClient({ dpopNonceRequiredAtAuthorizationServer: true }, 'a'.repeat(31));

    const response = await app.request(pushedRequest({ DPoP: await parProof() }));

    expect(await answerOf(response)).toEqual([500, { error: 'server_error' }]);
  });
});
