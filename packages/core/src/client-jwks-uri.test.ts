/**
 * クライアントの jwks_uri（RFC 7591 §2）から鍵を得る部品のテスト。
 *
 * fetch と現在時刻は注入したスタブを使い、外部への通信と時間の経過に依存しない。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ClientJwksUriError,
  createClientJwksUriCache,
  DEFAULT_CLIENT_JWKS_URI_OPTIONS,
  fetchClientJwkSet,
  isClientJwksUriError,
  parseClientJwkSet,
  resolveClientJwksTtlSeconds,
  validateClientJwksUri,
  withClientJwksUriKeys,
  type ClientJwksUriLoadOptions,
} from './client-jwks-uri.js';
import type { ClientKeyResolver } from './client-keys.js';
import type { Jwk, JwkSet } from './jwks.js';

const JWKS_URI = 'https://rp.example.com/jwks.json';

let rsaN: string;
let shortRsaN: string;
let p256: { x: string; y: string };
let p384: { x: string; y: string };

beforeAll(async () => {
  const rsa = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  rsaN = (await crypto.subtle.exportKey('jwk', rsa.publicKey)).n!;
  const shortRsa = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  shortRsaN = (await crypto.subtle.exportKey('jwk', shortRsa.publicKey)).n!;
  const ec256 = await crypto.subtle.exportKey(
    'jwk',
    (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])).publicKey,
  );
  p256 = { x: ec256.x!, y: ec256.y! };
  const ec384 = await crypto.subtle.exportKey(
    'jwk',
    (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'])).publicKey,
  );
  p384 = { x: ec384.x!, y: ec384.y! };
});

function rsaKey(members: Record<string, unknown> = {}): Record<string, unknown> {
  return { kty: 'RSA', n: rsaN, e: 'AQAB', ...members };
}

function ecKey(members: Record<string, unknown> = {}): Record<string, unknown> {
  return { kty: 'EC', crv: 'P-256', ...p256, ...members };
}

/** The JWK parseClientJwkSet() makes of rsaKey({ kid }). */
function normalizedRsaKey(kid: string): Jwk {
  return { kty: 'RSA', kid, use: 'sig', alg: 'RS256', n: rsaN, e: 'AQAB' };
}

function jwkSetResponse(keys: unknown[], headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ keys }), { status: 200, headers });
}

/** A fetch that answers every call with a new response from respond. */
function stubFetch(respond: () => Response | Promise<Response>) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond());
}

describe('isClientJwksUriError', () => {
  it('should recognize a ClientJwksUriError', () => {
    expect(isClientJwksUriError(new ClientJwksUriError('the jwks_uri answered HTTP 404'))).toBe(true);
  });

  // A framework that loads core twice (Next.js bundles instrumentation.ts apart
  // from the Route Handlers) makes another copy of the class, which instanceof
  // does not recognize.
  it('should recognize the ClientJwksUriError of another copy of core by its name', () => {
    const copy = Object.assign(new Error('the jwks_uri answered HTTP 404'), { name: 'ClientJwksUriError' });

    expect(isClientJwksUriError(copy)).toBe(true);
  });

  it.each([[new Error('fetch failed')], [new TypeError('boom')], ['ClientJwksUriError'], [{ name: 'ClientJwksUriError' }], [null]])(
    'should not recognize %j',
    (value) => {
      expect(isClientJwksUriError(value)).toBe(false);
    },
  );
});

describe('DEFAULT_CLIENT_JWKS_URI_OPTIONS', () => {
  it('should hold the defaults of the jwks_uri retrieval', () => {
    expect(DEFAULT_CLIENT_JWKS_URI_OPTIONS).toEqual({
      timeoutMs: 3000,
      maxBytes: 65536,
      maxKeys: 32,
      ttlSeconds: 300,
      minTtlSeconds: 30,
      maxTtlSeconds: 300,
      refetchIntervalSeconds: 30,
      maxEntries: 1000,
    });
  });
});

