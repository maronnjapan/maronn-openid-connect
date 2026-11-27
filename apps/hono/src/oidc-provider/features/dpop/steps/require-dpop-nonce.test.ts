import type { Jwk } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER } from '../../../../test-support/context.js';
import { dpopKey, dpopProof, signDpopProof, type DpopKey } from '../../../../test-support/dpop.js';
import { signRs256Jwt } from '../../../../test-support/feature-endpoints.js';
import { rs256Key, staticKeyProvider } from '../../../../test-support/keys.js';
import { CLIENT_ID, CLIENT_SECRET, NOW, REDIRECT_URI, basicAuthorization, confidentialClient, storedAuthorizationCode } from '../../../../test-support/token.js';
import { createApp } from '../../../app.js';
import type { ClientRegistration } from '../../../config.js';
import { createClientKeyResolver, createClientResolver, registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { createProviderStores } from '../../../db/memory/stores.js';

const TOKEN_ENDPOINT = `${TEST_ISSUER}/token`;
const RP_ORIGIN = 'https://rp.example.com';
// RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge.
const CODE_VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CODE_CHALLENGE = 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU';
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
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

interface TokenBody {
  token_type?: string;
  error?: string;
  error_description?: string;
}

/**
 * The provider on an in-memory database, with the client registered and
 * code-1 stored for it, the secret of the DPoP nonces of the tests and the
 * settings of config: by default, the authorization server requires its
 * nonces. client replaces the members of the confidential client-1.
 */
async function provider(config: Record<string, unknown> = { dpopNonceRequiredAtAuthorizationServer: true }, client: Partial<ClientRegistration> = {}, secret = NONCE_SECRET) {
  const db = createEmptyDatabase();
  const stores = createProviderStores(db);
  await registerClient(db, confidentialClient(client));
  await stores.authCodeStore.set('code-1', storedAuthorizationCode({ codeChallenge: CODE_CHALLENGE, codeChallengeMethod: 'S256' }));
  const app = createApp({
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: stores,
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    dpopNonceSecret: secret,
    config: { issuer: TEST_ISSUER, ...config },
  });
  const exchangeCode = (headers: Record<string, string>, fields: Record<string, string> = {}) =>
    app.request(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuthorization(CLIENT_ID, CLIENT_SECRET), ...headers },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER, ...fields }).toString(),
    });
  const codeIsUsed = async () => (await stores.authCodeStore.get('code-1'))?.used;
  return { exchangeCode, codeIsUsed };
}

function tokenProof(key: DpopKey, overrides: Record<string, unknown> = {}): Promise<string> {
  return dpopProof(key, { htm: 'POST', htu: TOKEN_ENDPOINT }, overrides);
}

