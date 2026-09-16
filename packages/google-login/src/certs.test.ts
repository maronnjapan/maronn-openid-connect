import { beforeAll, describe, expect, it } from 'vitest';

import {
  createGoogleCertsKeyProvider,
  createStaticGoogleSigningKeyProvider,
  DEFAULT_CERTS_MIN_REFRESH_INTERVAL_MS,
  GOOGLE_CERTS_URL,
  parseCacheControlMaxAge,
  parseJwkSet,
} from './certs.js';
import { GoogleLoginErrorCode } from './errors.js';
import {
  captureRejection,
  captureThrow,
  createFakeFetch,
  createJwksResponse,
  expectGoogleLoginError,
  generateGoogleTestKey,
  type GoogleTestKey,
} from './test-helpers.js';

describe('parseCacheControlMaxAge', () => {
  it('should read max-age from a Google style Cache-Control header', () => {
    expect(parseCacheControlMaxAge('public, max-age=22000, must-revalidate, no-transform')).toBe(22000);
  });

  it('should read max-age when it is the first directive', () => {
    expect(parseCacheControlMaxAge('max-age=60')).toBe(60);
  });

  it('should read a quoted max-age', () => {
    expect(parseCacheControlMaxAge('public, max-age="120"')).toBe(120);
  });

  it('should return null when the header is missing', () => {
    expect(parseCacheControlMaxAge(null)).toBe(null);
    expect(parseCacheControlMaxAge(undefined)).toBe(null);
  });

  it('should return null when max-age is absent', () => {
    expect(parseCacheControlMaxAge('no-cache, no-store')).toBe(null);
  });

  it('should not read s-maxage as max-age', () => {
    expect(parseCacheControlMaxAge('private, s-maxage=10')).toBe(null);
  });
});

