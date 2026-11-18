import type { AuthorizationCodeData, TokenClientInfo } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER } from '../../../../test-support/context';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop';
import { decodeJwt } from '../../../../test-support/jwt';
import { POST as introspect } from '../../../(introspection)/introspect/route';
import { POST as token } from '../../../token/route';
import type { RegisteredClient } from '../../config';
import { createDatabase, registerClient } from '../../db';
import { clientResolver, config, stores } from '../../provider';
import { verifyDpopTokenRequest } from './token';

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) for the whole file, so every test
// registers a client, a code and a refresh token of its own.

/** 2026-01-01T00:00:00Z in Unix seconds: every test runs on this clock. */
const NOW = 1767225600;
const TOKEN_ENDPOINT = `${TEST_ISSUER}/token`;
const REDIRECT_URI = 'https://rp.example.com/callback';
const CLIENT_SECRET = 'dpop-client-secret-value';
// RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge.
const CODE_VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CODE_CHALLENGE = 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU';
const defaultDpopAlgs = config.dpopSigningAlgValuesSupported;

interface TokenBody {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  config.dpopSigningAlgValuesSupported = defaultDpopAlgs;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

let sequence = 0;

/** A value of its own for each use, so the tests of the file do not share records. */
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

/**
 * A client of its own (confidential with client_secret_basic, or public), with
 * an authorization code and an offline refresh token stored for it, both
 * bound to boundKey when given; and the requests to the token endpoint.
 */
async function provider(options: { publicClient?: boolean; scope?: string[]; boundKey?: DpopKey } = {}) {
  const { publicClient = false, scope, boundKey } = options;
  const clientId = unique('dpop-client');
  const code = unique('dpop-code');
  const refreshToken = unique('dpop-refresh');
  await registerClient(createDatabase(), {
    clientId,
    redirectUris: [REDIRECT_URI],
    grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
    ...(publicClient
      ? { tokenEndpointAuthMethods: ['none'] }
      : { clientSecret: CLIENT_SECRET, tokenEndpointAuthMethods: ['client_secret_basic'] }),
    ...(scope === undefined ? {} : { scope }),
  });
  const cnf = boundKey === undefined ? {} : { cnf: { jkt: boundKey.jkt } };
  const storedCode: AuthorizationCodeData = {
    code,
    grantId: unique('grant'),
    clientId,
    redirectUri: REDIRECT_URI,
    redirectUriExplicit: true,
    scope: ['openid', 'offline_access'],
    subject: 'dpop-user',
    used: false,
    expiresAt: NOW + 300,
    authTime: NOW - 600,
    nonce: 'nonce-1',
    codeChallenge: CODE_CHALLENGE,
    codeChallengeMethod: 'S256',
  };
  await stores.authCodeStore.set(code, { ...storedCode, ...cnf });
  await stores.refreshTokenStore.set(refreshToken, {
    subject: 'dpop-user',
    clientId,
    scope: ['openid', 'offline_access'],
    expiresAt: NOW + 86400,
    originalIssuedAt: NOW - 3600,
    used: false,
    grantId: unique('grant'),
    iat: NOW - 3600,
    issuer: TEST_ISSUER,
    audience: [`${TEST_ISSUER}/userinfo`],
    authTime: NOW - 3600,
    ...cnf,
  });
  const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    token(
      new Request(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(publicClient ? {} : { Authorization: basicAuthorization(clientId, CLIENT_SECRET) }),
          ...headers,
        },
        body: new URLSearchParams({ ...(publicClient ? { client_id: clientId } : {}), ...fields }).toString(),
      }),
    );
  const exchangeCode = (headers: Record<string, string> = {}) =>
    post({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER }, headers);
  const refresh = (headers: Record<string, string> = {}) => post({ grant_type: 'refresh_token', refresh_token: refreshToken }, headers);
  return { clientId, code, refreshToken, post, exchangeCode, refresh };
}

async function tokenProof(key: DpopKey, overrides: Record<string, unknown> = {}): Promise<string> {
  return dpopProof(key, { htm: 'POST', htu: TOKEN_ENDPOINT }, overrides);
}

