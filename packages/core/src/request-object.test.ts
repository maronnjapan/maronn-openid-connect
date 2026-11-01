import { describe, it, expect, beforeAll } from 'vitest';
import {
  fetchRequestObjectByReference,
  parseRequestObject,
  RequestObjectError,
  RequestUriError,
  validateRequestUri,
} from './request-object.js';
import { exportPublicJwk } from './jwks.js';
import type { JwkSet } from './jwks.js';
import { sign, arrayBufferToBase64Url, stringToArrayBuffer } from './crypto-utils.js';

function encodeSegment(value: unknown): string {
  return arrayBufferToBase64Url(stringToArrayBuffer(JSON.stringify(value)));
}

async function buildSigned(
  claims: Record<string, unknown>,
  privateKey: CryptoKey,
  kid?: string,
  alg = 'RS256',
): Promise<string> {
  const header: Record<string, unknown> = { alg, typ: 'oauth-authz-req+jwt' };
  if (kid !== undefined) header.kid = kid;
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const signature = await sign(signingInput, privateKey);
  return `${signingInput}.${signature}`;
}

describe('parseRequestObject', () => {
  let rsaKeyPair: CryptoKeyPair;
  let otherKeyPair: CryptoKeyPair;
  let jwks: JwkSet;
  const kid = 'req-key';

  beforeAll(async () => {
    rsaKeyPair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    otherKeyPair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    jwks = { keys: [await exportPublicJwk(rsaKeyPair.publicKey, kid)] };
  });

  describe('signed request objects (RS256)', () => {
    it('should return the payload claims when the signature is valid', async () => {
      const request = await buildSigned(
        { response_type: 'code', scope: 'openid', state: 'abc' },
        rsaKeyPair.privateKey,
        kid,
      );

      const claims = await parseRequestObject(request, {
        jwks,
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: false,
      });

      expect(claims).toEqual({
        response_type: 'code',
        scope: 'openid',
        state: 'abc',
      });
    });

    it('should throw RequestObjectError when the signature does not verify', async () => {
      const request = await buildSigned(
        { scope: 'openid' },
        otherKeyPair.privateKey,
        kid,
      );

      await expect(
        parseRequestObject(request, {
          jwks,
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError when no JWK matches the kid', async () => {
      const request = await buildSigned(
        { scope: 'openid' },
        rsaKeyPair.privateKey,
        'no-such-kid',
      );

      await expect(
        parseRequestObject(request, {
          jwks,
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError when the alg is not supported', async () => {
      const request = await buildSigned(
        { scope: 'openid' },
        rsaKeyPair.privateKey,
        kid,
        'RS512',
      );

      await expect(
        parseRequestObject(request, {
          jwks,
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError when no JWKS is registered', async () => {
      const request = await buildSigned(
        { scope: 'openid' },
        rsaKeyPair.privateKey,
        kid,
      );

      await expect(
        parseRequestObject(request, {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });
  });

  describe('unsigned request objects (alg=none)', () => {
    it('should return the payload claims when allowUnsigned is enabled', async () => {
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment({
        scope: 'openid',
        nonce: 'n1',
      })}.`;

      const claims = await parseRequestObject(request, {
        supportedSigningAlgs: ['RS256'],
        allowUnsigned: true,
      });

      expect(claims).toEqual({ scope: 'openid', nonce: 'n1' });
    });

    it('should throw RequestObjectError when allowUnsigned is disabled', async () => {
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment({
        scope: 'openid',
      })}.`;

      await expect(
        parseRequestObject(request, {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: false,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError when an alg=none object carries a signature', async () => {
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment({
        scope: 'openid',
      })}.AAAA`;

      await expect(
        parseRequestObject(request, {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: true,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });
  });

  describe('malformed request objects', () => {
    it('should throw RequestObjectError for a non-JWS string', async () => {
      await expect(
        parseRequestObject('not-a-jwt', {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: true,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError for a JWE (5-segment) serialization', async () => {
      await expect(
        parseRequestObject('a.b.c.d.e', {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: true,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });

    it('should throw RequestObjectError when the payload is not a JSON object', async () => {
      const request = `${encodeSegment({ alg: 'none' })}.${encodeSegment([
        'not',
        'an',
        'object',
      ])}.`;

      await expect(
        parseRequestObject(request, {
          supportedSigningAlgs: ['RS256'],
          allowUnsigned: true,
        }),
      ).rejects.toBeInstanceOf(RequestObjectError);
    });
  });
});

// OIDC Core 1.0 §6.2 (Passing a Request Object by Reference): the request_uri
// is an https URL (loopback http for development), of at most 512 ASCII
// characters, and, when the OP requires pre-registration, one of the
// request_uris the client registered (OIDC Dynamic Client Registration 1.0 §2).
describe('validateRequestUri', () => {
  const REGISTERED = 'https://rp.example.com/requests/abc#NjYzYWI';

  describe('syntax', () => {
    it('should accept a registered https request_uri with its fragment', () => {
      expect(validateRequestUri(REGISTERED, { registeredRequestUris: [REGISTERED] })).toBe(REGISTERED);
    });

    it('should accept a loopback http request_uri', () => {
      const uri = 'http://127.0.0.1:3020/request-objects/1';

      expect(validateRequestUri(uri, { requireRegistration: false })).toBe(uri);
    });

    it.each([
      ['a non-loopback http URL', 'http://rp.example.com/requests/abc', 'request_uri must use the https scheme'],
      ['a URN', 'urn:ietf:params:oauth:request_uri:abc', 'request_uri must use the https scheme'],
      ['a relative URL', '/requests/abc', 'request_uri must be an absolute URL'],
      ['a URL with credentials', 'https://user:pw@rp.example.com/requests', 'request_uri must not carry credentials'],
      ['a URL with a space', 'https://rp.example.com/requests/a b', 'request_uri must consist of visible ASCII characters'],
      ['a URL with a non-ASCII character', 'https://rp.example.com/requests/é', 'request_uri must consist of visible ASCII characters'],
      ['an empty string', '', 'request_uri must be a non-empty string'],
      ['a non-string value', 42, 'request_uri must be a non-empty string'],
    ])('should reject %s', (_label, value, message) => {
      expect(() => validateRequestUri(value, { requireRegistration: false })).toThrowError(
        new RequestUriError(message),
      );
    });

    it('should accept a request_uri of exactly 512 characters and reject 513', () => {
      const base = 'https://rp.example.com/';
      const ok = base + 'a'.repeat(512 - base.length);
      const tooLong = ok + 'a';

      expect(validateRequestUri(ok, { requireRegistration: false })).toBe(ok);
      expect(() => validateRequestUri(tooLong, { requireRegistration: false })).toThrowError(
        new RequestUriError('request_uri must not exceed 512 ASCII characters'),
      );
    });
  });

  describe('registration (require_request_uri_registration)', () => {
    it('should require registration by default', () => {
      expect(() => validateRequestUri(REGISTERED)).toThrowError(
        new RequestUriError('request_uri is not registered for this client'),
      );
    });

    it('should match the registered value exactly, fragment included', () => {
      expect(() =>
        validateRequestUri('https://rp.example.com/requests/abc', { registeredRequestUris: [REGISTERED] }),
      ).toThrowError(new RequestUriError('request_uri is not registered for this client'));
      expect(() =>
        validateRequestUri(`${REGISTERED}x`, { registeredRequestUris: [REGISTERED] }),
      ).toThrowError(new RequestUriError('request_uri is not registered for this client'));
    });

    it('should accept an unregistered request_uri when registration is not required', () => {
      expect(validateRequestUri(REGISTERED, { registeredRequestUris: [], requireRegistration: false })).toBe(
        REGISTERED,
      );
    });
  });
});

// OIDC Core 1.0 §6.2.3: the OP sends an HTTP GET to the request_uri and uses
// the retrieved Request Object.
describe('fetchRequestObjectByReference', () => {
  const REQUEST_URI = 'https://rp.example.com/requests/abc#NjYzYWI';

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

  it('should GET the request_uri without its fragment and return the trimmed body', async () => {
    const { fetch, calls } = fetchStub(() => new Response('  a.b.c\n', { status: 200 }));

    const requestObject = await fetchRequestObjectByReference(REQUEST_URI, { fetch });

    expect(requestObject).toBe('a.b.c');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://rp.example.com/requests/abc');
    expect(calls[0]?.init.method).toBe('GET');
    // Registered URLs only: a redirect is never followed.
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect((calls[0]?.init.headers as Record<string, string>)['Accept']).toBe(
      'application/oauth-authz-req+jwt, application/jwt, application/jose;q=0.9, text/plain;q=0.8, */*;q=0.5',
    );
  });

  it.each([
    ['a 404', new Response('not found', { status: 404 })],
    ['a redirect', new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.com/' } })],
  ])('should reject %s with a fixed description', async (_label, response) => {
    const { fetch } = fetchStub(() => response);

    await expect(fetchRequestObjectByReference(REQUEST_URI, { fetch })).rejects.toThrowError(
      new RequestUriError('request_uri did not return 200 OK'),
    );
  });

  it('should reject an empty body', async () => {
    const { fetch } = fetchStub(() => new Response('  \n', { status: 200 }));

    await expect(fetchRequestObjectByReference(REQUEST_URI, { fetch })).rejects.toThrowError(
      new RequestUriError('request_uri returned no content'),
    );
  });

  it('should reject a body over maxBytes without reading it to the end', async () => {
    let chunksRead = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(100)));
      },
    });
    const { fetch } = fetchStub(() => new Response(stream, { status: 200 }));

    await expect(fetchRequestObjectByReference(REQUEST_URI, { fetch, maxBytes: 250 })).rejects.toThrowError(
      new RequestUriError('request_uri content exceeds the maximum size'),
    );
    expect(chunksRead).toBeLessThanOrEqual(4);
  });

  it('should reject a Content-Length over maxBytes before reading the body', async () => {
    const { fetch } = fetchStub(
      () => new Response('a.b.c', { status: 200, headers: { 'Content-Length': '100000' } }),
    );

    await expect(fetchRequestObjectByReference(REQUEST_URI, { fetch, maxBytes: 1024 })).rejects.toThrowError(
      new RequestUriError('request_uri content exceeds the maximum size'),
    );
  });

  it('should accept a body of exactly maxBytes', async () => {
    const body = 'a'.repeat(64);
    const { fetch } = fetchStub(() => new Response(body, { status: 200 }));

    expect(await fetchRequestObjectByReference(REQUEST_URI, { fetch, maxBytes: 64 })).toBe(body);
  });

  it('should turn a network failure into a RequestUriError without reflecting it', async () => {
    const { fetch } = fetchStub(() => {
      throw new TypeError('getaddrinfo ENOTFOUND rp.example.com');
    });

    await expect(fetchRequestObjectByReference(REQUEST_URI, { fetch })).rejects.toThrowError(
      new RequestUriError('request_uri could not be retrieved'),
    );
  });

  it('should abort the retrieval after timeoutMs', async () => {
    const { fetch } = fetchStub(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    await expect(fetchRequestObjectByReference(REQUEST_URI, { fetch, timeoutMs: 10 })).rejects.toThrowError(
      new RequestUriError('request_uri could not be retrieved'),
    );
  });
});
