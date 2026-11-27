import type { AuthorizationCodeData } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER } from '../../../../test-support/context';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop';
import { decodeJwt } from '../../../../test-support/jwt';
import { POST as introspect } from '../../../(introspection)/introspect/route';
import { POST as token } from '../../../token/route';
import { createDatabase, registerClient } from '../../db';
import { config, stores } from '../../provider';
import { dispatchCiba } from '../ciba/grant';
import { dispatchClientCredentials } from '../client-credentials/grant';
import { dispatchDeviceCode } from '../device-authorization-grant/grant';
import { dispatchIdJagIssuance, dispatchIdJagRedemption } from '../id-jag/grant';
import { dispatchTokenExchange } from '../token-exchange/grant';
import { verifyDpopTokenRequest } from './token';

// The blocks of the grants a feature answers, as spies that run the block: the
// tests check what the token route hands them.
vi.mock('../client-credentials/grant', async (importOriginal) => {
  const original = await importOriginal<typeof import('../client-credentials/grant')>();
  return { ...original, dispatchClientCredentials: vi.fn(original.dispatchClientCredentials) };
});
vi.mock('../id-jag/grant', async (importOriginal) => {
  const original = await importOriginal<typeof import('../id-jag/grant')>();
  return {
    ...original,
    dispatchIdJagIssuance: vi.fn(original.dispatchIdJagIssuance),
    dispatchIdJagRedemption: vi.fn(original.dispatchIdJagRedemption),
  };
});
vi.mock('../token-exchange/grant', async (importOriginal) => {
  const original = await importOriginal<typeof import('../token-exchange/grant')>();
  return { ...original, dispatchTokenExchange: vi.fn(original.dispatchTokenExchange) };
});
vi.mock('../device-authorization-grant/grant', async (importOriginal) => {
  const original = await importOriginal<typeof import('../device-authorization-grant/grant')>();
  return { ...original, dispatchDeviceCode: vi.fn(original.dispatchDeviceCode) };
});
vi.mock('../ciba/grant', async (importOriginal) => {
  const original = await importOriginal<typeof import('../ciba/grant')>();
  return { ...original, dispatchCiba: vi.fn(original.dispatchCiba) };
});

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) for the whole file, so every test
// registers a client and a code of its own.

/** 2026-01-01T00:00:00Z in Unix seconds: the clock of the tests that do not replay RFC 9449. */
const NOW = 1767225600;
const TOKEN_ENDPOINT = `${TEST_ISSUER}/token`;
const REDIRECT_URI = 'https://rp.example.com/callback';
const CLIENT_SECRET = 'dpop-client-secret-value';
// RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge.
const CODE_VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CODE_CHALLENGE = 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU';

/** The authorization server of the examples of RFC 9449. */
const RFC9449_ISSUER = 'https://server.example.com';
/** The JWK Thumbprint of the key of the DPoP proofs of RFC 9449 §5, the cnf.jkt of RFC 9449 Figure 9. */
const RFC9449_JKT = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I';
/** The DPoP proof of the token request of RFC 9449 Figure 5 (the proof of Figure 2): ES256, htm POST, htu https://server.example.com/token. */
const FIGURE_5_PROOF =
  'eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19' +
  '.eyJqdGkiOiItQndDM0VTYzZhY2MybFRjIiwiaHRtIjoiUE9TVCIsImh0dSI6Imh0dHBzOi8vc2VydmVyLmV4YW1wbGUuY29tL3Rva2VuIiwiaWF0IjoxNTYyMjYyNjE2fQ' +
  '.2-GxA6T8lP4vfrg8v-FdWP0A0zdrj8igiMLvqRMUvwnQg4PtFLbdLXiOSsX0x7NVY-FNyJK70nfbV37xRZT3Lg';
/** The iat of FIGURE_5_PROOF. */
const FIGURE_5_IAT = 1_562_262_616;
/** The DPoP proof of the refresh request of RFC 9449 Figure 7: the same key, issued later. */
const FIGURE_7_PROOF =
  'eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19' +
  '.eyJqdGkiOiItQndDM0VTYzZhY2MybFRjIiwiaHRtIjoiUE9TVCIsImh0dSI6Imh0dHBzOi8vc2VydmVyLmV4YW1wbGUuY29tL3Rva2VuIiwiaWF0IjoxNTYyMjY1Mjk2fQ' +
  '.pAqut2IRDm_De6PR93SYmGBPXpwrAk90e8cP2hjiaG5QsGSuKDYW7_X620BxqhvYC8ynrrvZLTk41mSRroapUA';
/** The iat of FIGURE_7_PROOF. */
const FIGURE_7_IAT = 1_562_265_296;
/** The public client of RFC 9449 Figures 5 and 7, which sends its client_id and no credential. */
const RFC9449_CLIENT_ID = 's6BhdRkqt';
const RFC9449_REDIRECT_URI = 'https://client.example.com/cb';
/** The code_verifier of RFC 9449 Figure 5 and its S256 code_challenge (RFC 7636 §4.2). */
const RFC9449_CODE_VERIFIER = 'bEaL42izcC-o-xBk0K2vuJ6U-y1p9r_wW2dFWIWgjz-';
const RFC9449_CODE_CHALLENGE = 'HtPJkE32DJkowXxFcEC5nnFXgv1Z97Cn_krX96qwH0E';

