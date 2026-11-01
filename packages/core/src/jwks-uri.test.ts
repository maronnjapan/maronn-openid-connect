import { describe, expect, it } from 'vitest';
import {
  createJwksUriResolver,
  fetchJwksFromUri,
  JwksUriError,
  validateJwksUri,
  type CachedJwks,
} from './jwks-uri.js';

const JWKS_URI = 'https://rp.example.com/.well-known/jwks.json';
const RSA_KEY = { kty: 'RSA', kid: 'rsa-1', n: 'AQAB-n', e: 'AQAB' };
const EC_KEY = { kty: 'EC', kid: 'ec-1', crv: 'P-256', x: 'x-1', y: 'y-1' };

function fetchStub(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { fetch: stub, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2: the URL of the
// client's JWK Set document.
describe('validateJwksUri', () => {
  it('should accept an https jwks_uri and a loopback http one', () => {
    expect(validateJwksUri(JWKS_URI)).toBe(JWKS_URI);
    expect(validateJwksUri('http://127.0.0.1:3020/jwks')).toBe('http://127.0.0.1:3020/jwks');
  });

  it.each([
    ['a non-loopback http URL', 'http://rp.example.com/jwks', 'jwks_uri must use the https scheme'],
    ['a relative URL', '/jwks', 'jwks_uri must be an absolute URL'],
    ['a URL with credentials', 'https://user:pw@rp.example.com/jwks', 'jwks_uri must not carry credentials'],
    ['a URL with a space', 'https://rp.example.com/j wks', 'jwks_uri must consist of visible ASCII characters'],
    ['an empty string', '', 'jwks_uri must be a non-empty string'],
    ['a non-string value', 42, 'jwks_uri must be a non-empty string'],
    ['a URL over 2048 characters', `https://rp.example.com/${'a'.repeat(2048)}`, 'jwks_uri must not exceed 2048 characters'],
  ])('should reject %s', (_label, value, message) => {
    expect(() => validateJwksUri(value)).toThrowError(new JwksUriError(message));
  });
});

// The OP fetches the document when it needs the keys, never at registration.
describe('fetchJwksFromUri', () => {
  it('should GET the document and return the signing keys with their defaults filled in', async () => {
    const { fetch, calls } = fetchStub(() => jsonResponse({ keys: [RSA_KEY, EC_KEY] }));

    const jwks = await fetchJwksFromUri(JWKS_URI, { fetch });

    expect(jwks).toEqual({
      keys: [
        { kty: 'RSA', kid: 'rsa-1', use: 'sig', alg: 'RS256', n: 'AQAB-n', e: 'AQAB' },
        { kty: 'EC', kid: 'ec-1', use: 'sig', alg: 'ES256', crv: 'P-256', x: 'x-1', y: 'y-1' },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(JWKS_URI);
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.redirect).toBe('manual');
    expect((calls[0]?.init.headers as Record<string, string>)['Accept']).toBe(
      'application/jwk-set+json, application/json;q=0.9, */*;q=0.5',
    );
  });

  it('should keep the alg and kid of a key and drop encryption keys and keys the OP cannot verify with', async () => {
    const { fetch } = fetchStub(() =>
      jsonResponse({
        keys: [
          { ...RSA_KEY, alg: 'RS512', x5c: ['cert'] },
          { kty: 'RSA', use: 'enc', n: 'AQAB-n', e: 'AQAB' },
          { kty: 'OKP', crv: 'Ed25519', x: 'x' },
          { kty: 'RSA', alg: 'PS256', n: 'AQAB-n', e: 'AQAB' },
        ],
      }),
    );

    const jwks = await fetchJwksFromUri(JWKS_URI, { fetch });

    expect(jwks).toEqual({ keys: [{ kty: 'RSA', kid: 'rsa-1', use: 'sig', alg: 'RS512', n: 'AQAB-n', e: 'AQAB' }] });
  });

  // OIDC Dynamic Client Registration 1.0 §2: the document MUST NOT contain
  // private or symmetric key values; such a document is not trusted at all.
  it('should reject a document with a private key or a symmetric key', async () => {
    const { fetch: withPrivate } = fetchStub(() => jsonResponse({ keys: [RSA_KEY, { ...RSA_KEY, kid: 'rsa-2', d: 'secret' }] }));
    const { fetch: withSymmetric } = fetchStub(() => jsonResponse({ keys: [{ kty: 'oct', k: 'secret' }] }));

    await expect(fetchJwksFromUri(JWKS_URI, { fetch: withPrivate })).rejects.toThrowError(
      new JwksUriError('jwks_uri returned a JWK Set with a private or symmetric key'),
    );
    await expect(fetchJwksFromUri(JWKS_URI, { fetch: withSymmetric })).rejects.toThrowError(
      new JwksUriError('jwks_uri returned a JWK Set with a private or symmetric key'),
    );
  });

  it.each([
    ['a non-JSON body', new Response('not json', { status: 200 }), 'jwks_uri did not return a JSON document'],
    ['a JSON array', jsonResponse([RSA_KEY]), 'jwks_uri did not return a JWK Set'],
    ['an object without keys', jsonResponse({ kty: 'RSA' }), 'jwks_uri did not return a JWK Set'],
    ['a keys member that is not an object', jsonResponse({ keys: ['x'] }), 'jwks_uri returned a JWK Set with a member that is not a JWK'],
    ['a 404', new Response('gone', { status: 404 }), 'jwks_uri did not return 200 OK'],
    ['a redirect', new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.com/' } }), 'jwks_uri did not return 200 OK'],
    ['an empty body', new Response('  ', { status: 200 }), 'jwks_uri returned no content'],
  ])('should reject %s with a fixed description', async (_label, response, message) => {
    const { fetch } = fetchStub(() => response);

    await expect(fetchJwksFromUri(JWKS_URI, { fetch })).rejects.toThrowError(new JwksUriError(message));
  });

  it('should reject a document over maxBytes', async () => {
    const { fetch } = fetchStub(() => jsonResponse({ keys: [RSA_KEY] }));

    await expect(fetchJwksFromUri(JWKS_URI, { fetch, maxBytes: 16 })).rejects.toThrowError(
      new JwksUriError('jwks_uri document exceeds the maximum size'),
    );
  });

  it('should turn a network failure and a timeout into a JwksUriError without reflecting them', async () => {
    const { fetch: failing } = fetchStub(() => {
      throw new TypeError('getaddrinfo ENOTFOUND rp.example.com');
    });
    const { fetch: hanging } = fetchStub(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    await expect(fetchJwksFromUri(JWKS_URI, { fetch: failing })).rejects.toThrowError(
      new JwksUriError('jwks_uri could not be retrieved'),
    );
    await expect(fetchJwksFromUri(JWKS_URI, { fetch: hanging, timeoutMs: 10 })).rejects.toThrowError(
      new JwksUriError('jwks_uri could not be retrieved'),
    );
  });
});

// OIDC Core 1.0 §10.1.1: the OP keeps the fetched keys for a while, so a
// client rotating its keys keeps the old ones published until that passes.
describe('createJwksUriResolver', () => {
  it('should fetch once within the TTL and again after it', async () => {
    let clock = 1_000;
    const { fetch, calls } = fetchStub(() => jsonResponse({ keys: [RSA_KEY] }));
    const resolver = createJwksUriResolver({ fetch, ttlMs: 300_000, now: () => clock });

    const first = await resolver.resolve(JWKS_URI);
    clock += 299_999;
    const second = await resolver.resolve(JWKS_URI);
    clock += 2;
    const third = await resolver.resolve(JWKS_URI);

    expect(first).toEqual({ keys: [{ kty: 'RSA', kid: 'rsa-1', use: 'sig', alg: 'RS256', n: 'AQAB-n', e: 'AQAB' }] });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(calls).toHaveLength(2);
  });

  it('should answer an empty key set for a failed retrieval and not retry it within the failure TTL', async () => {
    let clock = 1_000;
    const { fetch, calls } = fetchStub(() => new Response('gone', { status: 404 }));
    const resolver = createJwksUriResolver({ fetch, failureTtlMs: 30_000, now: () => clock });

    const first = await resolver.resolve(JWKS_URI);
    clock += 29_999;
    const second = await resolver.resolve(JWKS_URI);
    clock += 2;
    await resolver.resolve(JWKS_URI);

    expect(first).toEqual({ keys: [] });
    expect(second).toEqual({ keys: [] });
    expect(calls).toHaveLength(2);
  });

  it('should share the results through the given cache and hand out copies', async () => {
    const cache = new Map<string, CachedJwks>();
    const { fetch, calls } = fetchStub(() => jsonResponse({ keys: [RSA_KEY] }));
    const first = createJwksUriResolver({ fetch, cache, now: () => 1_000 });
    const second = createJwksUriResolver({ fetch, cache, now: () => 2_000 });

    const keys = await first.resolve(JWKS_URI);
    keys.keys.pop();
    const shared = await second.resolve(JWKS_URI);

    expect(calls).toHaveLength(1);
    expect(shared.keys).toHaveLength(1);
    expect(cache.get(JWKS_URI)?.expiresAt).toBe(301_000);
  });
});