describe('validateClientJwksUri', () => {
  describe('syntax', () => {
    it('should return an absolute https URI', () => {
      expect(validateClientJwksUri(JWKS_URI)).toBe(JWKS_URI);
    });

    it('should accept a port and a query', () => {
      expect(validateClientJwksUri('https://rp.example.com:8443/keys?tenant=a')).toBe(
        'https://rp.example.com:8443/keys?tenant=a',
      );
    });

    // UC-11 / D-9: https is required.
    it('should reject an http URI', () => {
      expect(() => validateClientJwksUri('http://rp.example.com/jwks')).toThrow(
        new ClientJwksUriError('jwks_uri must use https'),
      );
    });

    it.each(['ftp://rp.example.com/jwks', 'file:///etc/jwks.json', 'javascript:alert(1)'])(
      'should reject the scheme of %s',
      (uri) => {
        expect(() => validateClientJwksUri(uri)).toThrow(new ClientJwksUriError('jwks_uri must use https'));
      },
    );

    it('should reject a relative URI', () => {
      expect(() => validateClientJwksUri('/jwks.json')).toThrow(
        new ClientJwksUriError('jwks_uri must be an absolute URI'),
      );
    });

    it.each(['https://rp.example.com/jwks#key', 'https://rp.example.com/jwks#'])(
      'should reject the fragment of %s',
      (uri) => {
        expect(() => validateClientJwksUri(uri)).toThrow(
          new ClientJwksUriError('jwks_uri must not contain a fragment'),
        );
      },
    );

    it.each(['https://user:secret@rp.example.com/jwks', 'https://@rp.example.com/jwks'])(
      'should reject the userinfo of %s',
      (uri) => {
        expect(() => validateClientJwksUri(uri)).toThrow(
          new ClientJwksUriError('jwks_uri must not contain userinfo'),
        );
      },
    );

    it('should reject a URI longer than 2048 characters', () => {
      const uri = `https://rp.example.com/${'a'.repeat(2048)}`;

      expect(() => validateClientJwksUri(uri)).toThrow(
        new ClientJwksUriError('jwks_uri must be at most 2048 characters'),
      );
    });

    it.each([' https://rp.example.com/jwks', 'https://rp.example.com/jw\tks', 'https://rp.example.com/jwks\n'])(
      'should reject the whitespace or control characters of %j',
      (uri) => {
        expect(() => validateClientJwksUri(uri)).toThrow(
          new ClientJwksUriError('jwks_uri must not contain whitespace or control characters'),
        );
      },
    );

    it('should reject a value that is not a string', () => {
      expect(() => validateClientJwksUri(42 as unknown as string)).toThrow(
        new ClientJwksUriError('jwks_uri must be an absolute URI'),
      );
    });
  });

  // D-9 / RFC 8725 §3.10: the OP does not fetch loopback, private or link-local addresses.
  describe('destination', () => {
    it.each([
      'https://127.0.0.1/jwks',
      'https://127.1.2.3/jwks',
      'https://10.0.0.1/jwks',
      'https://172.16.0.1/jwks',
      'https://172.31.255.255/jwks',
      'https://192.168.1.1/jwks',
      'https://169.254.169.254/latest/meta-data',
      'https://0.0.0.0/jwks',
      'https://[::1]/jwks',
      'https://[::]/jwks',
      'https://[fd00::1]/jwks',
      'https://[fc00::1]/jwks',
      'https://[fe80::1]/jwks',
      'https://[::ffff:127.0.0.1]/jwks',
      'https://[::ffff:8.8.8.8]/jwks',
    ])('should reject the address literal of %s', (uri) => {
      expect(() => validateClientJwksUri(uri)).toThrow(
        new ClientJwksUriError('jwks_uri must not point to a loopback, private or link-local address'),
      );
    });

    // The WHATWG URL parser turns these into 127.0.0.1 before the check sees the host.
    it.each(['https://0x7f.1/jwks', 'https://2130706433/jwks', 'https://0177.0.0.1/jwks'])(
      'should reject %s, a loopback address in another notation',
      (uri) => {
        expect(() => validateClientJwksUri(uri)).toThrow(
          new ClientJwksUriError('jwks_uri must not point to a loopback, private or link-local address'),
        );
      },
    );

    it.each(['https://localhost/jwks', 'https://LOCALHOST./jwks', 'https://keys.localhost/jwks'])(
      'should reject the localhost name of %s',
      (uri) => {
        expect(() => validateClientJwksUri(uri)).toThrow(
          new ClientJwksUriError('jwks_uri must not point to a loopback, private or link-local address'),
        );
      },
    );

    it.each(['https://8.8.8.8/jwks', 'https://172.32.0.1/jwks', 'https://[2001:db8::1]/jwks'])(
      'should accept the public address literal of %s',
      (uri) => {
        expect(validateClientJwksUri(uri)).toBe(uri);
      },
    );
  });

  // UC-7: allowInsecure is for development.
  describe('allowInsecure', () => {
    it.each(['http://127.0.0.1:3020/jwks.json', 'http://localhost:3020/jwks.json', 'https://10.0.0.5/jwks'])(
      'should accept %s',
      (uri) => {
        expect(validateClientJwksUri(uri, { allowInsecure: true })).toBe(uri);
      },
    );

    it('should still reject a fragment', () => {
      expect(() => validateClientJwksUri('http://127.0.0.1/jwks#k', { allowInsecure: true })).toThrow(
        new ClientJwksUriError('jwks_uri must not contain a fragment'),
      );
    });

    it('should still reject a scheme other than http and https', () => {
      expect(() => validateClientJwksUri('file:///etc/jwks.json', { allowInsecure: true })).toThrow(
        new ClientJwksUriError('jwks_uri must use http or https'),
      );
    });
  });
});

