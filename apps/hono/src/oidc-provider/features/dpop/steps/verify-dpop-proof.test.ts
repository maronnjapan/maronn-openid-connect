import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER } from '../../../../test-support/context.js';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop.js';
import { rs256Key, staticKeyProvider } from '../../../../test-support/keys.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  NOW,
  REDIRECT_URI,
  basicAuthorization,
  confidentialClient,
  decodeJwt,
  storedAuthorizationCode,
} from '../../../../test-support/token.js';
import { createApp } from '../../../app.js';
import type { ClientRegistration } from '../../../config.js';
import { createClientKeyResolver, createClientResolver, registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { createProviderStores } from '../../../db/memory/stores.js';

const TOKEN_ENDPOINT = `${TEST_ISSUER}/token`;
// RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge.
const CODE_VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CODE_CHALLENGE = 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU';

interface TokenBody {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/** The provider on an in-memory database, with client-1 registered and code-1 stored for it. */
async function provider(client: Partial<ClientRegistration> = {}, config: Record<string, unknown> = {}) {
  const db = createEmptyDatabase();
  const stores = createProviderStores(db);
  await registerClient(db, confidentialClient({ grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'], ...client }));
  await stores.authCodeStore.set(
    'code-1',
    storedAuthorizationCode({ scope: ['openid', 'offline_access'], codeChallenge: CODE_CHALLENGE, codeChallengeMethod: 'S256' }),
  );
  const app = createApp({
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: stores,
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    config: { issuer: TEST_ISSUER, ...config },
  });
  const isPublic = client.tokenEndpointAuthMethods?.includes('none') ?? false;
  const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    app.request(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(isPublic ? {} : { Authorization: basicAuthorization(CLIENT_ID, CLIENT_SECRET) }),
        ...headers,
      },
      body: new URLSearchParams({ ...(isPublic ? { client_id: CLIENT_ID } : {}), ...fields }).toString(),
    });
  const exchangeCode = (headers: Record<string, string> = {}) =>
    post({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER }, headers);
  return { app, stores, post, exchangeCode };
}

async function tokenProof(key: DpopKey, overrides: Record<string, unknown> = {}): Promise<string> {
  return dpopProof(key, { htm: 'POST', htu: TOKEN_ENDPOINT }, overrides);
}

describe('verifyDpopTokenRequest', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // RFC 9449 §5 / §6.1: a token request with a DPoP proof gets a DPoP token bound to the key.
  it('should issue a DPoP access token whose cnf.jkt is the thumbprint of the proof key', async () => {
    const key = await dpopKey();
    const { stores, exchangeCode } = await provider();

    const response = await exchangeCode({ DPoP: await tokenProof(key) });
    const body = (await response.json()) as TokenBody;

    expect(response.status).toBe(200);
    expect(body.token_type).toBe('DPoP');
    expect(decodeJwt(body.access_token).payload.cnf).toEqual({ jkt: key.jkt });
    expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({ cnf: { jkt: key.jkt }, tokenType: 'DPoP' });
  });

  it('should keep issuing Bearer tokens to a request without a DPoP proof', async () => {
    const { stores, exchangeCode } = await provider();

    const body = (await (await exchangeCode()).json()) as TokenBody;

    expect(body.token_type).toBe('Bearer');
    expect(decodeJwt(body.access_token).payload.cnf).toBeUndefined();
    expect(await stores.accessTokenStore.get(body.access_token)).not.toHaveProperty('cnf');
  });

  it('should bind an opaque access token through its stored record', async () => {
    const key = await dpopKey();
    const { stores, exchangeCode } = await provider({}, { accessTokenFormat: 'opaque' });

    const body = (await (await exchangeCode({ DPoP: await tokenProof(key) })).json()) as TokenBody;

    expect(body.token_type).toBe('DPoP');
    expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({ cnf: { jkt: key.jkt }, tokenType: 'DPoP' });
  });

  // RFC 9449 §5: a confidential client's refresh token is not bound; a public client's is.
  it('should leave the refresh token of a confidential client unbound', async () => {
    const key = await dpopKey();
    const { stores, exchangeCode } = await provider();

    const body = (await (await exchangeCode({ DPoP: await tokenProof(key) })).json()) as TokenBody;

    expect(await stores.refreshTokenStore.get(body.refresh_token as string)).not.toHaveProperty('cnf');
  });

  it('should bind the refresh token of a public client to the proof key', async () => {
    const key = await dpopKey();
    const { stores, exchangeCode } = await provider({ clientSecret: undefined, tokenEndpointAuthMethods: ['none'] });

    const body = (await (await exchangeCode({ DPoP: await tokenProof(key) })).json()) as TokenBody;

    expect(body.token_type).toBe('DPoP');
    expect(await stores.refreshTokenStore.get(body.refresh_token as string)).toMatchObject({ cnf: { jkt: key.jkt } });
  });

  // RFC 9449 §5: every grant of the token endpoint, the ones a feature answers included.
  it('should bind the access token of the client_credentials grant', async () => {
    const key = await dpopKey();
    const { stores, post } = await provider({ scope: ['api:read'] });

    const response = await post({ grant_type: 'client_credentials', scope: 'api:read' }, { DPoP: await tokenProof(key) });
    const body = (await response.json()) as TokenBody;

    expect(response.status).toBe(200);
    expect(body.token_type).toBe('DPoP');
    expect(decodeJwt(body.access_token).payload.cnf).toEqual({ jkt: key.jkt });
    expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({ cnf: { jkt: key.jkt } });
  });

  // RFC 9449 §5.2: dpop_bound_access_tokens makes the proof mandatory.
  it('should reject a request without a proof from a client that registered dpop_bound_access_tokens', async () => {
    const { exchangeCode } = await provider({ dpopBoundAccessTokens: true });

    const response = await exchangeCode();

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'invalid_dpop_proof',
      error_description: 'This client must send a DPoP proof with every token request',
    });
  });

  it.each([
    ['for another endpoint', { htu: `${TEST_ISSUER}/userinfo` }, 'The DPoP proof htu claim does not match the request URI'],
    ['for another method', { htm: 'GET' }, 'The DPoP proof htm claim does not match the request method'],
    ['issued too long ago', { iat: NOW - 600 }, 'The DPoP proof iat claim is not within the acceptable window'],
    ['without a jti', { jti: undefined }, 'The DPoP proof has no jti claim'],
  ])('should reject a proof %s with invalid_dpop_proof', async (_name, overrides, description) => {
    const key = await dpopKey();
    const { exchangeCode } = await provider();

    const response = await exchangeCode({ DPoP: await tokenProof(key, overrides) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: description });
  });

  it('should reject a proof signed with an alg the OP does not list', async () => {
    const key = await dpopKey();
    const { exchangeCode } = await provider({}, { dpopSigningAlgValuesSupported: ['PS256'] });

    const response = await exchangeCode({ DPoP: await tokenProof(key) });

    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: 'The DPoP proof alg is not supported' });
  });

  // RFC 9449 §11.1: a proof is accepted once.
  it('should reject a proof sent again', async () => {
    const key = await dpopKey();
    const { post } = await provider({ scope: ['api:read'] });
    const proof = await tokenProof(key);
    await post({ grant_type: 'client_credentials', scope: 'api:read' }, { DPoP: proof });

    const response = await post({ grant_type: 'client_credentials', scope: 'api:read' }, { DPoP: proof });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: 'The DPoP proof has already been used' });
  });

  // RFC 9449 §4.3: not more than one DPoP header.
  it('should reject two DPoP headers', async () => {
    const key = await dpopKey();
    const { exchangeCode } = await provider();

    const response = await exchangeCode({ DPoP: `${await tokenProof(key)}, ${await tokenProof(key)}` });

    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: 'More than one DPoP header is not allowed' });
  });

  it('should let the client authentication fail before the proof is checked', async () => {
    const key = await dpopKey();
    const { post } = await provider();

    const response = await post(
      { grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER },
      { DPoP: await tokenProof(key, { htu: 'https://evil.example/token' }), Authorization: basicAuthorization(CLIENT_ID, 'wrong') },
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as TokenBody).error).toBe('invalid_client');
  });
});