describe('parseJwkSet', () => {
  it('should return the keys array', () => {
    const keys = [{ kid: 'a', kty: 'RSA', n: 'n', e: 'AQAB' }];

    expect(parseJwkSet({ keys })).toEqual(keys);
  });

  it('should drop entries that are not key objects', () => {
    expect(parseJwkSet({ keys: [{ kid: 'a', kty: 'RSA' }, 'text', null, { kid: 'no-kty' }] })).toEqual([
      { kid: 'a', kty: 'RSA' },
    ]);
  });

  it('should reject a body without a keys array', () => {
    const error = captureThrow(() => parseJwkSet({ jwks: [] }));

    expectGoogleLoginError(error, GoogleLoginErrorCode.SigningKeyUnavailable, 503);
  });

  it('should reject a body that is not an object', () => {
    const error = captureThrow(() => parseJwkSet('keys'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.SigningKeyUnavailable, 503);
  });
});

describe('createGoogleCertsKeyProvider', () => {
  let key1: GoogleTestKey;
  let key2: GoogleTestKey;

  beforeAll(async () => {
    key1 = await generateGoogleTestKey('kid-1');
    key2 = await generateGoogleTestKey('kid-2');
  });

  function createClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
    let current = start;
    return {
      now: () => current,
      advance: (ms) => {
        current += ms;
      },
    };
  }

  it('should fetch the JWK Set from the Google certs URL asking for JSON', async () => {
    const fake = createFakeFetch(() => createJwksResponse([key1.jwk]));
    const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch });

    await provider.getSigningKey('kid-1');

    expect(fake.calls).toEqual([
      { input: GOOGLE_CERTS_URL, init: { headers: { accept: 'application/json' } } },
    ]);
  });

  it('should fetch from a custom certs URL', async () => {
    const fake = createFakeFetch(() => createJwksResponse([key1.jwk]));
    const provider = createGoogleCertsKeyProvider({
      fetch: fake.fetch,
      certsUrl: 'https://certs.example.test/jwks',
    });

    await provider.getSigningKey('kid-1');

    expect(fake.calls[0]?.input).toBe('https://certs.example.test/jwks');
  });

  it('should return the key whose kid matches', async () => {
    const fake = createFakeFetch(() => createJwksResponse([key1.jwk, key2.jwk]));
    const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch });

    expect(await provider.getSigningKey('kid-2')).toEqual(key2.jwk);
  });

  it('should reuse the cached keys while max-age has not elapsed', async () => {
    const clock = createClock();
    const fake = createFakeFetch(() => createJwksResponse([key1.jwk], { maxAge: 100 }));
    const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch, now: clock.now });

    await provider.getSigningKey('kid-1');
    clock.advance(99_999);
    await provider.getSigningKey('kid-1');

    expect(fake.calls.length).toBe(1);
  });

  it('should refetch once max-age has elapsed', async () => {
    const clock = createClock();
    const fake = createFakeFetch(() => createJwksResponse([key1.jwk], { maxAge: 100 }));
    const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch, now: clock.now });

    await provider.getSigningKey('kid-1');
    clock.advance(100_000);
    await provider.getSigningKey('kid-1');

    expect(fake.calls.length).toBe(2);
  });

  it('should return null for an unknown kid without refetching inside the minimum refresh interval', async () => {
    const clock = createClock();
    const fake = createFakeFetch(() => createJwksResponse([key1.jwk], { maxAge: 3600 }));
    const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch, now: clock.now });

    await provider.getSigningKey('kid-1');
    clock.advance(DEFAULT_CERTS_MIN_REFRESH_INTERVAL_MS - 1);

    expect(await provider.getSigningKey('kid-2')).toBe(null);
    expect(fake.calls.length).toBe(1);
  });

  it('should refetch for an unknown kid once the minimum refresh interval has elapsed', async () => {
    const clock = createClock();
    const fake = createFakeFetch((call) =>
      createJwksResponse(call === 1 ? [key1.jwk] : [key1.jwk, key2.jwk], { maxAge: 3600 }),
    );
    const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch, now: clock.now });

    await provider.getSigningKey('kid-1');
    clock.advance(DEFAULT_CERTS_MIN_REFRESH_INTERVAL_MS);

    expect(await provider.getSigningKey('kid-2')).toEqual(key2.jwk);
    expect(fake.calls.length).toBe(2);
  });

  it('should honor a custom minimum refresh interval', async () => {
    const clock = createClock();
    const fake = createFakeFetch(() => createJwksResponse([key1.jwk], { maxAge: 3600 }));
    const provider = createGoogleCertsKeyProvider({
      fetch: fake.fetch,
      now: clock.now,
      minRefreshIntervalMs: 5_000,
    });

    await provider.getSigningKey('kid-1');
    clock.advance(5_000);
    await provider.getSigningKey('kid-2');

    expect(fake.calls.length).toBe(2);
  });

  it('should use the default ttl when the response has no max-age', async () => {
    const clock = createClock();
    const fake = createFakeFetch(() => createJwksResponse([key1.jwk], { cacheControl: null }));
    const provider = createGoogleCertsKeyProvider({
      fetch: fake.fetch,
      now: clock.now,
      defaultTtlSeconds: 10,
    });

    await provider.getSigningKey('kid-1');
    clock.advance(9_999);
    await provider.getSigningKey('kid-1');
    expect(fake.calls.length).toBe(1);

    clock.advance(1);
    await provider.getSigningKey('kid-1');
    expect(fake.calls.length).toBe(2);
  });

  it('should share one in-flight fetch between concurrent lookups', async () => {
    let release: (response: Response) => void = () => {};
    const fake = createFakeFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch });

    const lookups = Promise.all([provider.getSigningKey('kid-1'), provider.getSigningKey('kid-2')]);
    release(createJwksResponse([key1.jwk, key2.jwk]));

    expect(await lookups).toEqual([key1.jwk, key2.jwk]);
    expect(fake.calls.length).toBe(1);
  });

  it('should throw signing_key_unavailable when the endpoint responds with an error status', async () => {
    const fake = createFakeFetch(() => createJwksResponse([], { status: 500 }));
    const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch });

    const error = await captureRejection(provider.getSigningKey('kid-1'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.SigningKeyUnavailable, 503);
  });

  it('should throw signing_key_unavailable when fetch rejects', async () => {
    const provider = createGoogleCertsKeyProvider({
      fetch: async () => {
        throw new Error('network down');
      },
    });

    const error = await captureRejection(provider.getSigningKey('kid-1'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.SigningKeyUnavailable, 503);
  });

  it('should throw signing_key_unavailable when the body is not JSON', async () => {
    const fake = createFakeFetch(() => createJwksResponse([], { body: '<html>' }));
    const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch });

    const error = await captureRejection(provider.getSigningKey('kid-1'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.SigningKeyUnavailable, 503);
  });

  it('should not fall back to expired keys when the refresh fails', async () => {
    const clock = createClock();
    const fake = createFakeFetch((call) =>
      call === 1 ? createJwksResponse([key1.jwk], { maxAge: 100 }) : createJwksResponse([], { status: 503 }),
    );
    const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch, now: clock.now });

    await provider.getSigningKey('kid-1');
    clock.advance(100_000);
    const error = await captureRejection(provider.getSigningKey('kid-1'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.SigningKeyUnavailable, 503);
  });

  it('should retry the fetch on the next lookup after a failure', async () => {
    const fake = createFakeFetch((call) =>
      call === 1 ? createJwksResponse([], { status: 503 }) : createJwksResponse([key1.jwk]),
    );
    const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch });

    await captureRejection(provider.getSigningKey('kid-1'));

    expect(await provider.getSigningKey('kid-1')).toEqual(key1.jwk);
    expect(fake.calls.length).toBe(2);
  });

  describe('refresh', () => {
    it('should bypass the cache and return the fetched keys', async () => {
      const fake = createFakeFetch((call) =>
        createJwksResponse(call === 1 ? [key1.jwk] : [key2.jwk], { maxAge: 3600 }),
      );
      const provider = createGoogleCertsKeyProvider({ fetch: fake.fetch });

      await provider.getSigningKey('kid-1');

      expect(await provider.refresh()).toEqual([key2.jwk]);
      expect(await provider.getSigningKey('kid-2')).toEqual(key2.jwk);
      expect(fake.calls.length).toBe(2);
    });
  });
});

describe('createStaticGoogleSigningKeyProvider', () => {
  it('should return the key whose kid matches', async () => {
    const jwk = { kid: 'static', kty: 'RSA', n: 'n', e: 'AQAB' };
    const provider = createStaticGoogleSigningKeyProvider([jwk]);

    expect(await provider.getSigningKey('static')).toEqual(jwk);
  });

  it('should return null for an unknown kid', async () => {
    const provider = createStaticGoogleSigningKeyProvider([{ kid: 'static', kty: 'RSA' }]);

    expect(await provider.getSigningKey('other')).toBe(null);
  });
});