describe('parseClientJwkSet', () => {
  it('should keep the RSA and EC signing keys with the members it understands', () => {
    const jwks = parseClientJwkSet({
      keys: [
        rsaKey({ kid: 'rsa-1', use: 'sig', alg: 'RS256', x5c: ['MIIB...'], key_ops: ['verify'] }),
        ecKey({ kid: 'ec-1', alg: 'ES256', ext: true }),
      ],
    });

    expect(jwks).toEqual({
      keys: [
        { kty: 'RSA', kid: 'rsa-1', use: 'sig', alg: 'RS256', n: rsaN, e: 'AQAB' },
        { kty: 'EC', kid: 'ec-1', use: 'sig', alg: 'ES256', crv: 'P-256', x: p256.x, y: p256.y },
      ],
    });
  });

  // D-13 / RFC 8725 §3.1: use and alg are OPTIONAL (RFC 7517 §4.2 / §4.4); the
  // normalized key carries the one alg it may be used with.
  it('should add use sig and the alg of the key when the key has neither', () => {
    const jwks = parseClientJwkSet({
      keys: [rsaKey({ kid: 'rsa-1' }), { kty: 'EC', crv: 'P-384', ...p384 }],
    });

    expect(jwks).toEqual({
      keys: [
        { kty: 'RSA', kid: 'rsa-1', use: 'sig', alg: 'RS256', n: rsaN, e: 'AQAB' },
        { kty: 'EC', use: 'sig', alg: 'ES384', crv: 'P-384', x: p384.x, y: p384.y },
      ],
    });
  });

  // UC-17 / D-11: OIDC Dynamic Client Registration 1.0 §2 forbids private and symmetric keys.
  describe('private and symmetric keys', () => {
    it.each(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'])('should reject the whole set when a key has %s', (member) => {
      expect(() => parseClientJwkSet({ keys: [rsaKey({ kid: 'ok' }), rsaKey({ [member]: 'secret' })] })).toThrow(
        new ClientJwksUriError('the jwks_uri JWK Set must not contain private or symmetric keys'),
      );
    });

    it('should reject the whole set when a key is symmetric', () => {
      expect(() => parseClientJwkSet({ keys: [rsaKey(), { kty: 'oct', k: 'c2VjcmV0' }] })).toThrow(
        new ClientJwksUriError('the jwks_uri JWK Set must not contain private or symmetric keys'),
      );
    });

    it('should reject the whole set when an EC key has d', () => {
      expect(() => parseClientJwkSet({ keys: [ecKey({ d: 'secret' })] })).toThrow(
        new ClientJwksUriError('the jwks_uri JWK Set must not contain private or symmetric keys'),
      );
    });
  });

  // D-12 / RFC 7517 §5: keys the OP cannot use for signature verification are ignored.
  describe('keys it cannot use', () => {
    it('should drop a key whose use is enc', () => {
      expect(parseClientJwkSet({ keys: [rsaKey({ kid: 'enc', use: 'enc' }), rsaKey({ kid: 'sig' })] })).toEqual({
        keys: [normalizedRsaKey('sig')],
      });
    });

    it('should drop a key of another kty', () => {
      expect(
        parseClientJwkSet({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'x' }, rsaKey({ kid: 'sig' })] }),
      ).toEqual({ keys: [normalizedRsaKey('sig')] });
    });

    it('should drop an RSA key shorter than 2048 bits', () => {
      expect(
        parseClientJwkSet({ keys: [{ kty: 'RSA', kid: 'short', n: shortRsaN, e: 'AQAB' }, rsaKey({ kid: 'sig' })] }),
      ).toEqual({ keys: [normalizedRsaKey('sig')] });
    });

    it('should drop a key whose alg it does not verify', () => {
      expect(parseClientJwkSet({ keys: [rsaKey({ kid: 'pss', alg: 'PS256' }), rsaKey({ kid: 'sig' })] })).toEqual({
        keys: [normalizedRsaKey('sig')],
      });
    });

    it('should drop an EC key whose alg disagrees with its curve', () => {
      expect(parseClientJwkSet({ keys: [ecKey({ alg: 'ES384' }), rsaKey({ kid: 'sig' })] })).toEqual({
        keys: [normalizedRsaKey('sig')],
      });
    });

    it('should drop a key without its key members', () => {
      expect(
        parseClientJwkSet({ keys: [{ kty: 'RSA', e: 'AQAB' }, { kty: 'EC', crv: 'P-256', x: p256.x }, rsaKey({ kid: 'sig' })] }),
      ).toEqual({ keys: [normalizedRsaKey('sig')] });
    });

    it('should drop a key whose kid is not a string', () => {
      expect(parseClientJwkSet({ keys: [rsaKey({ kid: 7 }), rsaKey({ kid: 'sig' })] })).toEqual({
        keys: [normalizedRsaKey('sig')],
      });
    });

    it('should drop an entry that is not a JSON object', () => {
      expect(parseClientJwkSet({ keys: ['key', null, rsaKey({ kid: 'sig' })] })).toEqual({
        keys: [normalizedRsaKey('sig')],
      });
    });

    it('should return no keys when no key is usable', () => {
      expect(parseClientJwkSet({ keys: [rsaKey({ use: 'enc' })] })).toEqual({ keys: [] });
    });
  });

  describe('document', () => {
    it.each([[[]], [null], ['keys'], [{ keys: {} }], [{}]])('should reject %j, which is not a JWK Set', (document) => {
      expect(() => parseClientJwkSet(document)).toThrow(
        new ClientJwksUriError('the jwks_uri document is not a JWK Set'),
      );
    });

    // D-8: at most 32 keys by default.
    it('should reject a set of more than 32 keys', () => {
      const keys = Array.from({ length: 33 }, (_, i) => rsaKey({ kid: `k${i}` }));

      expect(() => parseClientJwkSet({ keys })).toThrow(
        new ClientJwksUriError('the jwks_uri JWK Set has more than 32 keys'),
      );
    });

    it('should accept a set of 32 keys', () => {
      const keys = Array.from({ length: 32 }, (_, i) => rsaKey({ kid: `k${i}` }));

      expect(parseClientJwkSet({ keys }).keys.map((key) => key.kid)).toEqual(keys.map((key) => key['kid']));
    });

    it('should take the maximum number of keys from maxKeys', () => {
      expect(() => parseClientJwkSet({ keys: [rsaKey(), rsaKey()] }, { maxKeys: 1 })).toThrow(
        new ClientJwksUriError('the jwks_uri JWK Set has more than 1 keys'),
      );
    });
  });
});