describe('verifyDpopTokenRequest', () => {
  // RFC 9449 §5 / §6.1: a token request with a DPoP proof gets a DPoP token bound to the key.
  it('should issue a DPoP access token whose cnf.jkt is the thumbprint of the proof key', async () => {
    const key = await dpopKey();
    const { exchangeCode } = await provider();

    const response = await exchangeCode({ DPoP: await tokenProof(key) });
    const body = (await response.json()) as TokenBody;

    expect(response.status).toBe(200);
    expect(body.token_type).toBe('DPoP');
    expect(decodeJwt(body.access_token).payload.cnf).toEqual({ jkt: key.jkt });
    expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({ cnf: { jkt: key.jkt }, tokenType: 'DPoP' });
  });

  it('should keep issuing Bearer tokens to a request without a DPoP proof', async () => {
    const { exchangeCode } = await provider();

    const body = (await (await exchangeCode()).json()) as TokenBody;

    expect(body.token_type).toBe('Bearer');
    expect(decodeJwt(body.access_token).payload.cnf).toBeUndefined();
    expect(await stores.accessTokenStore.get(body.access_token)).not.toHaveProperty('cnf');
  });

  // RFC 9449 §5: a confidential client's refresh token is not bound; a public client's is.
  it('should leave the refresh token of a confidential client unbound', async () => {
    const key = await dpopKey();
    const { exchangeCode } = await provider();

    const body = (await (await exchangeCode({ DPoP: await tokenProof(key) })).json()) as TokenBody;

    expect(await stores.refreshTokenStore.get(body.refresh_token as string)).not.toHaveProperty('cnf');
  });

  it('should bind the refresh token of a public client to the proof key', async () => {
    const key = await dpopKey();
    const { exchangeCode } = await provider({ publicClient: true });

    const body = (await (await exchangeCode({ DPoP: await tokenProof(key) })).json()) as TokenBody;

    expect(body.token_type).toBe('DPoP');
    expect(await stores.refreshTokenStore.get(body.refresh_token as string)).toMatchObject({ cnf: { jkt: key.jkt } });
  });

  // RFC 9449 §5: every grant of the token endpoint, the ones a feature answers included.
  it('should bind the access token of the client_credentials grant', async () => {
    const key = await dpopKey();
    const { post } = await provider({ scope: ['api:read'] });

    const response = await post({ grant_type: 'client_credentials', scope: 'api:read' }, { DPoP: await tokenProof(key) });
    const body = (await response.json()) as TokenBody;

    expect(response.status).toBe(200);
    expect(body.token_type).toBe('DPoP');
    expect(decodeJwt(body.access_token).payload.cnf).toEqual({ jkt: key.jkt });
    expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({ cnf: { jkt: key.jkt }, tokenType: 'DPoP' });
  });

  // RFC 9449 §5.2: dpop_bound_access_tokens makes the proof mandatory.
  it('should reject a request without a proof from a client that registered dpop_bound_access_tokens', async () => {
    const { clientId, exchangeCode } = await provider();
    const findClient = clientResolver.findClient.bind(clientResolver);
    vi.spyOn(clientResolver, 'findClient').mockImplementation(async (id: string) => {
      const client = await findClient(id);
      return client !== null && id === clientId ? { ...client, dpopBoundAccessTokens: true } : client;
    });

    const response = await exchangeCode();

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({
      error: 'invalid_dpop_proof',
      error_description: 'This client must send a DPoP proof with every token request',
    });
  });

  it('should let a client that registered dpop_bound_access_tokens through with a proof', async () => {
    const key = await dpopKey();
    const client = { clientId: 'bound-client', dpopBoundAccessTokens: true } as RegisteredClient;

    const decided = await verifyDpopTokenRequest(new Request(TOKEN_ENDPOINT, { method: 'POST', headers: { DPoP: await tokenProof(key) } }), client);

    expect(decided).toEqual({
      dpopJkt: key.jkt,
      tokenBinding: { cnf: { jkt: key.jkt }, tokenType: 'DPoP' },
    });
  });

  it('should decide no binding for a request without a DPoP header', async () => {
    const client: TokenClientInfo = { clientId: 'plain-client', tokenEndpointAuthMethods: ['none'] };

    expect(await verifyDpopTokenRequest(new Request(TOKEN_ENDPOINT, { method: 'POST' }), client)).toEqual({
      dpopJkt: undefined,
      tokenBinding: undefined,
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
    const { exchangeCode } = await provider();
    config.dpopSigningAlgValuesSupported = ['PS256'];

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
    const { clientId, post, code } = await provider();

    const response = await post(
      { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER },
      { DPoP: await tokenProof(key, { htu: 'https://evil.example/token' }), Authorization: basicAuthorization(clientId, 'wrong') },
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as TokenBody).error).toBe('invalid_client');
  });
});

describe('validateDpopGrantBinding', () => {
  // RFC 9449 §10: a code bound with dpop_jkt is exchanged only with a proof of that key.
  describe('authorization code bound to a key', () => {
    it('should exchange the code with a proof of the key', async () => {
      const key = await dpopKey();
      const { exchangeCode } = await provider({ publicClient: true, boundKey: key });

      const response = await exchangeCode({ DPoP: await tokenProof(key) });

      expect(response.status).toBe(200);
      expect(((await response.json()) as TokenBody).token_type).toBe('DPoP');
    });

    it.each([
      ['without a proof', false, 'The grant is bound to a DPoP key, but no DPoP proof was sent'],
      ['with a proof of another key', true, 'The DPoP proof key does not match the key the grant is bound to'],
    ])('should reject the exchange %s, and leave the code unused', async (_name, withOtherKey, description) => {
      const key = await dpopKey();
      const { code, exchangeCode } = await provider({ publicClient: true, boundKey: key });

      const response = await exchangeCode(withOtherKey ? { DPoP: await tokenProof(await dpopKey()) } : {});

      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: description });
      expect((await stores.authCodeStore.get(code))?.used).toBe(false);
    });

    it('should leave a used code to the grant validation, which detects the replay', async () => {
      const key = await dpopKey();
      const { code, exchangeCode } = await provider({ publicClient: true, boundKey: key });
      await exchangeCode({ DPoP: await tokenProof(key) });

      const response = await exchangeCode({ DPoP: await tokenProof(await dpopKey()) });

      expect(response.status).toBe(400);
      expect(((await response.json()) as TokenBody).error_description).not.toContain('DPoP');
      expect((await stores.authCodeStore.get(code))?.used).toBe(true);
    });
  });

  // RFC 9449 §5: a public client's bound refresh token needs a proof of the same key.
  describe('refresh token bound to a key', () => {
    it('should refresh with a proof of the key, and bind the rotated refresh token to it', async () => {
      const key = await dpopKey();
      const { refresh } = await provider({ publicClient: true, boundKey: key });

      const response = await refresh({ DPoP: await tokenProof(key) });
      const body = (await response.json()) as TokenBody;

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expect(await stores.refreshTokenStore.get(body.refresh_token as string)).toMatchObject({ cnf: { jkt: key.jkt } });
    });

    it.each([
      ['without a proof', false],
      ['with a proof of another key', true],
    ])('should reject the refresh %s', async (_name, withOtherKey) => {
      const key = await dpopKey();
      const { refreshToken, refresh } = await provider({ publicClient: true, boundKey: key });

      const response = await refresh(withOtherKey ? { DPoP: await tokenProof(await dpopKey()) } : {});

      expect(response.status).toBe(400);
      expect(((await response.json()) as TokenBody).error).toBe('invalid_grant');
      expect((await stores.refreshTokenStore.get(refreshToken))?.used).toBe(false);
    });

    it('should let an unbound refresh token be used without a proof', async () => {
      const { refresh } = await provider({ publicClient: true });

      const response = await refresh();

      expect(response.status).toBe(200);
      expect(((await response.json()) as TokenBody).token_type).toBe('Bearer');
    });
  });
});