describe('requireTokenDpopNonce', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // RFC 9449 §8 Figure 20: 400 use_dpop_nonce with the nonce to use in DPoP-Nonce, which a browser may read.
  it('should answer a DPoP proof without a nonce with use_dpop_nonce and a nonce to use, and leave the code unused', async () => {
    const { exchangeCode, codeIsUsed } = await provider();

    const response = await exchangeCode({ DPoP: await tokenProof(await dpopKey()), Origin: RP_ORIGIN });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'use_dpop_nonce', error_description: NONCE_REQUIRED });
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate,DPoP-Nonce');
    expect(await codeIsUsed()).toBe(false);
  });

  // RFC 9449 §8 / §8.2: the retry with the nonce succeeds, and the 200 carries the nonce to use next.
  it('should issue DPoP tokens to the retry with the nonce it gave, with the next nonce', async () => {
    const { exchangeCode } = await provider();
    const key = await dpopKey();
    const first = await exchangeCode({ DPoP: await tokenProof(key) });
    const nonce = first.headers.get('DPoP-Nonce') ?? '';

    const retry = await exchangeCode({ DPoP: await tokenProof(key, { nonce }) });

    expect(retry.status).toBe(200);
    expect(((await retry.json()) as TokenBody).token_type).toBe('DPoP');
    expect(retry.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
    expect(retry.headers.get('DPoP-Nonce')).not.toBe(nonce);
  });

  // The nonce is checked before client authentication, so the retry can send the same client assertion.
  it('should not use up the client assertion of a request rejected for its nonce', async () => {
    const clientKey = await rs256Key('dpop-nonce-pkjwt-key');
    const { exchangeCode } = await provider(
      { dpopNonceRequiredAtAuthorizationServer: true },
      {
        clientSecret: undefined,
        tokenEndpointAuthMethods: ['private_key_jwt'],
        keys: { private_key_jwt: { keys: [{ ...(clientKey.publicJwk as Jwk), kid: clientKey.keyId }] } },
      },
    );
    const assertion = await signRs256Jwt(
      { iss: CLIENT_ID, sub: CLIENT_ID, aud: TOKEN_ENDPOINT, iat: NOW, exp: NOW + 60, jti: 'dpop-nonce-assertion-1' },
      clientKey,
    );
    const assertionFields = { client_id: CLIENT_ID, client_assertion_type: JWT_BEARER, client_assertion: assertion };
    const key = await dpopKey();
    const first = await exchangeCode({ Authorization: '', DPoP: await tokenProof(key) }, assertionFields);

    const retry = await exchangeCode({ Authorization: '', DPoP: await tokenProof(key, { nonce: first.headers.get('DPoP-Nonce') }) }, assertionFields);

    expect([first.status, retry.status]).toEqual([400, 200]);
  });

  it('should check the nonce before the client is authenticated', async () => {
    const { exchangeCode } = await provider();

    const response = await exchangeCode({ Authorization: basicAuthorization(CLIENT_ID, 'wrong-secret'), DPoP: await tokenProof(await dpopKey()) });

    expect([response.status, ((await response.json()) as TokenBody).error]).toEqual([400, 'use_dpop_nonce']);
  });

  // RFC 9449 §4.3: the proof is decoded before client authentication to read its nonce, so a JOSE header that
  // is not of a DPoP proof is rejected then too, with the nonce to use next.
  it('should reject a proof whose typ is not dpop+jwt before the client is authenticated, with the nonce to use', async () => {
    const { exchangeCode } = await provider();
    const proof = await signDpopProof(
      await dpopKey(),
      { jti: 'dpop-nonce-typ-jwt', htm: 'POST', htu: TOKEN_ENDPOINT, iat: NOW, nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW },
      { typ: 'JWT' },
    );

    const response = await exchangeCode({ Authorization: basicAuthorization(CLIENT_ID, 'wrong-secret'), DPoP: proof });

    expect([response.status, await response.json()]).toEqual([
      400,
      { error: 'invalid_dpop_proof', error_description: 'The DPoP proof typ header must be dpop+jwt' },
    ]);
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
  });

  // RFC 9449 §8: a nonce older than dpopNonceLifetimeSeconds (120 by default) is no longer a recent one.
  it('should reject a nonce older than dpopNonceLifetimeSeconds and give a new one', async () => {
    const { exchangeCode } = await provider();
    const key = await dpopKey();
    const nonce = (await exchangeCode({ DPoP: await tokenProof(key) })).headers.get('DPoP-Nonce') ?? '';
    vi.setSystemTime((NOW + 121) * 1000);

    const response = await exchangeCode({ DPoP: await tokenProof(key, { nonce }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'use_dpop_nonce', error_description: STALE_NONCE });
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
    expect(response.headers.get('DPoP-Nonce')).not.toBe(nonce);
  });

  // The nonces are made with the secret of the options, so another instance with the secret accepts them.
  it('should accept a nonce the authorization server issued with the secret of the options', async () => {
    const { exchangeCode } = await provider();

    const response = await exchangeCode({ DPoP: await tokenProof(await dpopKey(), { nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW }) });

    expect([response.status, ((await response.json()) as TokenBody).token_type]).toEqual([200, 'DPoP']);
  });

  // RFC 9449 §9: a nonce of the resource server is not accepted by the authorization server.
  it('should reject a nonce of the resource server', async () => {
    const { exchangeCode } = await provider();

    const response = await exchangeCode({ DPoP: await tokenProof(await dpopKey(), { nonce: RESOURCE_SERVER_NONCE_AT_NOW }) });

    expect([response.status, await response.json()]).toEqual([400, { error: 'use_dpop_nonce', error_description: STALE_NONCE }]);
  });

  // RFC 9449 §8: every response to a DPoP request carries the nonce to use next, the other errors too.
  it.each([
    ['a proof for another endpoint', `${TEST_ISSUER}/par`, CLIENT_SECRET, 400, 'invalid_dpop_proof'],
    ['a request that fails client authentication', TOKEN_ENDPOINT, 'wrong-secret', 401, 'invalid_client'],
  ])('should give the nonce to use next with the error of %s', async (_name, htu, secret, status, error) => {
    const { exchangeCode } = await provider();
    const proof = await dpopProof(await dpopKey(), { htm: 'POST', htu }, { nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW });

    const response = await exchangeCode({ Authorization: basicAuthorization(CLIENT_ID, secret), DPoP: proof });

    expect([response.status, ((await response.json()) as TokenBody).error]).toEqual([status, error]);
    expect(response.headers.get('DPoP-Nonce')).toMatch(NONCE_FORM);
  });

  // RFC 9449 §11.3: a server that provides no nonce requires none.
  it.each([
    ['without a nonce', {}],
    ['with a nonce the server never issued', { nonce: 'a-nonce-of-another-server' }],
  ])('should neither give nor require a nonce when dpopNonceRequiredAtAuthorizationServer is false: a proof %s', async (_name, claims) => {
    const { exchangeCode } = await provider({});

    const response = await exchangeCode({ DPoP: await tokenProof(await dpopKey(), claims) });

    expect([response.status, ((await response.json()) as TokenBody).token_type]).toEqual([200, 'DPoP']);
    expect(response.headers.has('DPoP-Nonce')).toBe(false);
  });

  it('should give no nonce to a request without a DPoP header', async () => {
    const { exchangeCode } = await provider();

    const response = await exchangeCode({});

    expect([response.status, ((await response.json()) as TokenBody).token_type]).toEqual([200, 'Bearer']);
    expect(response.headers.has('DPoP-Nonce')).toBe(false);
  });

  // RFC 2104 §3: a secret shorter than 32 bytes is a misconfiguration, not a bad request.
  it('should answer server_error when the secret of the DPoP nonces is shorter than 32 bytes', async () => {
    const { exchangeCode } = await provider({ dpopNonceRequiredAtAuthorizationServer: true }, {}, 'a'.repeat(31));

    const response = await exchangeCode({ DPoP: await tokenProof(await dpopKey()) });

    expect([response.status, await response.json()]).toEqual([500, { error: 'server_error' }]);
  });
});