describe('resolveClientJwksTtlSeconds', () => {
  function ttlOf(headers: Record<string, string>, policy?: Parameters<typeof resolveClientJwksTtlSeconds>[1]) {
    return resolveClientJwksTtlSeconds(new Headers(headers), policy);
  }

  // UC-5 / RFC 9111 §5.2.2.1
  describe('max-age', () => {
    it('should use max-age', () => {
      expect(ttlOf({ 'Cache-Control': 'max-age=60' })).toBe(60);
    });

    // RFC 9111 §5.2: directive names are case-insensitive, and the argument may be a quoted-string.
    it('should read a directive name in any case and a quoted argument', () => {
      expect(ttlOf({ 'Cache-Control': 'MAX-AGE="60"' })).toBe(60);
    });

    it('should read max-age among other directives', () => {
      expect(ttlOf({ 'Cache-Control': 'public, max-age=60, must-revalidate' })).toBe(60);
    });

    it('should not split a directive at a comma inside a quoted string', () => {
      expect(ttlOf({ 'Cache-Control': 'private="set-cookie, x-key", max-age=60' })).toBe(60);
    });

    // RFC 9111 §4.2.3 / §5.1: the age of the response counts against max-age.
    it('should subtract the Age of the response', () => {
      expect(ttlOf({ 'Cache-Control': 'max-age=60', Age: '20' })).toBe(40);
    });

    it('should use the first value of an Age list', () => {
      expect(ttlOf({ 'Cache-Control': 'max-age=60', Age: '20, 30' })).toBe(40);
    });

    it('should ignore an Age that is not a number', () => {
      expect(ttlOf({ 'Cache-Control': 'max-age=60', Age: 'abc' })).toBe(60);
    });

    it('should treat an Age beyond max-age as stale', () => {
      expect(ttlOf({ 'Cache-Control': 'max-age=60', Age: '100' })).toBe(30);
    });

    // s-maxage is for shared caches (RFC 9111 §5.2.2.10); D-4.
    it('should not read s-maxage', () => {
      expect(ttlOf({ 'Cache-Control': 's-maxage=10, max-age=60' })).toBe(60);
    });
  });

  // D-2 / D-3: the result is kept between 30 and 300 seconds by default.
  describe('bounds', () => {
    it('should cut a max-age above the maximum down to 300 seconds', () => {
      expect(ttlOf({ 'Cache-Control': 'max-age=86400' })).toBe(300);
    });

    it('should raise a max-age below the minimum to 30 seconds', () => {
      expect(ttlOf({ 'Cache-Control': 'max-age=5' })).toBe(30);
    });

    // RFC 9111 §1.2.2: a delta-seconds too large to represent is 2147483648.
    it('should cut a max-age too large to represent', () => {
      expect(ttlOf({ 'Cache-Control': 'max-age=99999999999999999999' })).toBe(300);
      expect(ttlOf({ 'Cache-Control': 'max-age=99999999999999999999' }, { maxTtlSeconds: Infinity })).toBe(2147483648);
    });

    // UC-6: the bounds are settings.
    it('should take the maximum from maxTtlSeconds', () => {
      expect(ttlOf({ 'Cache-Control': 'max-age=86400' }, { maxTtlSeconds: 3600 })).toBe(3600);
    });

    it('should take the minimum from minTtlSeconds', () => {
      expect(ttlOf({ 'Cache-Control': 'no-store' }, { minTtlSeconds: 0 })).toBe(0);
    });

    it('should reject a minimum greater than the maximum', () => {
      expect(() => ttlOf({}, { minTtlSeconds: 400, maxTtlSeconds: 300 })).toThrow(
        new TypeError('minTtlSeconds must not be greater than maxTtlSeconds'),
      );
    });

    it.each([
      [{ ttlSeconds: -1 }],
      [{ minTtlSeconds: Number.NaN }],
      [{ maxTtlSeconds: -5 }],
    ])('should reject the negative or NaN setting %j', (policy) => {
      expect(() => ttlOf({}, policy)).toThrow(TypeError);
    });
  });

  // D-3 / RFC 9111 §5.2.2.4 / §5.2.2.5.
  describe('no-store and no-cache', () => {
    it('should use the minimum for no-store', () => {
      expect(ttlOf({ 'Cache-Control': 'no-store' })).toBe(30);
    });

    it('should use the minimum for no-cache, even with max-age', () => {
      expect(ttlOf({ 'Cache-Control': 'max-age=120, no-cache' })).toBe(30);
    });
  });

  // D-5 / RFC 9111 §4.2.1: a duplicated or invalid max-age makes the response stale.
  describe('invalid max-age', () => {
    it('should use the minimum for a duplicated max-age', () => {
      expect(ttlOf({ 'Cache-Control': 'max-age=60, max-age=120' })).toBe(30);
    });

    it.each(['max-age=abc', 'max-age=-1', 'max-age=1.5', 'max-age=', 'max-age'])(
      'should use the minimum for %s',
      (value) => {
        expect(ttlOf({ 'Cache-Control': value })).toBe(30);
      },
    );
  });

  // D-1 / D-4: without max-age, the default (Expires is not read).
  describe('without max-age', () => {
    it('should use 300 seconds when there is no Cache-Control', () => {
      expect(ttlOf({})).toBe(300);
    });

    it('should not read Expires', () => {
      expect(ttlOf({ Expires: 'Thu, 01 Jan 1970 00:00:00 GMT' })).toBe(300);
    });

    it('should take the default from ttlSeconds', () => {
      expect(ttlOf({ 'Cache-Control': 'public' }, { ttlSeconds: 120 })).toBe(120);
    });
  });
});

