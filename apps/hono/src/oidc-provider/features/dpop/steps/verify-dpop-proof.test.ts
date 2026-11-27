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
  storedRefreshToken,
} from '../../../../test-support/token.js';
import { createApp } from '../../../app.js';
import type { ClientRegistration } from '../../../config.js';
import { createClientKeyResolver, createClientResolver, registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { createProviderStores } from '../../../db/memory/stores.js';
import { redeemCibaRequest } from '../../ciba/steps/dispatch-ciba.js';
import { issueClientCredentialsToken } from '../../client-credentials/steps/dispatch-client-credentials.js';
import { redeemDeviceCode } from '../../device-authorization-grant/steps/dispatch-device-code.js';
import { issueIdJag } from '../../id-jag/steps/dispatch-id-jag-issuance.js';
import { redeemIdJag } from '../../id-jag/steps/dispatch-id-jag-redemption.js';
import { exchangeToken } from '../../token-exchange/steps/dispatch-token-exchange.js';

// The steps of the grants a feature answers, as spies that run the step: the
// tests check what the token pipeline hands them.
vi.mock('../../client-credentials/steps/dispatch-client-credentials.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../client-credentials/steps/dispatch-client-credentials.js')>();
  return { ...original, issueClientCredentialsToken: vi.fn(original.issueClientCredentialsToken) };
});
vi.mock('../../id-jag/steps/dispatch-id-jag-issuance.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../id-jag/steps/dispatch-id-jag-issuance.js')>();
  return { ...original, issueIdJag: vi.fn(original.issueIdJag) };
});
vi.mock('../../id-jag/steps/dispatch-id-jag-redemption.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../id-jag/steps/dispatch-id-jag-redemption.js')>();
  return { ...original, redeemIdJag: vi.fn(original.redeemIdJag) };
});
vi.mock('../../token-exchange/steps/dispatch-token-exchange.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../token-exchange/steps/dispatch-token-exchange.js')>();
  return { ...original, exchangeToken: vi.fn(original.exchangeToken) };
});
vi.mock('../../device-authorization-grant/steps/dispatch-device-code.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../device-authorization-grant/steps/dispatch-device-code.js')>();
  return { ...original, redeemDeviceCode: vi.fn(original.redeemDeviceCode) };
});
vi.mock('../../ciba/steps/dispatch-ciba.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../ciba/steps/dispatch-ciba.js')>();
  return { ...original, redeemCibaRequest: vi.fn(original.redeemCibaRequest) };
});

const TOKEN_ENDPOINT = `${TEST_ISSUER}/token`;
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

interface TokenBody {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/** The provider on an in-memory database, with the confidential client-1 registered and code-1 stored for it. */
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
  const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    app.request(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthorization(CLIENT_ID, CLIENT_SECRET),
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    });
  const exchangeCode = (headers: Record<string, string> = {}) =>
    post({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER }, headers);
  return { app, db, stores, post, exchangeCode };
}

/**
 * The authorization server of the examples of RFC 9449, on an in-memory
 * database: the public client s6BhdRkqt, and the authorization code of
 * Figure 5 and the refresh token of Figure 7 stored for it. The code grants
 * offline_access, so its token response carries a refresh token as Figure 6
 * does; the refresh token is bound to the key of Figure 9, as the refresh
 * token of Figure 6 is (RFC 9449 §5: it was issued to a public client that
 * sent a proof).
 */