// RFC 9449 §6.2: introspection reports the key a token is bound to.
describe('introspection of a DPoP-bound access token', () => {
  async function introspectToken(clientId: string, accessToken: string): Promise<Record<string, unknown>> {
    const response = await introspect(
      new Request(`${TEST_ISSUER}/introspect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: basicAuthorization(clientId, CLIENT_SECRET),
        },
        body: new URLSearchParams({ token: accessToken }).toString(),
      }),
    );
    return (await response.json()) as Record<string, unknown>;
  }

  it('should report the cnf and the token_type DPoP of a bound access token', async () => {
    const key = await dpopKey();
    const { clientId, exchangeCode } = await provider();
    const body = (await (await exchangeCode({ DPoP: await tokenProof(key) })).json()) as TokenBody;

    const introspected = await introspectToken(clientId, body.access_token);

    expect(introspected).toMatchObject({ active: true, token_type: 'DPoP', cnf: { jkt: key.jkt } });
  });

  it('should report a Bearer access token without cnf', async () => {
    const { clientId, exchangeCode } = await provider();
    const body = (await (await exchangeCode()).json()) as TokenBody;

    const introspected = await introspectToken(clientId, body.access_token);

    expect(introspected).toMatchObject({ active: true, token_type: 'Bearer' });
    expect(introspected).not.toHaveProperty('cnf');
  });
});
