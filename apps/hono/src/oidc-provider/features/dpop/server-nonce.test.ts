import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, providerContext, requestTo } from '../../../test-support/context.js';
import { dpopKey, dpopProof } from '../../../test-support/dpop.js';
import type { DpopNonceServer } from './nonce.js';
import { authorizationServerNonceOf, provideDpopNonce, requireDpopNonce, resourceServerNonceOf } from './server-nonce.js';

/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW = 1_767_225_600;
/** The secret of the DPoP nonces of the tests (41 bytes). */
const NONCE_SECRET = 'dpop-nonce-secret-for-the-unit-tests-0001';
/** The random bytes 0x00 to 0x0b. */
const RANDOM = Uint8Array.from({ length: 12 }, (_, index) => index);

// The nonces below were computed apart from the code under test, with the HMAC
// of node:crypto and NONCE_SECRET, for the issuer https://op.example.com
// (TEST_ISSUER) and RANDOM (see nonce.test.ts).

/** The nonce the authorization server issues at NOW. */
const AUTHORIZATION_SERVER_NONCE_AT_NOW = 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qlRn_qjLCd4ScDSkutyR475dsXalwZpCxni6jPVshAI';
/** The nonce the authorization server issues 60 seconds before NOW. */
const AUTHORIZATION_SERVER_NONCE_A_MINUTE_AGO = 'AAAAAGlVuMQAAQIDBAUGBwgJCgs.z9HATkyo3RHRNhIFpb-38WNlO3824W5yAE6LTLDJu8Y';
/** The nonce the resource server issues at NOW. */
const RESOURCE_SERVER_NONCE_AT_NOW = 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qMJbK4hF-YMMuV93-YOisKgT890kG1mcLWrlBS0Hgvc';
/** The nonce the resource server issues 60 seconds before NOW. */
const RESOURCE_SERVER_NONCE_A_MINUTE_AGO = 'AAAAAGlVuMQAAQIDBAUGBwgJCgs.nqqlWQTffRmDCkTSydKKh-0jY-TTN63lEhXSRrjSmCU';

const TOKEN_URI = `${TEST_ISSUER}/token`;
const STALE_AT_AUTHORIZATION_SERVER = 'The DPoP proof nonce is not a nonce the authorization server recently provided';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Makes crypto.getRandomValues() fill its array with RANDOM. */
function fixRandomBytes(): void {
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    (array as Uint8Array).set(RANDOM);
    return array;
  });
}

/** A proof for the token endpoint, signed by a new key, with the claims of overrides (a nonce, or none). */
async function tokenProof(overrides: Record<string, unknown> = {}): Promise<string> {
  return dpopProof(await dpopKey(), { htm: 'POST', htu: TOKEN_URI }, overrides);
}

/** The context of a POST to the token endpoint with the headers, with the secret of the DPoP nonces and the settings of config. */
async function contextWith(headers: Record<string, string>, config: Record<string, unknown> = {}, secret = NONCE_SECRET) {
  const { c } = await providerContext({ request: requestTo('/token', { method: 'POST', headers }), options: { dpopNonceSecret: secret, config } });
  return c;
}

/** The context of a GET of the UserInfo endpoint with a token in the DPoP scheme, with the secret of the DPoP nonces. */
async function userInfoContextWith(secret = NONCE_SECRET) {
  const { c } = await providerContext({
    request: requestTo('/userinfo', { headers: { Authorization: 'DPoP token-1' } }),
    options: { dpopNonceSecret: secret },
  });
  return c;
}