async function rfc9449Provider() {
  const db = createEmptyDatabase();
  const stores = createProviderStores(db);
  await registerClient(db, {
    clientId: RFC9449_CLIENT_ID,
    redirectUris: [RFC9449_REDIRECT_URI],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethods: ['none'],
  });
  await stores.authCodeStore.set(
    'SplxlOBeZQQYbYS6WxSbIA',
    storedAuthorizationCode({
      code: 'SplxlOBeZQQYbYS6WxSbIA',
      clientId: RFC9449_CLIENT_ID,
      redirectUri: RFC9449_REDIRECT_URI,
      scope: ['openid', 'offline_access'],
      expiresAt: FIGURE_5_IAT + 300,
      authTime: FIGURE_5_IAT - 60,
      codeChallenge: RFC9449_CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
    }),
  );
  const figure7RefreshToken = {
    ...storedRefreshToken({
      clientId: RFC9449_CLIENT_ID,
      scope: ['openid', 'offline_access'],
      expiresAt: FIGURE_7_IAT + 86400,
      originalIssuedAt: FIGURE_7_IAT - 3600,
      iat: FIGURE_7_IAT - 3600,
      issuer: RFC9449_ISSUER,
      audience: [`${RFC9449_ISSUER}/userinfo`],
      authTime: FIGURE_7_IAT - 3600,
    }),
    cnf: { jkt: RFC9449_JKT },
  };
  await stores.refreshTokenStore.set('Q..Zkm29lexi8VnWg2zPW1x-tgGad0Ibc3s3EwM_Ni4-g', figure7RefreshToken);
  const app = createApp({
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: stores,
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    config: { issuer: RFC9449_ISSUER },
  });
  const post = (fields: Record<string, string>, proof: string) =>
    app.request(`${RFC9449_ISSUER}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: proof },
      body: new URLSearchParams(fields).toString(),
    });
  return { stores, post };
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
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // RFC 9449 §5 / §6.1: the access token of a request with a DPoP proof is bound to the key of the proof,
  // and so is the refresh token of a public client (RFC 9449 §5).
  describe('the token requests of RFC 9449', () => {
    it('should answer the authorization code request of Figure 5 with a DPoP access token and a refresh token bound to the key of Figure 9', async () => {
      vi.setSystemTime(FIGURE_5_IAT * 1000);
      const { stores, post } = await rfc9449Provider();

      const response = await post(
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
      expect(await stores.refreshTokenStore.get(body.refresh_token as string)).toMatchObject({ cnf: { jkt: RFC9449_JKT } });
    });

    it('should answer the refresh request of Figure 7 with a DPoP access token and a rotated refresh token bound to the key of Figure 9', async () => {
      vi.setSystemTime(FIGURE_7_IAT * 1000);
      const { stores, post } = await rfc9449Provider();

      const response = await post(
        { grant_type: 'refresh_token', client_id: RFC9449_CLIENT_ID, refresh_token: 'Q..Zkm29lexi8VnWg2zPW1x-tgGad0Ibc3s3EwM_Ni4-g' },
        FIGURE_7_PROOF,
      );
      const body = (await response.json()) as TokenBody;

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expect(decodeJwt(body.access_token).payload.cnf).toEqual({ jkt: RFC9449_JKT });
      expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({ cnf: { jkt: RFC9449_JKT }, tokenType: 'DPoP' });
      expect(await stores.refreshTokenStore.get(body.refresh_token as string)).toMatchObject({ cnf: { jkt: RFC9449_JKT } });
    });
  });

  it('should keep issuing Bearer tokens to a request without a DPoP proof', async () => {
    const { stores, exchangeCode } = await provider();

    const body = (await (await exchangeCode()).json()) as TokenBody;

    expect(body.token_type).toBe('Bearer');
    expect(decodeJwt(body.access_token).payload).not.toHaveProperty('cnf');
    expect(await stores.accessTokenStore.get(body.access_token)).not.toHaveProperty('cnf');
    expect(await stores.accessTokenStore.get(body.access_token)).not.toHaveProperty('tokenType');
  });

  it('should bind an opaque access token through its stored record', async () => {
    const key = await dpopKey();
    const { stores, exchangeCode } = await provider({}, { accessTokenFormat: 'opaque' });

    const body = (await (await exchangeCode({ DPoP: await tokenProof(key) })).json()) as TokenBody;

    expect(body.token_type).toBe('DPoP');
    expect(body.access_token.split('.')).toHaveLength(1);
    expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({ cnf: { jkt: key.jkt }, tokenType: 'DPoP' });
  });

  // RFC 9449 §5: a confidential client's refresh token is sender-constrained by its client authentication.
  it('should leave the refresh token of a confidential client unbound', async () => {
    const key = await dpopKey();
    const { stores, exchangeCode } = await provider();

    const body = (await (await exchangeCode({ DPoP: await tokenProof(key) })).json()) as TokenBody;

    expect(body.token_type).toBe('DPoP');
    expect(await stores.refreshTokenStore.get(body.refresh_token as string)).not.toHaveProperty('cnf');
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
    expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({ cnf: { jkt: key.jkt }, tokenType: 'DPoP' });
  });

  // The pipeline runs every dispatch before validate-grant-type; each returns nothing for a grant it does not answer.
  it('should hand the binding to the step of every grant a feature answers, and none to the ID-JAG issuance', async () => {
    const key = await dpopKey();
    const { exchangeCode } = await provider();

    await exchangeCode({ DPoP: await tokenProof(key) });

    const binding = { cnf: { jkt: key.jkt }, tokenType: 'DPoP' };
    expect({
      clientCredentials: vi.mocked(issueClientCredentialsToken).mock.calls[0]?.[3],
      idJagIssuance: vi.mocked(issueIdJag).mock.calls[0]?.length,
      idJagRedemption: vi.mocked(redeemIdJag).mock.calls[0]?.[3],
      tokenExchange: vi.mocked(exchangeToken).mock.calls[0]?.[3],
      deviceCode: vi.mocked(redeemDeviceCode).mock.calls[0]?.[4],
      ciba: vi.mocked(redeemCibaRequest).mock.calls[0]?.[4],
    }).toEqual({
      clientCredentials: binding,
      idJagIssuance: 3,
      idJagRedemption: binding,
      tokenExchange: binding,
      deviceCode: binding,
      ciba: binding,
    });
  });

  // RFC 9449 §5: the device and CIBA grants bind the refresh token they issue to a public client through refreshTokenCnf.
  it('should hand a public client the binding of its refresh token too', async () => {
    vi.setSystemTime(FIGURE_5_IAT * 1000);
    const { post } = await rfc9449Provider();

    await post(
      {
        grant_type: 'authorization_code',
        client_id: RFC9449_CLIENT_ID,
        code: 'SplxlOBeZQQYbYS6WxSbIA',
        redirect_uri: RFC9449_REDIRECT_URI,
        code_verifier: RFC9449_CODE_VERIFIER,
      },
      FIGURE_5_PROOF,
    );

    const binding = { cnf: { jkt: RFC9449_JKT }, tokenType: 'DPoP', refreshTokenCnf: { jkt: RFC9449_JKT } };
    expect({
      deviceCode: vi.mocked(redeemDeviceCode).mock.calls[0]?.[4],
      ciba: vi.mocked(redeemCibaRequest).mock.calls[0]?.[4],
    }).toEqual({ deviceCode: binding, ciba: binding });
  });

  it.each([
    ['for another endpoint', { htu: `${TEST_ISSUER}/userinfo` }, 'The DPoP proof htu claim does not match the request URI'],
    ['for another method', { htm: 'GET' }, 'The DPoP proof htm claim does not match the request method'],
    ['issued too long ago', { iat: NOW - 600 }, 'The DPoP proof iat claim is not within the acceptable window'],
    ['without a jti', { jti: undefined }, 'The DPoP proof has no jti claim'],
  ])('should reject a proof %s with an uncacheable invalid_dpop_proof, and leave the code unused', async (_name, overrides, description) => {
    const key = await dpopKey();
    const { stores, exchangeCode } = await provider();

    const response = await exchangeCode({ DPoP: await tokenProof(key, overrides) });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: description });
    expect((await stores.authCodeStore.get('code-1'))?.used).toBe(false);
  });

  it('should reject a proof signed with an alg the OP does not list, and leave the code unused', async () => {
    const key = await dpopKey();
    const { stores, exchangeCode } = await provider({}, { dpopSigningAlgValuesSupported: ['PS256'] });

    const response = await exchangeCode({ DPoP: await tokenProof(key) });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: 'The DPoP proof alg is not supported' });
    expect((await stores.authCodeStore.get('code-1'))?.used).toBe(false);
  });

  // The proof is checked before the refresh token is validated and rotated.
  it('should reject a bad proof of a refresh request, and leave the refresh token unused', async () => {
    const key = await dpopKey();
    const { stores, post } = await provider();
    await stores.refreshTokenStore.set('rt-1', storedRefreshToken());

    const response = await post({ grant_type: 'refresh_token', refresh_token: 'rt-1' }, { DPoP: await tokenProof(key, { htm: 'GET' }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_dpop_proof',
      error_description: 'The DPoP proof htm claim does not match the request method',
    });
    expect((await stores.refreshTokenStore.get('rt-1'))?.used).toBe(false);
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

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: 'More than one DPoP header is not allowed' });
  });

  it('should answer a failed client authentication before it checks the proof', async () => {
    const key = await dpopKey();
    const { post } = await provider();

    const response = await post(
      { grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER },
      { DPoP: await tokenProof(key, { htu: 'https://evil.example/token' }), Authorization: basicAuthorization(CLIENT_ID, 'wrong') },
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as TokenBody).error).toBe('invalid_client');
  });

  // Checking the proof after the client authentication keeps a request that fails it from spending the jti of a good proof.
  it('should remember no jti of a good proof sent with a request that fails client authentication', async () => {
    const key = await dpopKey();
    const { db, post, exchangeCode } = await provider();
    const proof = await tokenProof(key);

    const response = await post(
      { grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER },
      { DPoP: proof, Authorization: basicAuthorization(CLIENT_ID, 'wrong') },
    );

    expect(response.status).toBe(401);
    expect(db.clientAssertionJtis.size).toBe(0);
    expect(((await (await exchangeCode({ DPoP: proof })).json()) as TokenBody).token_type).toBe('DPoP');
  });

  // A window that is not a non-negative finite number is a misconfiguration, not a bad proof.
  it('should answer server_error when the iat window of the DPoP settings is not a number', async () => {
    const key = await dpopKey();
    const { exchangeCode } = await provider({}, { dpopProofMaxAgeSeconds: Number.NaN });

    const response = await exchangeCode({ DPoP: await tokenProof(key) });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});

// RFC 9449 §6.2: introspection reports the key the access token was bound to at the token endpoint.
describe('introspection of an access token bound at the token endpoint', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function introspectToken(app: Awaited<ReturnType<typeof provider>>['app'], accessToken: string): Promise<Record<string, unknown>> {
    const response = await app.request(`${TEST_ISSUER}/introspect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthorization(CLIENT_ID, CLIENT_SECRET),
      },
      body: new URLSearchParams({ token: accessToken }).toString(),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  it('should report the cnf and the token_type DPoP of a bound access token', async () => {
    const key = await dpopKey();
    const { app, exchangeCode } = await provider();
    const body = (await (await exchangeCode({ DPoP: await tokenProof(key) })).json()) as TokenBody;

    const introspected = await introspectToken(app, body.access_token);

    expect(introspected).toMatchObject({ active: true, token_type: 'DPoP', cnf: { jkt: key.jkt } });
  });

  it('should report a Bearer access token without cnf', async () => {
    const { app, exchangeCode } = await provider();
    const body = (await (await exchangeCode()).json()) as TokenBody;

    const introspected = await introspectToken(app, body.access_token);

    expect(introspected).toMatchObject({ active: true, token_type: 'Bearer' });
    expect(introspected).not.toHaveProperty('cnf');
  });
});