describe('fetchClientJwkSet', () => {
  it('should GET the jwks_uri without following redirects and with a timeout', async () => {
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })]));

    await fetchClientJwkSet(JWKS_URI, { fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0]!;
    expect(input).toBe(JWKS_URI);
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('accept')).toBe('application/jwk-set+json, application/json');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('should return the keys of the document and the ttl of its Cache-Control', async () => {
    const fetch = stubFetch(() =>
      jwkSetResponse([rsaKey({ kid: 'k1' })], { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' }),
    );

    expect(await fetchClientJwkSet(JWKS_URI, { fetch })).toEqual({
      jwks: { keys: [normalizedRsaKey('k1')] },
      ttlSeconds: 60,
    });
  });

  it('should take the ttl bounds from the options', async () => {
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })], { 'Cache-Control': 'max-age=86400' }));

    expect((await fetchClientJwkSet(JWKS_URI, { fetch, maxTtlSeconds: 3600 })).ttlSeconds).toBe(3600);
  });

  // D-10: the Content-Type of the response is not checked.
  it('should read a document served as text/plain', async () => {
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })], { 'Content-Type': 'text/plain' }));

    expect((await fetchClientJwkSet(JWKS_URI, { fetch })).jwks).toEqual({ keys: [normalizedRsaKey('k1')] });
  });

  // UC-16 / D-8
  describe('failures', () => {
    it.each([302, 404, 500, 204])('should reject the status %i', async (status) => {
      const fetch = stubFetch(
        () => new Response(status === 204 ? null : '{}', { status, headers: { Location: 'https://rp.example.com/x' } }),
      );

      await expect(fetchClientJwkSet(JWKS_URI, { fetch })).rejects.toThrow(
        new ClientJwksUriError(`the jwks_uri answered HTTP ${status}`),
      );
    });

    it('should reject a Content-Length over the maximum size', async () => {
      const fetch = stubFetch(
        () => new Response('{"keys":[]}', { status: 200, headers: { 'Content-Length': '65537' } }),
      );

      await expect(fetchClientJwkSet(JWKS_URI, { fetch })).rejects.toThrow(
        new ClientJwksUriError('the jwks_uri document exceeds 65536 bytes'),
      );
    });

    it('should stop reading a body that grows over the maximum size', async () => {
      let pulled = 0;
      const fetch = stubFetch(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(1024).fill(0x20));
              },
            }),
            { status: 200 },
          ),
      );

      await expect(fetchClientJwkSet(JWKS_URI, { fetch, maxBytes: 4096 })).rejects.toThrow(
        new ClientJwksUriError('the jwks_uri document exceeds 4096 bytes'),
      );
      expect(pulled).toBeLessThan(10);
    });

    it('should reject a body that is not JSON', async () => {
      const fetch = stubFetch(() => new Response('<html></html>', { status: 200 }));

      await expect(fetchClientJwkSet(JWKS_URI, { fetch })).rejects.toThrow(
        new ClientJwksUriError('the jwks_uri document is not JSON'),
      );
    });

    it('should reject a JSON document that is not a JWK Set', async () => {
      const fetch = stubFetch(() => new Response('[]', { status: 200 }));

      await expect(fetchClientJwkSet(JWKS_URI, { fetch })).rejects.toThrow(
        new ClientJwksUriError('the jwks_uri document is not a JWK Set'),
      );
    });

    it('should reject when the jwks_uri does not answer within the timeout', async () => {
      const fetch = vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );

      await expect(fetchClientJwkSet(JWKS_URI, { fetch, timeoutMs: 10 })).rejects.toThrow(
        new ClientJwksUriError('the jwks_uri request failed (TimeoutError)'),
      );
    });

    it('should reject when the request fails', async () => {
      const fetch = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });

      await expect(fetchClientJwkSet(JWKS_URI, { fetch })).rejects.toThrow(
        new ClientJwksUriError('the jwks_uri request failed (TypeError)'),
      );
    });

    // D-9: the destination is checked before anything is sent.
    it('should reject an insecure jwks_uri without fetching it', async () => {
      const fetch = stubFetch(() => jwkSetResponse([]));

      await expect(fetchClientJwkSet('http://127.0.0.1:3020/jwks.json', { fetch })).rejects.toThrow(
        new ClientJwksUriError('jwks_uri must use https'),
      );
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('should fetch a loopback http jwks_uri when the policy allows insecure ones', async () => {
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })]));

    const fetched = await fetchClientJwkSet('http://127.0.0.1:3020/jwks.json', { fetch, policy: { allowInsecure: true } });

    expect(fetched.jwks).toEqual({ keys: [normalizedRsaKey('k1')] });
  });

  it('should take the maximum number of keys from maxKeys', async () => {
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' }), rsaKey({ kid: 'k2' })]));

    await expect(fetchClientJwkSet(JWKS_URI, { fetch, maxKeys: 1 })).rejects.toThrow(
      new ClientJwksUriError('the jwks_uri JWK Set has more than 1 keys'),
    );
  });
});

