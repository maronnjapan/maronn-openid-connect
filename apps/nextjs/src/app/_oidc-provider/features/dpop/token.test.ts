import { createOpaqueAccessTokenIssuer, type AuthorizationCodeData } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { TEST_ISSUER } from '../../../../test-support/context';
import { createSqliteDatabase } from '../../../../test-support/databases';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop';
import { decodeJwt } from '../../../../test-support/jwt';
import { POST as register } from '../../../(dynamic-client-registration)/register/route';
import { POST as introspect } from '../../../(introspection)/introspect/route';
import { POST as token } from '../../../token/route';
import type { ClientRegistration } from '../../config';
import { createDatabase, registerClient } from '../../db';
import { createClientResolver as createSqlClientResolver, registerClient as registerSqlClient } from '../../db/sql/clients';
import { accessTokenIssuer, clientResolver, config, stores } from '../../provider';
import { dispatchCiba } from '../ciba/grant';
import { dispatchClientCredentials } from '../client-credentials/grant';
import { dispatchDeviceCode } from '../device-authorization-grant/grant';
import { dispatchIdJagIssuance, dispatchIdJagRedemption } from '../id-jag/grant';
import { dispatchTokenExchange } from '../token-exchange/grant';
import { validateDpopGrantBinding, verifyDpopTokenRequest } from './token';

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
 * A client of its own, confidential (client_secret_basic) unless publicClient
 * (none: it sends its client_id and no credential), registered with the
 * members of client added, with an authorization code and an offline refresh
 * token stored for it, both bound to boundKey when given; and the requests to
 * the token endpoint.
 */
