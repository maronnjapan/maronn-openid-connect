/**
 * Request Object の参照渡し（request_uri。OIDC Core 1.0 §6.2 / RFC 9101 §5.2）のテスト。
 */
import { describe, expect, it, vi } from 'vitest';
import { AuthorizationError, rejectUnsupportedRequestParams } from './authorization-request.js';
import {
  DEFAULT_REQUEST_URI_OPTIONS,
  RequestUriError,
  fetchRequestObjectByReference,
  isRequestUriError,
  matchesRegisteredRequestUri,
  requestUriFetchUrl,
  resolveRequestUriParams,
  validateRequestUri,
} from './request-uri.js';

const REQUEST_URI = 'https://rp.example.com/request-objects/1#hash-of-content';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJjbGllbnQtMSJ9.c2lnbmF0dXJl';
const PARAMS = { client_id: 'client-1', response_type: 'code', scope: 'openid', request_uri: REQUEST_URI };

/** A fetch that answers every request with `response` and records the requests. */
function stubFetch(response: () => Response) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response());
}

describe('DEFAULT_REQUEST_URI_OPTIONS', () => {
  // RFC 9101 §5.2: a request_uri SHOULD NOT exceed 512 ASCII characters.
  it('should limit request_uri to 512 characters, wait 3 seconds and read at most 64 KiB', () => {
    expect(DEFAULT_REQUEST_URI_OPTIONS).toEqual({ maxLength: 512, timeoutMs: 3000, maxBytes: 65536 });
  });
});

describe('validateRequestUri', () => {
  it('should return an https URL of a public host with a fragment as it is', () => {
    expect(validateRequestUri(REQUEST_URI)).toBe(REQUEST_URI);
  });

  it('should reject an http URL', () => {
    expect(() => validateRequestUri('http://rp.example.com/ro')).toThrowError(
      new RequestUriError('request_uri must be an absolute https URI of a public host'),
    );
  });

  // RFC 9101 §10.4.1: the OP must not fetch from its own network.
  it('should reject a loopback address', () => {
    expect(() => validateRequestUri('https://127.0.0.1/ro')).toThrowError(
      new RequestUriError('request_uri must be an absolute https URI of a public host'),
    );
  });

  it('should accept http on localhost when insecure request_uris are allowed', () => {
    expect(validateRequestUri('http://localhost:3020/ro', { allowInsecure: true })).toBe('http://localhost:3020/ro');
  });

  it('should reject a request_uri longer than the limit', () => {
    expect(() => validateRequestUri(`https://rp.example.com/${'a'.repeat(30)}`, { maxLength: 30 })).toThrowError(
      new RequestUriError('request_uri must be at most 30 characters'),
    );
  });

  it('should reject a relative URI', () => {
    expect(() => validateRequestUri('/request-objects/1')).toThrowError(
      new RequestUriError('request_uri must be an absolute https URI of a public host'),
    );
  });
});

describe('requestUriFetchUrl', () => {
  // RFC 3986 §3.5: the fragment is not sent.
  it('should drop the fragment', () => {
    expect(requestUriFetchUrl(REQUEST_URI)).toBe('https://rp.example.com/request-objects/1');
  });

  it('should return a URL without a fragment as it is', () => {
    expect(requestUriFetchUrl('https://rp.example.com/ro')).toBe('https://rp.example.com/ro');
  });
});

describe('matchesRegisteredRequestUri', () => {
  it('should match a registered value exactly, fragment included', () => {
    expect(matchesRegisteredRequestUri(REQUEST_URI, [REQUEST_URI])).toBe(true);
  });

  it('should not match a value whose fragment differs', () => {
    expect(matchesRegisteredRequestUri(REQUEST_URI, ['https://rp.example.com/request-objects/1#other'])).toBe(false);
  });
});

