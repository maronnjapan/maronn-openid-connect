import { afterEach, describe, expect, it, vi } from 'vitest';

import { dpopNonceKeyOf, issueDpopNonce, verifyDpopNonce, type DpopNonceScope } from './nonce';

/** A secret of 41 bytes. */
const SECRET = 'dpop-nonce-secret-for-the-unit-tests-0001';
const NOW = 1_767_225_600;
const AUTHORIZATION_SERVER: DpopNonceScope = { server: 'authorization-server', issuer: 'https://op.example.com' };
const RESOURCE_SERVER: DpopNonceScope = { server: 'resource-server', issuer: 'https://op.example.com' };

/** The random bytes 0x00 to 0x0b. */
const RANDOM = Uint8Array.from({ length: 12 }, (_, index) => index);

// The nonces below were computed apart from the code under test, with the HMAC
// of node:crypto: base64url(payload) "." base64url(HMAC-SHA256(SECRET,
// "DPoP-Nonce" NUL server NUL issuer NUL payload)), where payload is the
// second of issue (8 bytes, big-endian) followed by RANDOM.

/** The nonce the authorization server of https://op.example.com issues at NOW with RANDOM. */
const AUTHORIZATION_SERVER_NONCE = 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qlRn_qjLCd4ScDSkutyR475dsXalwZpCxni6jPVshAI';
/** The nonce the resource server of https://op.example.com issues at NOW with RANDOM. */
const RESOURCE_SERVER_NONCE = 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qMJbK4hF-YMMuV93-YOisKgT890kG1mcLWrlBS0Hgvc';
/** The nonce the authorization server of https://other.example.com issues at NOW with RANDOM. */
const OTHER_ISSUER_NONCE = 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.cKMjE6P0wKB2txpdtYhv8i8d_gTNw_srMlvJ_Fzrxxw';

/** Makes crypto.getRandomValues() fill its array with RANDOM. */
function fixRandomBytes(): void {
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    (array as Uint8Array).set(RANDOM);
    return array;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dpopNonceKeyOf', () => {
  // importDpopNonceKey() is not exported: the tests of dpopNonceKeyOf() reach it.
  // @subject nextjs:app/_oidc-provider/features/dpop/nonce.ts#importDpopNonceKey
  it('should give the same key for the same secret', async () => {
    expect(await dpopNonceKeyOf(SECRET)).toBe(await dpopNonceKeyOf(SECRET));
  });

  // RFC 2104 §3: a key shorter than the output of the hash weakens the MAC.
  it('should reject a secret shorter than 32 bytes', async () => {
    await expect(dpopNonceKeyOf('a'.repeat(31))).rejects.toThrow('The secret of the DPoP nonces must be at least 32 bytes long');
  });

  it('should count the bytes of the UTF-8 of the secret, not its characters', async () => {
    await expect(dpopNonceKeyOf('あ'.repeat(11))).resolves.toBeDefined();
    await expect(dpopNonceKeyOf('a'.repeat(32))).resolves.toBeDefined();
  });

  it('should make one key for the process when no secret is set, which is not the key of a secret', async () => {
    const processKey = await dpopNonceKeyOf(undefined);

    expect(await dpopNonceKeyOf(undefined)).toBe(processKey);
    await expect(verifyDpopNonce(processKey, AUTHORIZATION_SERVER_NONCE, AUTHORIZATION_SERVER, { now: NOW, lifetimeSeconds: 120 })).resolves.toBe(
      false,
    );
  });

  // Next.js loads a module once per module layer, and again when the dev server
  // reloads it: every copy of the module uses the key the first one made.
  it('should give the key made without a secret to a copy of the module loaded again', async () => {
    const processKey = await dpopNonceKeyOf(undefined);
    vi.resetModules();

    const reloaded = await import('./nonce');

    expect(reloaded.dpopNonceKeyOf).not.toBe(dpopNonceKeyOf);
    expect(await reloaded.dpopNonceKeyOf(undefined)).toBe(processKey);
  });
});

describe('issueDpopNonce', () => {
  // RFC 9449 §8.1: the second of issue and the random bytes, then the MAC, both base64url.
  // macInputOf() is not exported: this test checks the MAC input it builds through the nonces.
  // @subject nextjs:app/_oidc-provider/features/dpop/nonce.ts#macInputOf
  it('should give the second of issue and the random bytes with the MAC of the server and the issuer', async () => {
    const key = await dpopNonceKeyOf(SECRET);
    fixRandomBytes();

    expect(await issueDpopNonce(key, AUTHORIZATION_SERVER, NOW)).toBe(AUTHORIZATION_SERVER_NONCE);
    expect(await issueDpopNonce(key, RESOURCE_SERVER, NOW)).toBe(RESOURCE_SERVER_NONCE);
  });

  // RFC 9449 §8: nonce values MUST be unpredictable.
  it('should give a new nonce each time', async () => {
    const key = await dpopNonceKeyOf(SECRET);

    const first = await issueDpopNonce(key, AUTHORIZATION_SERVER, NOW);
    const second = await issueDpopNonce(key, AUTHORIZATION_SERVER, NOW);

    expect(first).not.toBe(second);
    expect(first.slice(0, 10)).toBe(second.slice(0, 10));
  });

  // RFC 9449 §8.1: nonce = 1*NQCHAR.
  it('should give only NQCHAR characters', async () => {
    const nonce = await issueDpopNonce(await dpopNonceKeyOf(SECRET), AUTHORIZATION_SERVER, NOW);

    expect(nonce).toMatch(/^[A-Za-z0-9_-]{27}\.[A-Za-z0-9_-]{43}$/);
    expect(nonce).toMatch(/^[\x21\x23-\x5B\x5D-\x7E]+$/);
  });
});