const SAVED_CONFIG = {
  issuer: config.issuer,
  dpopSigningAlgValuesSupported: config.dpopSigningAlgValuesSupported,
  dpopProofMaxAgeSeconds: config.dpopProofMaxAgeSeconds,
};

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
  Object.assign(config, SAVED_CONFIG);
  vi.clearAllMocks();
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
 * A confidential client of its own (client_secret_basic), with an
 * authorization code stored for it; and the requests to the token endpoint.
 */
async function provider(options: { scope?: string[] } = {}) {
  const clientId = unique('dpop-client');
  const code = unique('dpop-code');
  await registerClient(createDatabase(), {
    clientId,
    redirectUris: [REDIRECT_URI],
    grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
    clientSecret: CLIENT_SECRET,
    tokenEndpointAuthMethods: ['client_secret_basic'],
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });
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
  await stores.authCodeStore.set(code, storedCode);
  const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    token(
      new Request(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: basicAuthorization(clientId, CLIENT_SECRET),
          ...headers,
        },
        body: new URLSearchParams(fields).toString(),
      }),
    );
  const exchangeCode = (headers: Record<string, string> = {}) =>
    post({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER }, headers);
  return { clientId, code, post, exchangeCode };
}

/** A POST to the token endpoint of the examples of RFC 9449, from the public client s6BhdRkqt, with the DPoP proof. */
function postToRfc9449Token(fields: Record<string, string>, proof: string): Promise<Response> {
  return token(
    new Request(`${RFC9449_ISSUER}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: proof },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

async function tokenProof(key: DpopKey, overrides: Record<string, unknown> = {}): Promise<string> {
  return dpopProof(key, { htm: 'POST', htu: TOKEN_ENDPOINT }, overrides);
}

describe('verifyDpopTokenRequest', () => {
  // RFC 9449 §5 / §6.1: the access token of a request with a DPoP proof is bound to the key of the proof.
  // The authorization server of the examples is the provider of the file with its issuer set to server.example.com.
  describe('the token requests of RFC 9449', () => {
    it('should answer the authorization code request of Figure 5 with a DPoP access token whose cnf.jkt is that of Figure 9', async () => {
      vi.setSystemTime(FIGURE_5_IAT * 1000);
      config.issuer = RFC9449_ISSUER;
      await registerClient(createDatabase(), {
        clientId: RFC9449_CLIENT_ID,
        redirectUris: [RFC9449_REDIRECT_URI],
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethods: ['none'],
      });
      const figure5Code: AuthorizationCodeData = {
        code: 'SplxlOBeZQQYbYS6WxSbIA',
        grantId: unique('grant'),
        clientId: RFC9449_CLIENT_ID,
        redirectUri: RFC9449_REDIRECT_URI,
        redirectUriExplicit: true,
        scope: ['openid'],
        subject: 'dpop-user',
        used: false,
        expiresAt: FIGURE_5_IAT + 300,
        authTime: FIGURE_5_IAT - 60,
        codeChallenge: RFC9449_CODE_CHALLENGE,
        codeChallengeMethod: 'S256',
      };
      await stores.authCodeStore.set('SplxlOBeZQQYbYS6WxSbIA', figure5Code);

      const response = await postToRfc9449Token(
        {
          grant_type: 'authorization_code',
          client_id: RFC9449_CLIENT_ID,
          code: 'SplxlOBeZQQYbYS6WxSbIA',
          redirect_uri: RFC9449_REDIRECT_URI,
          code_verifier: RFC9449_CODE_VERIFIER,
        },
        FIGURE_5_PROOF,
      );
      const body = (await response.json()) as TokenBody;

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(body.token_type).toBe('DPoP');
      expect(decodeJwt(body.access_token).payload.cnf).toEqual({ jkt: RFC9449_JKT });
      expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({ cnf: { jkt: RFC9449_JKT }, tokenType: 'DPoP' });
    });

    it('should answer the refresh request of Figure 7 with a DPoP access token whose cnf.jkt is that of Figure 9', async () => {
      vi.setSystemTime(FIGURE_7_IAT * 1000);
      config.issuer = RFC9449_ISSUER;
      await registerClient(createDatabase(), {
        clientId: RFC9449_CLIENT_ID,
        redirectUris: [RFC9449_REDIRECT_URI],
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethods: ['none'],
      });
      await stores.refreshTokenStore.set('Q..Zkm29lexi8VnWg2zPW1x-tgGad0Ibc3s3EwM_Ni4-g', {
        subject: 'dpop-user',
        clientId: RFC9449_CLIENT_ID,
        scope: ['openid', 'offline_access'],
        expiresAt: FIGURE_7_IAT + 86400,
        originalIssuedAt: FIGURE_7_IAT - 3600,
        used: false,
        grantId: unique('grant'),
        iat: FIGURE_7_IAT - 3600,
        issuer: RFC9449_ISSUER,
        audience: [`${RFC9449_ISSUER}/userinfo`],
        authTime: FIGURE_7_IAT - 3600,
      });

      const response = await postToRfc9449Token(
        { grant_type: 'refresh_token', client_id: RFC9449_CLIENT_ID, refresh_token: 'Q..Zkm29lexi8VnWg2zPW1x-tgGad0Ibc3s3EwM_Ni4-g' },
        FIGURE_7_PROOF,
      );
      const body = (await response.json()) as TokenBody;

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expect(decodeJwt(body.access_token).payload.cnf).toEqual({ jkt: RFC9449_JKT });
      expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({ cnf: { jkt: RFC9449_JKT }, tokenType: 'DPoP' });
    });
  });

  it('should decide no binding for a request without a DPoP header', async () => {
    expect(await verifyDpopTokenRequest(new Request(TOKEN_ENDPOINT, { method: 'POST' }))).toEqual({ tokenBinding: undefined });
  });

  it('should keep issuing Bearer tokens to a request without a DPoP proof', async () => {
    const { exchangeCode } = await provider();

    const body = (await (await exchangeCode()).json()) as TokenBody;

    expect(body.token_type).toBe('Bearer');
    expect(decodeJwt(body.access_token).payload).not.toHaveProperty('cnf');
    expect(await stores.accessTokenStore.get(body.access_token)).not.toHaveProperty('cnf');
    expect(await stores.accessTokenStore.get(body.access_token)).not.toHaveProperty('tokenType');
  });

  // RFC 9449 §5: a confidential client's refresh token is sender-constrained by its client authentication.
  it('should leave the refresh token of a confidential client unbound', async () => {
    const key = await dpopKey();
    const { exchangeCode } = await provider();

    const body = (await (await exchangeCode({ DPoP: await tokenProof(key) })).json()) as TokenBody;

    expect(body.token_type).toBe('DPoP');
    expect(await stores.refreshTokenStore.get(body.refresh_token as string)).not.toHaveProperty('cnf');
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

  // The route runs every dispatch before validateGrantTypeSupported; each returns nothing for a grant it does not answer.
  it('should hand the binding to the block of every grant a feature answers, and none to the ID-JAG issuance', async () => {
    const key = await dpopKey();
    const { exchangeCode } = await provider();

    await exchangeCode({ DPoP: await tokenProof(key) });

    const binding = { cnf: { jkt: key.jkt }, tokenType: 'DPoP' };
    expect({
      clientCredentials: vi.mocked(dispatchClientCredentials).mock.calls[0]?.[3],
      idJagIssuance: vi.mocked(dispatchIdJagIssuance).mock.calls[0]?.length,
      idJagRedemption: vi.mocked(dispatchIdJagRedemption).mock.calls[0]?.[3],
      tokenExchange: vi.mocked(dispatchTokenExchange).mock.calls[0]?.[3],
      deviceCode: vi.mocked(dispatchDeviceCode).mock.calls[0]?.[3],
      ciba: vi.mocked(dispatchCiba).mock.calls[0]?.[3],
    }).toEqual({
      clientCredentials: binding,
      idJagIssuance: 3,
      idJagRedemption: binding,
      tokenExchange: binding,
      deviceCode: binding,
      ciba: binding,
    });
  });

  it.each([
    ['for another endpoint', { htu: `${TEST_ISSUER}/userinfo` }, 'The DPoP proof htu claim does not match the request URI'],
    ['for another method', { htm: 'GET' }, 'The DPoP proof htm claim does not match the request method'],
    ['issued too long ago', { iat: NOW - 600 }, 'The DPoP proof iat claim is not within the acceptable window'],
    ['without a jti', { jti: undefined }, 'The DPoP proof has no jti claim'],
  ])('should reject a proof %s with an uncacheable invalid_dpop_proof, and leave the code unused', async (_name, overrides, description) => {
    const key = await dpopKey();
    const { code, exchangeCode } = await provider();

    const response = await exchangeCode({ DPoP: await tokenProof(key, overrides) });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: description });
    expect((await stores.authCodeStore.get(code))?.used).toBe(false);
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

  it('should let the client authentication fail before the proof is checked, and remember no jti', async () => {
    const key = await dpopKey();
    const { clientId, post, code } = await provider();
    const consume = vi.spyOn(stores.clientAssertionJtiStore, 'consume');

    const response = await post(
      { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER },
      { DPoP: await tokenProof(key, { htu: 'https://evil.example/token' }), Authorization: basicAuthorization(clientId, 'wrong') },
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as TokenBody).error).toBe('invalid_client');
    expect(consume).not.toHaveBeenCalled();
    consume.mockRestore();
  });

  // A window that is not a non-negative finite number is a misconfiguration, not a bad proof.
  it('should answer server_error when the iat window of the DPoP settings is not a number', async () => {
    const key = await dpopKey();
    const { exchangeCode } = await provider();
    config.dpopProofMaxAgeSeconds = Number.NaN;

    const response = await exchangeCode({ DPoP: await tokenProof(key) });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});

// RFC 9449 §6.2: introspection reports the key the access token was bound to at the token endpoint.
describe('introspection of an access token bound at the token endpoint', () => {
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