describe('createClientJwksUriCache', () => {
  /** A clock the test moves forward by hand, in seconds. */
  function clock() {
    let seconds = 0;
    return {
      now: () => seconds * 1000,
      set: (value: number) => {
        seconds = value;
      },
    };
  }

  function kidsOf(jwks: JwkSet): Array<string | undefined> {
    return jwks.keys.map((key) => key.kid);
  }

  it('should fetch the jwks_uri once while its keys are fresh', async () => {
    const time = clock();
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })]));
    const cache = createClientJwksUriCache();
    const options: ClientJwksUriLoadOptions = { fetch, now: time.now };

    const first = await cache.load(JWKS_URI, {}, options);
    time.set(299);
    const second = await cache.load(JWKS_URI, {}, options);

    expect(first).toEqual({ keys: [normalizedRsaKey('k1')] });
    expect(second).toEqual({ keys: [normalizedRsaKey('k1')] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // UC-5: each response sets its own expiry.
  it('should fetch again once the max-age of the response has passed', async () => {
    const time = clock();
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })], { 'Cache-Control': 'max-age=60' }));
    const cache = createClientJwksUriCache();
    const options: ClientJwksUriLoadOptions = { fetch, now: time.now };

    await cache.load(JWKS_URI, {}, options);
    time.set(59);
    await cache.load(JWKS_URI, {}, options);
    expect(fetch).toHaveBeenCalledTimes(1);

    time.set(60);
    await cache.load(JWKS_URI, {}, options);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // UC-2 / OIDC Core 1.0 §10.1.1: an unfamiliar kid is the signal to retrieve the keys again.
  it('should fetch again for an unknown kid once the refetch interval has passed', async () => {
    const time = clock();
    const responses = [[rsaKey({ kid: 'k1' })], [rsaKey({ kid: 'k1' }), rsaKey({ kid: 'k2' })]];
    const fetch = stubFetch(() => jwkSetResponse(responses.shift()!));
    const cache = createClientJwksUriCache();
    const options: ClientJwksUriLoadOptions = { fetch, now: time.now };

    await cache.load(JWKS_URI, {}, options);
    time.set(30);
    const rotated = await cache.load(JWKS_URI, { kid: 'k2' }, options);

    expect(kidsOf(rotated)).toEqual(['k1', 'k2']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // UC-19 / D-6: unknown kids do not make the OP fetch more than once per interval.
  it('should answer an unknown kid from the cache within the refetch interval', async () => {
    const time = clock();
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })]));
    const cache = createClientJwksUriCache();
    const options: ClientJwksUriLoadOptions = { fetch, now: time.now };

    await cache.load(JWKS_URI, {}, options);
    time.set(10);
    const answered = await cache.load(JWKS_URI, { kid: 'attacker-1' }, options);
    time.set(29);
    await cache.load(JWKS_URI, { kid: 'attacker-2' }, options);

    expect(kidsOf(answered)).toEqual(['k1']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should count the refetch interval from the last refetch', async () => {
    const time = clock();
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })]));
    const cache = createClientJwksUriCache();
    const options: ClientJwksUriLoadOptions = { fetch, now: time.now };

    await cache.load(JWKS_URI, {}, options);
    time.set(30);
    await cache.load(JWKS_URI, { kid: 'k2' }, options);
    time.set(59);
    await cache.load(JWKS_URI, { kid: 'k2' }, options);
    expect(fetch).toHaveBeenCalledTimes(2);

    time.set(60);
    await cache.load(JWKS_URI, { kid: 'k2' }, options);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  // D-7
  it('should not fetch again for a hint without kid while the keys are fresh', async () => {
    const time = clock();
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })]));
    const cache = createClientJwksUriCache();
    const options: ClientJwksUriLoadOptions = { fetch, now: time.now };

    await cache.load(JWKS_URI, {}, options);
    time.set(200);
    await cache.load(JWKS_URI, undefined, options);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // D-15: keys within their expiry have not been revoked, so a failed refetch keeps them.
  it('should keep answering with the fresh keys when a refetch for an unknown kid fails', async () => {
    const time = clock();
    const responses = [jwkSetResponse([rsaKey({ kid: 'k1' })]), new Response('', { status: 503 })];
    const fetch = stubFetch(() => responses.shift()!);
    const cache = createClientJwksUriCache();
    const options: ClientJwksUriLoadOptions = { fetch, now: time.now };

    await cache.load(JWKS_URI, {}, options);
    time.set(31);
    const answered = await cache.load(JWKS_URI, { kid: 'k2' }, options);
    time.set(40);
    const again = await cache.load(JWKS_URI, { kid: 'k2' }, options);

    expect(kidsOf(answered)).toEqual(['k1']);
    expect(kidsOf(again)).toEqual(['k1']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // UC-4 / D-15: an expired key set is never used, and a failure is remembered.
  it('should throw without using the expired keys when the fetch fails, and remember the failure', async () => {
    const time = clock();
    const responses = [
      jwkSetResponse([rsaKey({ kid: 'k1' })]),
      new Response('', { status: 503 }),
      jwkSetResponse([rsaKey({ kid: 'k3' })]),
    ];
    const fetch = stubFetch(() => responses.shift()!);
    const cache = createClientJwksUriCache();
    const options: ClientJwksUriLoadOptions = { fetch, now: time.now };

    await cache.load(JWKS_URI, {}, options);
    time.set(300);
    await expect(cache.load(JWKS_URI, {}, options)).rejects.toThrow(
      new ClientJwksUriError('the jwks_uri answered HTTP 503'),
    );
    time.set(329);
    await expect(cache.load(JWKS_URI, {}, options)).rejects.toThrow(
      new ClientJwksUriError('the jwks_uri failed less than the refetch interval ago'),
    );
    expect(fetch).toHaveBeenCalledTimes(2);

    time.set(330);
    expect(kidsOf(await cache.load(JWKS_URI, {}, options))).toEqual(['k3']);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('should share one fetch between concurrent loads of the same jwks_uri', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetch = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const cache = createClientJwksUriCache();
    const options: ClientJwksUriLoadOptions = { fetch, now: () => 0 };

    const first = cache.load(JWKS_URI, {}, options);
    const second = cache.load(JWKS_URI, { kid: 'k1' }, options);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    answer(jwkSetResponse([rsaKey({ kid: 'k1' })]));

    expect(await first).toEqual({ keys: [normalizedRsaKey('k1')] });
    expect(await second).toEqual({ keys: [normalizedRsaKey('k1')] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should drop the oldest jwks_uri beyond maxEntries', async () => {
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })]));
    const cache = createClientJwksUriCache();
    const options: ClientJwksUriLoadOptions = { fetch, now: () => 0, maxEntries: 2 };

    await cache.load('https://a.example.com/jwks', {}, options);
    await cache.load('https://b.example.com/jwks', {}, options);
    await cache.load('https://c.example.com/jwks', {}, options);
    await cache.load('https://b.example.com/jwks', {}, options);
    expect(fetch).toHaveBeenCalledTimes(3);

    await cache.load('https://a.example.com/jwks', {}, options);
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      'https://a.example.com/jwks',
      'https://b.example.com/jwks',
      'https://c.example.com/jwks',
      'https://a.example.com/jwks',
    ]);
  });

  // UC-6: a cache shared by the process still follows the settings of each call.
  it('should apply the settings of each load call', async () => {
    const time = clock();
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })], { 'Cache-Control': 'max-age=3600' }));
    const cache = createClientJwksUriCache();

    await cache.load(JWKS_URI, {}, { fetch, now: time.now, maxTtlSeconds: 3600 });
    time.set(3599);
    await cache.load(JWKS_URI, {}, { fetch, now: time.now, maxTtlSeconds: 3600 });
    expect(fetch).toHaveBeenCalledTimes(1);

    time.set(3600);
    await cache.load(JWKS_URI, { kid: 'k2' }, { fetch, now: time.now, refetchIntervalSeconds: 0 });
    time.set(3601);
    await cache.load(JWKS_URI, { kid: 'k2' }, { fetch, now: time.now, refetchIntervalSeconds: 0 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('should check the jwks_uri against the policy of each call before answering from the cache', async () => {
    const uri = 'http://127.0.0.1:3020/jwks.json';
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })]));
    const cache = createClientJwksUriCache();

    await cache.load(uri, {}, { fetch, now: () => 0, policy: { allowInsecure: true } });

    await expect(cache.load(uri, {}, { fetch, now: () => 0 })).rejects.toThrow(
      new ClientJwksUriError('jwks_uri must use https'),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should hand out key lists that do not change the cache', async () => {
    const fetch = stubFetch(() => jwkSetResponse([rsaKey({ kid: 'k1' })]));
    const cache = createClientJwksUriCache();
    const options: ClientJwksUriLoadOptions = { fetch, now: () => 0 };

    const first = await cache.load(JWKS_URI, {}, options);
    first.keys.push(normalizedRsaKey('injected'));

    expect(kidsOf(await cache.load(JWKS_URI, {}, options))).toEqual(['k1']);
  });
});