describe('verifyDpopNonce', () => {
  // RFC 9449 §8: the server accepts the nonces it recently provided.
  it.each([NOW, NOW + 60, NOW + 120])('should accept the nonce of the server up to the end of its lifetime (now %i)', async (now) => {
    const key = await dpopNonceKeyOf(SECRET);

    await expect(verifyDpopNonce(key, AUTHORIZATION_SERVER_NONCE, AUTHORIZATION_SERVER, { now, lifetimeSeconds: 120 })).resolves.toBe(true);
  });

  it('should reject the nonce after its lifetime', async () => {
    const key = await dpopNonceKeyOf(SECRET);

    await expect(verifyDpopNonce(key, AUTHORIZATION_SERVER_NONCE, AUTHORIZATION_SERVER, { now: NOW + 121, lifetimeSeconds: 120 })).resolves.toBe(
      false,
    );
  });

  it('should accept a lifetime of 0 seconds in the second of issue only', async () => {
    const key = await dpopNonceKeyOf(SECRET);

    await expect(verifyDpopNonce(key, AUTHORIZATION_SERVER_NONCE, AUTHORIZATION_SERVER, { now: NOW, lifetimeSeconds: 0 })).resolves.toBe(true);
    await expect(verifyDpopNonce(key, AUTHORIZATION_SERVER_NONCE, AUTHORIZATION_SERVER, { now: NOW + 1, lifetimeSeconds: 0 })).resolves.toBe(false);
  });

  // Another instance with the same secret may issue a nonce by a clock a few seconds ahead.
  it('should accept a nonce issued up to 5 seconds in the future, and no later one', async () => {
    const key = await dpopNonceKeyOf(SECRET);

    await expect(verifyDpopNonce(key, AUTHORIZATION_SERVER_NONCE, AUTHORIZATION_SERVER, { now: NOW - 5, lifetimeSeconds: 120 })).resolves.toBe(true);
    await expect(verifyDpopNonce(key, AUTHORIZATION_SERVER_NONCE, AUTHORIZATION_SERVER, { now: NOW - 6, lifetimeSeconds: 120 })).resolves.toBe(
      false,
    );
  });

  // RFC 9449 §9: the nonces of the authorization server and of a resource server are different.
  it('should reject the nonce of the other server', async () => {
    const key = await dpopNonceKeyOf(SECRET);
    const policy = { now: NOW, lifetimeSeconds: 120 };

    await expect(verifyDpopNonce(key, RESOURCE_SERVER_NONCE, AUTHORIZATION_SERVER, policy)).resolves.toBe(false);
    await expect(verifyDpopNonce(key, AUTHORIZATION_SERVER_NONCE, RESOURCE_SERVER, policy)).resolves.toBe(false);
    await expect(verifyDpopNonce(key, RESOURCE_SERVER_NONCE, RESOURCE_SERVER, policy)).resolves.toBe(true);
  });

  // @subject nextjs:app/_oidc-provider/features/dpop/nonce.ts#macInputOf
  it('should reject the nonce of another issuer', async () => {
    const key = await dpopNonceKeyOf(SECRET);

    await expect(verifyDpopNonce(key, OTHER_ISSUER_NONCE, AUTHORIZATION_SERVER, { now: NOW, lifetimeSeconds: 120 })).resolves.toBe(false);
  });

  it('should reject a nonce of another secret', async () => {
    const key = await dpopNonceKeyOf('another-dpop-nonce-secret-of-the-tests');

    await expect(verifyDpopNonce(key, AUTHORIZATION_SERVER_NONCE, AUTHORIZATION_SERVER, { now: NOW, lifetimeSeconds: 120 })).resolves.toBe(false);
  });

  it.each([
    ['an empty value', ''],
    ['a value without the MAC', 'AAAAAGlVuQAAAQIDBAUGBwgJCgs'],
    ['a value of three segments', `${AUTHORIZATION_SERVER_NONCE}.AAAA`],
    ['the payload of another second with the MAC of NOW', 'AAAAAGlVuQEAAQIDBAUGBwgJCgs.qlRn_qjLCd4ScDSkutyR475dsXalwZpCxni6jPVshAI'],
    ['a MAC changed in its last character', 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qlRn_qjLCd4ScDSkutyR475dsXalwZpCxni6jPVshAJ'],
    ['a payload of 19 bytes', 'AAAAAGlVuQAAAQIDBAUGBwgJCg.qlRn_qjLCd4ScDSkutyR475dsXalwZpCxni6jPVshAI'],
    ['a MAC of 31 bytes', 'AAAAAGlVuQAAAQIDBAUGBwgJCgs.qlRn_qjLCd4ScDSkutyR475dsXalwZpCxni6jPVshA'],
    ['a payload with padding', 'AAAAAGlVuQAAAQIDBAUGBwgJCgs=.qlRn_qjLCd4ScDSkutyR475dsXalwZpCxni6jPVshAI'],
  ])('should reject %s', async (_name, nonce) => {
    const key = await dpopNonceKeyOf(SECRET);

    await expect(verifyDpopNonce(key, nonce, AUTHORIZATION_SERVER, { now: NOW, lifetimeSeconds: 120 })).resolves.toBe(false);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, undefined as unknown as number])(
    'should throw when the lifetime is not a non-negative finite number (%s)',
    async (lifetimeSeconds) => {
      const key = await dpopNonceKeyOf(SECRET);

      await expect(verifyDpopNonce(key, AUTHORIZATION_SERVER_NONCE, AUTHORIZATION_SERVER, { now: NOW, lifetimeSeconds })).rejects.toThrow(
        'The lifetime of the DPoP nonces (dpopNonceLifetimeSeconds) must be a non-negative finite number',
      );
    },
  );
});