/** The DPoP-Nonce header of the response the context answers with. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dpopNonceOf(c: any): string | null {
  return c.text('').headers.get('DPoP-Nonce');
}

describe('authorizationServerNonceOf', () => {
  // RFC 9449 §8: the authorization server requires its nonce only where the settings say so.
  it('should name the authorization server when the settings require its nonce', () => {
    expect(authorizationServerNonceOf({ dpopNonceRequiredAtAuthorizationServer: true })).toBe('authorization-server');
  });

  // RFC 9449 §11.3: a server that provides no nonce requires none.
  it('should name no server when the settings require no nonce', () => {
    expect(authorizationServerNonceOf({ dpopNonceRequiredAtAuthorizationServer: false })).toBeUndefined();
  });
});

describe('resourceServerNonceOf', () => {
  // RFC 9449 §9: the protected resource requires its nonce only where the settings say so.
  it('should name the resource server when the settings require its nonce', () => {
    expect(resourceServerNonceOf({ dpopNonceRequiredAtResourceServer: true })).toBe('resource-server');
  });

  // RFC 9449 §11.3: a server that provides no nonce requires none.
  it('should name no server when the settings require no nonce', () => {
    expect(resourceServerNonceOf({ dpopNonceRequiredAtResourceServer: false })).toBeUndefined();
  });
});

describe('provideDpopNonce', () => {
  // RFC 9449 §8.2 / §9: the server supplies the nonce to use next in the DPoP-Nonce header of the response.
  it.each([
    ['resource-server', RESOURCE_SERVER_NONCE_AT_NOW],
    ['authorization-server', AUTHORIZATION_SERVER_NONCE_AT_NOW],
  ] as const)('should give the response the nonce the %s issues now', async (server: DpopNonceServer, nonceNow) => {
    const c = await userInfoContextWith();
    fixRandomBytes();

    await provideDpopNonce(c, server);

    expect(dpopNonceOf(c)).toBe(nonceNow);
  });

  // RFC 9449 §8: there MUST NOT be more than one DPoP-Nonce header.
  it('should leave one DPoP-Nonce header, the last nonce it gave, when it gives a nonce twice', async () => {
    const c = await userInfoContextWith();
    fixRandomBytes();
    vi.setSystemTime((NOW - 60) * 1000);
    await provideDpopNonce(c, 'resource-server');
    vi.setSystemTime(NOW * 1000);

    await provideDpopNonce(c, 'resource-server');

    expect(dpopNonceOf(c)).toBe(RESOURCE_SERVER_NONCE_AT_NOW);
  });

  // RFC 2104 §3: a secret shorter than the output of the hash is a misconfiguration.
  it('should throw an Error for a secret of the options shorter than 32 bytes, and give no nonce', async () => {
    const c = await userInfoContextWith('a'.repeat(31));

    await expect(provideDpopNonce(c, 'resource-server')).rejects.toThrow('The secret of the DPoP nonces must be at least 32 bytes long');
    expect(dpopNonceOf(c)).toBeNull();
  });
});

describe('requireDpopNonce', () => {
  // RFC 9449 §8 / §8.2: the server provides the nonce to use next, and accepts one it recently provided.
  it.each([
    ['authorization-server', AUTHORIZATION_SERVER_NONCE_A_MINUTE_AGO, AUTHORIZATION_SERVER_NONCE_AT_NOW],
    ['resource-server', RESOURCE_SERVER_NONCE_A_MINUTE_AGO, RESOURCE_SERVER_NONCE_AT_NOW],
  ] as const)(
    'should accept a proof with a nonce the %s issued a minute ago, and give the response the nonce it issues now',
    async (server: DpopNonceServer, recentNonce, nonceNow) => {
      const c = await contextWith({ DPoP: await tokenProof({ nonce: recentNonce }) });
      fixRandomBytes();

      await expect(requireDpopNonce(c, server)).resolves.toBeUndefined();
      expect(dpopNonceOf(c)).toBe(nonceNow);
    },
  );

  // RFC 9449 §8 Figure 20 / §11.3: a proof without a nonce is rejected, and the response tells the nonce to use.
  it('should ask for a nonce when the proof has none, and still give the response the nonce to use', async () => {
    const c = await contextWith({ DPoP: await tokenProof() });
    fixRandomBytes();

    await expect(requireDpopNonce(c, 'authorization-server')).rejects.toMatchObject({
      error: 'use_dpop_nonce',
      errorDescription: 'Authorization server requires nonce in DPoP proof',
    });
    expect(dpopNonceOf(c)).toBe(AUTHORIZATION_SERVER_NONCE_AT_NOW);
  });

  // RFC 9449 §8: the server keeps a window of recent nonces, dpopNonceLifetimeSeconds long.
  it.each([
    ['accept', 60, undefined],
    ['reject', 59, STALE_AT_AUTHORIZATION_SERVER],
  ])('should %s a nonce issued 60 seconds ago when dpopNonceLifetimeSeconds is %i', async (_outcome, lifetime, rejection) => {
    const c = await contextWith({ DPoP: await tokenProof({ nonce: AUTHORIZATION_SERVER_NONCE_A_MINUTE_AGO }) }, { dpopNonceLifetimeSeconds: lifetime });

    const outcome = await requireDpopNonce(c, 'authorization-server').then(
      () => undefined,
      (error: { errorDescription: string }) => error.errorDescription,
    );

    expect(outcome).toBe(rejection);
  });

  // RFC 9449 §9: the nonces of the authorization server and of the resource server are not the same.
  it('should reject the nonce of the resource server at the authorization server', async () => {
    const c = await contextWith({ DPoP: await tokenProof({ nonce: RESOURCE_SERVER_NONCE_AT_NOW }) });

    await expect(requireDpopNonce(c, 'authorization-server')).rejects.toMatchObject({
      error: 'use_dpop_nonce',
      errorDescription: STALE_AT_AUTHORIZATION_SERVER,
    });
  });

  it('should reject a nonce made with another secret than the one of the options', async () => {
    const c = await contextWith({ DPoP: await tokenProof({ nonce: AUTHORIZATION_SERVER_NONCE_AT_NOW }) }, {}, 'another-dpop-nonce-secret-of-the-tests');

    await expect(requireDpopNonce(c, 'authorization-server')).rejects.toMatchObject({
      error: 'use_dpop_nonce',
      errorDescription: STALE_AT_AUTHORIZATION_SERVER,
    });
  });

  // A request that does not use DPoP is given no nonce and asked for none.
  it('should do nothing for a request without a DPoP header', async () => {
    const c = await contextWith({});

    await expect(requireDpopNonce(c, 'authorization-server')).resolves.toBeUndefined();
    expect(dpopNonceOf(c)).toBeNull();
  });

  // RFC 9449 §4.3: not more than one DPoP header.
  it('should reject two DPoP headers without giving a nonce', async () => {
    const c = await contextWith({ DPoP: `${await tokenProof()}, ${await tokenProof()}` });

    await expect(requireDpopNonce(c, 'authorization-server')).rejects.toMatchObject({
      error: 'invalid_dpop_proof',
      errorDescription: 'More than one DPoP header is not allowed',
    });
    expect(dpopNonceOf(c)).toBeNull();
  });

  // RFC 9449 §4.3: the nonce is read from a proof that is a single well-formed JWT.
  it('should reject a DPoP header that is not a JWT, and give the response the nonce to use', async () => {
    const c = await contextWith({ DPoP: 'not-a-jwt' });
    fixRandomBytes();

    await expect(requireDpopNonce(c, 'authorization-server')).rejects.toMatchObject({
      error: 'invalid_dpop_proof',
      errorDescription: 'The DPoP proof is not a JWS in the compact serialization',
    });
    expect(dpopNonceOf(c)).toBe(AUTHORIZATION_SERVER_NONCE_AT_NOW);
  });

  // RFC 2104 §3: a secret shorter than the output of the hash is a misconfiguration.
  it('should throw an Error for a secret of the options shorter than 32 bytes', async () => {
    const c = await contextWith({ DPoP: await tokenProof() }, {}, 'a'.repeat(31));

    await expect(requireDpopNonce(c, 'authorization-server')).rejects.toThrow('The secret of the DPoP nonces must be at least 32 bytes long');
  });
});