describe('fetchRequestObjectByReference', () => {
  it('should GET the URL without its fragment with Accept application/jwt and no redirects, and return the trimmed body', async () => {
    const fetch = stubFetch(() => new Response(`${JWT}\n`, { status: 200, headers: { 'Content-Type': 'application/jwt' } }));

    const body = await fetchRequestObjectByReference(REQUEST_URI, { fetch });

    expect(body).toBe(JWT);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://rp.example.com/request-objects/1');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', headers: { Accept: 'application/jwt' }, redirect: 'manual' });
  });

  it('should reject a response other than 200', async () => {
    const fetch = stubFetch(() => new Response('not found', { status: 404 }));

    await expect(fetchRequestObjectByReference(REQUEST_URI, { fetch })).rejects.toThrowError(
      new RequestUriError('the request_uri answered HTTP 404'),
    );
  });

  it('should reject a redirect', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.com/' } }));

    await expect(fetchRequestObjectByReference(REQUEST_URI, { fetch })).rejects.toThrowError(
      new RequestUriError('the request_uri answered HTTP 302'),
    );
  });

  it('should reject a body over the limit', async () => {
    const fetch = stubFetch(() => new Response('x'.repeat(11), { status: 200 }));

    await expect(fetchRequestObjectByReference(REQUEST_URI, { fetch, maxBytes: 10 })).rejects.toThrowError(
      new RequestUriError('the request_uri document exceeds 10 bytes'),
    );
  });

  it('should reject an empty body', async () => {
    const fetch = stubFetch(() => new Response('  ', { status: 200 }));

    await expect(fetchRequestObjectByReference(REQUEST_URI, { fetch })).rejects.toThrowError(
      new RequestUriError('the request_uri document is empty'),
    );
  });

  it('should turn a failing fetch into a RequestUriError naming the failure', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.1');
    });

    await expect(fetchRequestObjectByReference(REQUEST_URI, { fetch })).rejects.toThrowError(
      new RequestUriError('the request_uri request failed (TypeError)'),
    );
  });

  it('should not fetch a URL the policy rejects', async () => {
    const fetch = stubFetch(() => new Response(JWT, { status: 200 }));

    await expect(fetchRequestObjectByReference('http://rp.example.com/ro', { fetch })).rejects.toBeInstanceOf(RequestUriError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('isRequestUriError', () => {
  it('should tell a RequestUriError from another error', () => {
    expect(isRequestUriError(new RequestUriError('x'))).toBe(true);
    expect(isRequestUriError(new Error('x'))).toBe(false);
  });
});

describe('resolveRequestUriParams', () => {
  it('should return a copy of the parameters without loading when there is no request_uri', async () => {
    const load = vi.fn();
    const params = { client_id: 'client-1', response_type: 'code' };

    const resolved = await resolveRequestUriParams(params, { load });

    expect(resolved).toEqual(params);
    expect(load).not.toHaveBeenCalled();
  });

  // OIDC Core 1.0 §6.2: the fetched Request Object takes the place of request_uri.
  it('should replace request_uri with the fetched Request Object as request', async () => {
    const load = vi.fn(async () => JWT);

    const resolved = await resolveRequestUriParams(PARAMS, { load });

    expect(resolved).toEqual({ client_id: 'client-1', response_type: 'code', scope: 'openid', request: JWT });
    expect(load).toHaveBeenCalledWith(REQUEST_URI);
  });

  // OIDC Core 1.0 §6.2 / RFC 9101 §5: request and request_uri must not be combined.
  it('should reject request together with request_uri without redirecting', async () => {
    const resolving = resolveRequestUriParams({ ...PARAMS, request: JWT }, { load: async () => JWT });

    await expect(resolving).rejects.toBeInstanceOf(AuthorizationError);
    await expect(resolving).rejects.toMatchObject({
      error: 'invalid_request',
      errorDescription: 'request and request_uri must not be used together',
      redirectable: false,
    });
  });

  // OIDC Discovery 1.0 §3: require_request_uri_registration.
  it('should reject a request_uri the client did not register without loading it', async () => {
    const load = vi.fn(async () => JWT);

    await expect(
      resolveRequestUriParams(PARAMS, { load, registeredRequestUris: ['https://rp.example.com/request-objects/2'] }),
    ).rejects.toMatchObject({ error: 'invalid_request_uri', errorDescription: 'request_uri is not registered for the client' });
    expect(load).not.toHaveBeenCalled();
  });

  it('should load a request_uri the client registered', async () => {
    const resolved = await resolveRequestUriParams(PARAMS, { load: async () => JWT, registeredRequestUris: [REQUEST_URI] });

    expect(resolved.request).toBe(JWT);
  });

  // The reason of a failed fetch is not disclosed.
  it('should turn a failed fetch into invalid_request_uri with a fixed message', async () => {
    const load = async (): Promise<string> => {
      throw new RequestUriError('the request_uri answered HTTP 500');
    };

    await expect(resolveRequestUriParams(PARAMS, { load })).rejects.toMatchObject({
      error: 'invalid_request_uri',
      errorDescription: 'the request_uri could not be retrieved',
      redirectable: false,
    });
  });
});

describe('rejectUnsupportedRequestParams with request_uri', () => {
  it('should reject a request_uri that is still present with request_uri_not_supported', () => {
    expect(() => rejectUnsupportedRequestParams({ request_uri: REQUEST_URI }, 'https://rp.example.com/cb')).toThrowError(
      expect.objectContaining({ error: 'request_uri_not_supported' }),
    );
  });

  it('should reject request_uri with request_uri_not_supported even when request is supported', () => {
    expect(() =>
      rejectUnsupportedRequestParams({ request: JWT, request_uri: REQUEST_URI }, 'https://rp.example.com/cb', 'st', {
        requestParameterSupported: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        error: 'request_uri_not_supported',
        errorDescription: 'request_uri parameter (Request Object by reference) is not supported',
        redirectUri: 'https://rp.example.com/cb',
        state: 'st',
      }),
    );
  });
});