describe('withClientJwksUriKeys', () => {
  const baseKey: Jwk = { kty: 'RSA', kid: 'stored', use: 'sig', alg: 'RS256', n: 'n', e: 'AQAB' };
  const uriKey: Jwk = { kty: 'RSA', kid: 'from-uri', use: 'sig', alg: 'RS256', n: 'n2', e: 'AQAB' };

  function resolverOf(jwksUris: Record<string, string>) {
    const base = { findClientKeys: vi.fn<ClientKeyResolver['findClientKeys']>(async () => ({ keys: [baseKey] })) };
    const load = vi.fn(async (_uri: string, _hint?: { kid?: string }) => ({ keys: [uriKey] }));
    const findJwksUri = vi.fn(async (clientId: string) => jwksUris[clientId]);
    const resolver = withClientJwksUriKeys(base, {
      findJwksUri,
      purposes: ['request_object', 'private_key_jwt'],
      load,
    });
    return { base, load, findJwksUri, resolver };
  }

  // D-17: a client with a jwks_uri takes its keys of the covered purposes from there only.
  it('should return the keys of the jwks_uri without reading the base for a covered purpose', async () => {
    const { base, load, resolver } = resolverOf({ rp: JWKS_URI });

    expect(await resolver.findClientKeys('rp', 'request_object', { kid: 'from-uri' })).toEqual({ keys: [uriKey] });
    expect(load).toHaveBeenCalledWith(JWKS_URI, { kid: 'from-uri' });
    expect(base.findClientKeys).not.toHaveBeenCalled();
  });

  it('should return the keys of the base for a client without a jwks_uri, with the hint', async () => {
    const { base, load, resolver } = resolverOf({});

    expect(await resolver.findClientKeys('rp', 'request_object', { kid: 'stored' })).toEqual({ keys: [baseKey] });
    expect(base.findClientKeys).toHaveBeenCalledWith('rp', 'request_object', { kid: 'stored' });
    expect(load).not.toHaveBeenCalled();
  });

  // D-18
  it('should return the keys of the base for a purpose the jwks_uri does not serve', async () => {
    const { base, findJwksUri, load, resolver } = resolverOf({ rp: JWKS_URI });

    expect(await resolver.findClientKeys('rp', 'dpop')).toEqual({ keys: [baseKey] });
    expect(base.findClientKeys).toHaveBeenCalledWith('rp', 'dpop', undefined);
    expect(findJwksUri).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});