async function provider(
  options: { publicClient?: boolean; scope?: string[]; boundKey?: DpopKey; client?: Partial<ClientRegistration> } = {},
) {
  const { publicClient = false, scope, boundKey, client } = options;
  const clientId = unique('dpop-client');
  const code = unique('dpop-code');
  const refreshToken = unique('dpop-refresh-token');
  await registerClient(createDatabase(), {
    clientId,
    redirectUris: [REDIRECT_URI],
    grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
    ...(publicClient
      ? { tokenEndpointAuthMethods: ['none'] }
      : { clientSecret: CLIENT_SECRET, tokenEndpointAuthMethods: ['client_secret_basic'] }),
    ...(scope === undefined ? {} : { scope }),
    ...client,
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
  // RFC 9449 §5 / §6.1: the access token of a request with a DPoP proof is bound to the key of the proof,
  // and so is the refresh token of a public client (RFC 9449 §5).
  // The authorization server of the examples is the provider of the file with its issuer set to server.example.com.
  describe('the token requests of RFC 9449', () => {
    // The code grants offline_access, so its token response carries a refresh token as Figure 6 does.
    it('should answer the authorization code request of Figure 5 with a DPoP access token and a refresh token bound to the key of Figure 9', async () => {
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
        scope: ['openid', 'offline_access'],
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
      expect(await stores.refreshTokenStore.get(body.refresh_token as string)).toMatchObject({ cnf: { jkt: RFC9449_JKT } });
    });

    // The refresh token is bound to the key of Figure 9, as the refresh token of Figure 6 is (issued to a public client that sent a proof).
    it('should answer the refresh request of Figure 7 with a DPoP access token and a rotated refresh token bound to the key of Figure 9', async () => {
      vi.setSystemTime(FIGURE_7_IAT * 1000);
      config.issuer = RFC9449_ISSUER;
      await registerClient(createDatabase(), {
        clientId: RFC9449_CLIENT_ID,
        redirectUris: [RFC9449_REDIRECT_URI],
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethods: ['none'],
      });
      const figure7RefreshToken = {
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
        cnf: { jkt: RFC9449_JKT },
      };
      await stores.refreshTokenStore.set('Q..Zkm29lexi8VnWg2zPW1x-tgGad0Ibc3s3EwM_Ni4-g', figure7RefreshToken);

      const response = await postToRfc9449Token(
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

  it('should decide no binding for a request without a DPoP header', async () => {
    const request = new Request(TOKEN_ENDPOINT, { method: 'POST' });

    expect(await verifyDpopTokenRequest(request, { clientId: 'dpop-public-client', tokenEndpointAuthMethods: ['none'] })).toEqual({
      dpopJkt: undefined,
      tokenBinding: undefined,
    });
  });

  it('should keep issuing Bearer tokens to a request without a DPoP proof', async () => {
    const { exchangeCode } = await provider();

    const body = (await (await exchangeCode()).json()) as TokenBody;

    expect(body.token_type).toBe('Bearer');
    expect(decodeJwt(body.access_token).payload).not.toHaveProperty('cnf');
    expect(await stores.accessTokenStore.get(body.access_token)).not.toHaveProperty('cnf');
    expect(await stores.accessTokenStore.get(body.access_token)).not.toHaveProperty('tokenType');
  });

  // provider.ts picks the issuer from config.accessTokenFormat when it loads, so the test swaps in the opaque one.
  it('should bind an opaque access token through its stored record', async () => {
    const issue = vi.spyOn(accessTokenIssuer, 'issue').mockImplementation(createOpaqueAccessTokenIssuer().issue);
    onTestFinished(() => issue.mockRestore());
    const key = await dpopKey();
    const { exchangeCode } = await provider();

    const body = (await (await exchangeCode({ DPoP: await tokenProof(key) })).json()) as TokenBody;

    expect(body.token_type).toBe('DPoP');
    expect(body.access_token.split('.')).toHaveLength(1);
    expect(await stores.accessTokenStore.get(body.access_token)).toMatchObject({ cnf: { jkt: key.jkt }, tokenType: 'DPoP' });
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

  // RFC 9449 §5: the device and CIBA grants bind the refresh token they issue to a public client through refreshTokenCnf.
  it('should hand a public client the binding of its refresh token too', async () => {
    const key = await dpopKey();
    const { exchangeCode } = await provider({ publicClient: true });

    await exchangeCode({ DPoP: await tokenProof(key) });

    const binding = { cnf: { jkt: key.jkt }, tokenType: 'DPoP', refreshTokenCnf: { jkt: key.jkt } };
    expect({
      deviceCode: vi.mocked(dispatchDeviceCode).mock.calls[0]?.[3],
      ciba: vi.mocked(dispatchCiba).mock.calls[0]?.[3],
    }).toEqual({ deviceCode: binding, ciba: binding });
  });

  // RFC 9449 §5.2: the authorization server MUST reject the token requests without a DPoP header of a client
  // registered with dpop_bound_access_tokens true.
  describe('a client registered with dpop_bound_access_tokens', () => {
    const BOUND_CLIENT_ERROR = {
      error: 'invalid_dpop_proof',
      error_description: 'This client must send a DPoP proof with every token request',
    };
    // A request of each grant from the client of provider(): its code, its refresh token, and the
    // client_credentials grant with a scope the client registers.
    const GRANT_REQUESTS: Array<[grant: string, scope: string[] | undefined, request: 'exchangeCode' | 'refresh' | 'clientCredentials']> = [
      ['authorization_code', undefined, 'exchangeCode'],
      ['refresh_token', undefined, 'refresh'],
      ['client_credentials', ['api:read'], 'clientCredentials'],
    ];

    /** The client of provider() registered with dpopBoundAccessTokens true, and its request of the grant. */
    async function boundClient(scope: string[] | undefined, request: 'exchangeCode' | 'refresh' | 'clientCredentials') {
      const fixture = await provider({ scope, client: { dpopBoundAccessTokens: true } });
      const send =
        request === 'clientCredentials'
          ? (headers: Record<string, string> = {}) => fixture.post({ grant_type: 'client_credentials', scope: 'api:read' }, headers)
          : fixture[request];
      return { ...fixture, send };
    }

    // The check runs before the block of any grant, so no grant block is called and nothing is spent.
    it.each(GRANT_REQUESTS)(
      'should reject a %s request without a DPoP proof before any grant block, and leave the code and the refresh token unused',
      async (_grant, scope, request) => {
        const { code, refreshToken, send } = await boundClient(scope, request);

        const response = await send();

        expect(response.status).toBe(400);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.json()).toEqual(BOUND_CLIENT_ERROR);
        expect(vi.mocked(dispatchClientCredentials)).not.toHaveBeenCalled();
        expect((await stores.authCodeStore.get(code))?.used).toBe(false);
        expect((await stores.refreshTokenStore.get(refreshToken))?.used).toBe(false);
      },
    );

    it.each(GRANT_REQUESTS)('should answer a %s request with a DPoP proof with a DPoP access token', async (_grant, scope, request) => {
      const key = await dpopKey();
      const { send } = await boundClient(scope, request);

      const response = await send({ DPoP: await tokenProof(key) });
      const body = (await response.json()) as TokenBody;

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expect(decodeJwt(body.access_token).payload.cnf).toEqual({ jkt: key.jkt });
    });

    // RFC 9449 §5.2: false is the same as omitted, so the client may also ask for Bearer tokens.
    it('should keep issuing Bearer tokens without a DPoP proof to a client registered with dpopBoundAccessTokens false', async () => {
      const { exchangeCode } = await provider({ client: { dpopBoundAccessTokens: false } });

      const response = await exchangeCode();

      expect(response.status).toBe(200);
      expect(((await response.json()) as TokenBody).token_type).toBe('Bearer');
    });

    // A dynamic registration keeps the metadata it registered in registrationMetadata, under its wire name.
    it('should reject a request without a DPoP proof from a client whose dynamic registration kept dpop_bound_access_tokens true', async () => {
      const { code, exchangeCode } = await provider({ client: { registrationMetadata: { dpop_bound_access_tokens: true } } });

      const response = await exchangeCode();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(BOUND_CLIENT_ERROR);
      expect((await stores.authCodeStore.get(code))?.used).toBe(false);
    });

    // With dynamic client registration, the dpop block of POST /register registers dpop_bound_access_tokens in
    // registrationMetadata, which the token route reads.
    it('should require a proof of a client registered through POST /register with dpop_bound_access_tokens true', async () => {
      const registration = await register(
        new Request(`${TEST_ISSUER}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: true }),
        }),
      );
      const registered = (await registration.json()) as { client_id: string; client_secret: string; dpop_bound_access_tokens?: unknown };
      const code = unique('dpop-code');
      const storedCode: AuthorizationCodeData = {
        code,
        grantId: unique('grant'),
        clientId: registered.client_id,
        redirectUri: REDIRECT_URI,
        redirectUriExplicit: true,
        scope: ['openid'],
        subject: 'dpop-user',
        used: false,
        expiresAt: NOW + 300,
        authTime: NOW - 600,
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: 'S256',
      };
      await stores.authCodeStore.set(code, storedCode);
      const post = (headers: Record<string, string> = {}) =>
        token(
          new Request(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: basicAuthorization(registered.client_id, registered.client_secret),
              ...headers,
            },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER }).toString(),
          }),
        );

      const withoutProof = await post();
      const withProof = await post({ DPoP: await tokenProof(await dpopKey()) });

      expect(registration.status).toBe(201);
      expect(registered.dpop_bound_access_tokens).toBe(true);
      expect(withoutProof.status).toBe(400);
      expect(await withoutProof.json()).toEqual(BOUND_CLIENT_ERROR);
      expect(withProof.status).toBe(200);
      expect(((await withProof.json()) as TokenBody).token_type).toBe('DPoP');
    });

    // The key-value database keeps the member, which has no field, in the payload of the client record
    // (db/kv/clients.ts). provider() registers its client in the key-value database of provider.ts.
    it('should keep dpopBoundAccessTokens of a client registered in the key-value database, and require a proof of the client', async () => {
      const { clientId, post } = await provider({ scope: ['api:read'], client: { dpopBoundAccessTokens: true } });

      const withoutProof = await post({ grant_type: 'client_credentials', scope: 'api:read' });
      const withProof = await post({ grant_type: 'client_credentials', scope: 'api:read' }, { DPoP: await tokenProof(await dpopKey()) });

      expect(JSON.parse((await createDatabase().get(`oidc:client:${clientId}`)) ?? 'null')).toMatchObject({
        payload: { dpopBoundAccessTokens: true },
      });
      expect(withoutProof.status).toBe(400);
      expect(await withoutProof.json()).toEqual(BOUND_CLIENT_ERROR);
      expect(withProof.status).toBe(200);
      expect(((await withProof.json()) as TokenBody).token_type).toBe('DPoP');
    });

    // The SQL database keeps the member, which has no column, in the payload of the client (db/sql/clients.ts).
    // provider.ts reads the key-value database, so the test points its client resolver at an SQL database.
    it('should keep dpopBoundAccessTokens of a client registered in the SQL database, and require a proof of the client', async () => {
      const sql = createSqliteDatabase();
      const clientId = unique('dpop-sql-client');
      await registerSqlClient(sql, {
        clientId,
        clientSecret: CLIENT_SECRET,
        redirectUris: [REDIRECT_URI],
        grantTypes: ['client_credentials'],
        tokenEndpointAuthMethods: ['client_secret_basic'],
        scope: ['api:read'],
        dpopBoundAccessTokens: true,
      });
      const findClient = vi.spyOn(clientResolver, 'findClient').mockImplementation(createSqlClientResolver(sql).findClient);
      onTestFinished(() => findClient.mockRestore());
      const post = (headers: Record<string, string> = {}) =>
        token(
          new Request(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: basicAuthorization(clientId, CLIENT_SECRET),
              ...headers,
            },
            body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'api:read' }).toString(),
          }),
        );

      const withoutProof = await post();
      const withProof = await post({ DPoP: await tokenProof(await dpopKey()) });

      expect(await sql.all({ sql: 'SELECT id, payload FROM clients', params: [] })).toEqual([
        { id: clientId, payload: '{"dpopBoundAccessTokens":true}' },
      ]);
      expect(withoutProof.status).toBe(400);
      expect(await withoutProof.json()).toEqual(BOUND_CLIENT_ERROR);
      expect(withProof.status).toBe(200);
      expect(((await withProof.json()) as TokenBody).token_type).toBe('DPoP');
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

  it('should reject a proof signed with an alg the OP does not list, and leave the code unused', async () => {
    const key = await dpopKey();
    const { code, exchangeCode } = await provider();
    config.dpopSigningAlgValuesSupported = ['PS256'];

    const response = await exchangeCode({ DPoP: await tokenProof(key) });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof', error_description: 'The DPoP proof alg is not supported' });
    expect((await stores.authCodeStore.get(code))?.used).toBe(false);
  });

  // The proof is checked before the refresh token is validated and rotated.
  it('should reject a bad proof of a refresh request, and leave the refresh token unused', async () => {
    const key = await dpopKey();
    const { refreshToken, refresh } = await provider();

    const response = await refresh({ DPoP: await tokenProof(key, { htm: 'GET' }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_dpop_proof',
      error_description: 'The DPoP proof htm claim does not match the request method',
    });
    expect((await stores.refreshTokenStore.get(refreshToken))?.used).toBe(false);
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
    const { clientId, post, code } = await provider();

    const response = await post(
      { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER },
      { DPoP: await tokenProof(key, { htu: 'https://evil.example/token' }), Authorization: basicAuthorization(clientId, 'wrong') },
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as TokenBody).error).toBe('invalid_client');
  });

  // Checking the proof after the client authentication keeps a request that fails it from spending the jti of a good proof.
  it('should remember no jti of a good proof sent with a request that fails client authentication', async () => {
    const key = await dpopKey();
    const { clientId, post, code, exchangeCode } = await provider();
    const proof = await tokenProof(key);
    const consume = vi.spyOn(stores.clientAssertionJtiStore, 'consume');
    onTestFinished(() => consume.mockRestore());

    const response = await post(
      { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER },
      { DPoP: proof, Authorization: basicAuthorization(clientId, 'wrong') },
    );

    expect(response.status).toBe(401);
    expect(consume).not.toHaveBeenCalled();
    expect(((await (await exchangeCode({ DPoP: proof })).json()) as TokenBody).token_type).toBe('DPoP');
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

describe('validateDpopGrantBinding', () => {
  it('should leave a bound code or refresh token sent with another grant unchecked', async () => {
    const key = await dpopKey();
    const { clientId, code, refreshToken } = await provider({ publicClient: true, boundKey: key });
    const params = { grant_type: 'client_credentials', code, refresh_token: refreshToken };

    expect(await validateDpopGrantBinding(params, clientId, undefined)).toBeUndefined();
  });

  // RFC 9449 §10: a code bound to a key is exchanged only with a proof of that key.
  describe('authorization code bound to a key', () => {
    it('should exchange the code with a proof of the key', async () => {
      const key = await dpopKey();
      const { code, exchangeCode } = await provider({ publicClient: true, boundKey: key });

      const response = await exchangeCode({ DPoP: await tokenProof(key) });

      expect(response.status).toBe(200);
      expect(((await response.json()) as TokenBody).token_type).toBe('DPoP');
      expect((await stores.authCodeStore.get(code))?.used).toBe(true);
    });

    it.each([
      ['without a proof', false, 'The grant is bound to a DPoP key, but no DPoP proof was sent'],
      ['with a proof of another key', true, 'The DPoP proof key does not match the key the grant is bound to'],
    ])('should reject the exchange %s with an uncacheable invalid_grant, and leave the code unused', async (_name, withOtherKey, description) => {
      const key = await dpopKey();
      const { code, exchangeCode } = await provider({ publicClient: true, boundKey: key });

      const response = await exchangeCode(withOtherKey ? { DPoP: await tokenProof(await dpopKey()) } : {});

      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: description });
      expect((await stores.authCodeStore.get(code))?.used).toBe(false);
    });

    // OAuth 2.1 §4.1.2: the grant validation revokes the tokens of a code presented again.
    it('should leave a used code to the grant validation, which rejects the replay', async () => {
      const key = await dpopKey();
      const { code, exchangeCode } = await provider({ publicClient: true, boundKey: key });
      await exchangeCode({ DPoP: await tokenProof(key) });

      const response = await exchangeCode({ DPoP: await tokenProof(await dpopKey()) });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: 'Authorization code has already been used' });
      expect((await stores.authCodeStore.get(code))?.used).toBe(true);
    });

    it('should leave a code of another client to the grant validation', async () => {
      const key = await dpopKey();
      const other = await provider({ publicClient: true, boundKey: key });
      const { post } = await provider({ publicClient: true });

      const response = await post({ grant_type: 'authorization_code', code: other.code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: 'Authorization code was issued to a different client' });
    });

    it('should let an unbound code be exchanged without a proof', async () => {
      const { exchangeCode } = await provider({ publicClient: true });

      const response = await exchangeCode();

      expect(response.status).toBe(200);
      expect(((await response.json()) as TokenBody).token_type).toBe('Bearer');
    });
  });

  // RFC 9449 §5: a public client's bound refresh token needs a proof of the same key.
  describe('refresh token bound to a key', () => {
    it('should refresh with a proof of the key, and bind the rotated refresh token to it', async () => {
      const key = await dpopKey();
      const { refreshToken, refresh } = await provider({ publicClient: true, boundKey: key });

      const response = await refresh({ DPoP: await tokenProof(key) });
      const body = (await response.json()) as TokenBody;

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expect(await stores.refreshTokenStore.get(body.refresh_token as string)).toMatchObject({ cnf: { jkt: key.jkt } });
      expect((await stores.refreshTokenStore.get(refreshToken))?.used).toBe(true);
    });

    it.each([
      ['without a proof', false, 'The grant is bound to a DPoP key, but no DPoP proof was sent'],
      ['with a proof of another key', true, 'The DPoP proof key does not match the key the grant is bound to'],
    ])('should reject the refresh %s with an uncacheable invalid_grant, and leave the refresh token unused', async (_name, withOtherKey, description) => {
      const key = await dpopKey();
      const { refreshToken, refresh } = await provider({ publicClient: true, boundKey: key });

      const response = await refresh(withOtherKey ? { DPoP: await tokenProof(await dpopKey()) } : {});

      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: description });
      expect((await stores.refreshTokenStore.get(refreshToken))?.used).toBe(false);
    });

    // OAuth 2.1 §4.3.1: the grant validation revokes the tokens of a rotated refresh token presented again.
    it('should leave a used refresh token to the grant validation, which rejects the replay and revokes the grant', async () => {
      const key = await dpopKey();
      const { refresh } = await provider({ publicClient: true, boundKey: key });
      const rotated = ((await (await refresh({ DPoP: await tokenProof(key) })).json()) as TokenBody).refresh_token as string;

      const response = await refresh();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: 'Refresh token has already been used' });
      expect(await stores.refreshTokenStore.get(rotated)).toBeUndefined();
    });

    it('should leave a refresh token of another client to the grant validation', async () => {
      const key = await dpopKey();
      const other = await provider({ publicClient: true, boundKey: key });
      const { post } = await provider({ publicClient: true });

      const response = await post({ grant_type: 'refresh_token', refresh_token: other.refreshToken });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: 'Refresh token was issued to a different client' });
    });

    it('should let an unbound refresh token be used without a proof, and keep the rotated one unbound', async () => {
      const { refresh } = await provider({ publicClient: true });

      const response = await refresh();
      const body = (await response.json()) as TokenBody;

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('Bearer');
      expect(await stores.refreshTokenStore.get(body.refresh_token as string)).not.toHaveProperty('cnf');
    });

    // RFC 9449 §5: a refresh token issued to a public client that presents a valid proof is bound to its key.
    it('should bind the refresh token that rotates an unbound one when the public client sends a proof', async () => {
      const key = await dpopKey();
      const { refresh } = await provider({ publicClient: true });

      const response = await refresh({ DPoP: await tokenProof(key) });
      const body = (await response.json()) as TokenBody;

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expect(await stores.refreshTokenStore.get(body.refresh_token as string)).toMatchObject({ cnf: { jkt: key.jkt } });
    });
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
