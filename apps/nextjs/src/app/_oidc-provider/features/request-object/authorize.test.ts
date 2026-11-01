import {
  AuthorizationError,
  type AuthorizationRequestParams,
  type ClientInfo,
  type Jwk,
} from '@maronn-openid-connect/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signRs256Jwt, unsignedJwt } from '../../../../test-support/jwt';
import { rs256Key } from '../../../../test-support/keys';
import { createDatabase, registerClient } from '../../db';
import { clientKeyResolver, config } from '../../provider';
import { resolveRequestObject } from './authorize';
import { requestObjectConfig } from './config';

// provider.ts reads the clients' keys from the key-value store of db/ (in
// memory for the tests, vitest.config.ts), so the clients are registered there.

const REDIRECT_URI = 'https://rp.example.com/callback';

const QUERY = { client_id: 'ro-client', response_type: 'code', scope: 'openid', state: 'query-state' };
const CLAIMS = {
  iss: 'ro-client',
  aud: 'https://op.example.com',
  client_id: 'ro-client',
  response_type: 'code',
  redirect_uri: REDIRECT_URI,
  scope: 'openid profile',
  state: 'ro-state',
  nonce: 'nonce-1',
};

const defaultAllowUnsigned = config.allowUnsignedRequestObject;
const defaultRequireRegistration = config.requireRequestUriRegistration;

afterEach(() => {
  config.allowUnsignedRequestObject = defaultAllowUnsigned;
  config.requireRequestUriRegistration = defaultRequireRegistration;
  requestObjectConfig.requestUriFetch = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const REQUEST_URI = 'https://rp.example.com/requests/abc#NjYzYWI';

/** A fetch that answers every GET with the given body, recording the URLs. */
function fetchStub(body: string | (() => Response)): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const stub = (async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    return typeof body === 'string' ? new Response(body, { status: 200 }) : body();
  }) as typeof fetch;
  return { fetch: stub, urls };
}

/** Register a client, with an RS256 key of the request_object purpose unless registerKeys is false. */
async function registerRequestObjectClient(clientId: string, registerKeys = true): Promise<ClientInfo> {
  const clientKey = await rs256Key('ro-client-key');
  await registerClient(createDatabase(), {
    clientId,
    redirectUris: [REDIRECT_URI],
    ...(registerKeys ? { keys: { request_object: { keys: [clientKey.publicJwk as Jwk] } } } : {}),
  });
  return { clientId, redirectUris: [REDIRECT_URI] };
}

function paramsWith(request?: string, requestUri?: string): AuthorizationRequestParams {
  return {
    ...QUERY,
    ...(request === undefined ? {} : { request }),
    ...(requestUri === undefined ? {} : { request_uri: requestUri }),
  } as AuthorizationRequestParams;
}

describe('resolveRequestObject', () => {
  it('should return a copy of the query parameters without reading keys when there is no request parameter', async () => {
    const findClientKeys = vi.spyOn(clientKeyResolver, 'findClientKeys');
    const params = paramsWith();

    const resolved = await resolveRequestObject(params, { clientId: 'ro-client', redirectUris: [REDIRECT_URI] });

    expect(resolved).toEqual({ effectiveParams: QUERY });
    expect(resolved.effectiveParams).not.toBe(params);
    expect(findClientKeys).not.toHaveBeenCalled();
  });

  // OIDC Core 1.0 §6.1 / §6.3.2: verified with the keys the client registered for
  // request_object; its claims supersede the query parameters.
  it('should overlay the claims of a Request Object signed with a registered key', async () => {
    const client = await registerRequestObjectClient('ro-client');
    const findClientKeys = vi.spyOn(clientKeyResolver, 'findClientKeys');
    const request = await signRs256Jwt(CLAIMS, await rs256Key('ro-client-key'));

    const resolved = await resolveRequestObject(paramsWith(request), client);

    expect(resolved).toEqual({
      effectiveParams: {
        client_id: 'ro-client',
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        scope: 'openid profile',
        state: 'ro-state',
        nonce: 'nonce-1',
        request,
      },
      requestObjectClaims: CLAIMS,
    });
    expect(findClientKeys).toHaveBeenCalledWith('ro-client', 'request_object');
  });

  // OIDC Core 1.0 §6.3: an unverifiable Request Object is invalid_request_object,
  // and its redirect_uri is not trusted (no redirect).
  it('should reject a Request Object signed with a key the client did not register', async () => {
    const client = await registerRequestObjectClient('ro-client-other-key');
    const request = await signRs256Jwt(CLAIMS, await rs256Key('ro-unregistered-key'));

    const resolving = resolveRequestObject(paramsWith(request), client);

    await expect(resolving).rejects.toBeInstanceOf(AuthorizationError);
    await expect(resolving).rejects.toMatchObject({
      error: 'invalid_request_object',
      errorDescription: 'no JWK matched the request object header (kid)',
      redirectable: false,
    });
  });

  it('should reject a signed Request Object of a client that registered no request_object keys', async () => {
    const client = await registerRequestObjectClient('ro-client-without-keys', false);
    const request = await signRs256Jwt(CLAIMS, await rs256Key('ro-client-key'));

    await expect(resolveRequestObject(paramsWith(request), client)).rejects.toMatchObject({
      error: 'invalid_request_object',
      errorDescription: 'no JWKS registered to verify the request object signature',
      redirectable: false,
    });
  });

  // OIDC Core 1.0 §6.2: the request_uri is matched against the request_uris the
  // client registered, fetched with a GET, and the retrieved JWT is verified
  // like one passed by value.
  describe('Request Objects by reference (request_uri)', () => {
    it('should fetch a registered request_uri with requestObjectConfig.requestUriFetch and overlay the retrieved claims', async () => {
      const client = await registerRequestObjectClient('ro-client');
      const { fetch, urls } = fetchStub(await signRs256Jwt(CLAIMS, await rs256Key('ro-client-key')));
      requestObjectConfig.requestUriFetch = fetch;

      const resolved = await resolveRequestObject(paramsWith(undefined, REQUEST_URI), { ...client, requestUris: [REQUEST_URI] });

      // The fragment is a cache key for the OP (§6.2), not part of the resource.
      expect(urls).toEqual(['https://rp.example.com/requests/abc']);
      expect(resolved).toEqual({
        effectiveParams: {
          client_id: 'ro-client',
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          scope: 'openid profile',
          state: 'ro-state',
          nonce: 'nonce-1',
          request_uri: REQUEST_URI,
        },
        requestObjectClaims: CLAIMS,
      });
    });

    it('should fetch with globalThis.fetch while requestUriFetch is unset', async () => {
      const client = await registerRequestObjectClient('ro-client');
      const { fetch, urls } = fetchStub(await signRs256Jwt(CLAIMS, await rs256Key('ro-client-key')));
      vi.stubGlobal('fetch', fetch);

      const resolved = await resolveRequestObject(paramsWith(undefined, REQUEST_URI), { ...client, requestUris: [REQUEST_URI] });

      expect(urls).toEqual(['https://rp.example.com/requests/abc']);
      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
    });

    // OIDC Core 1.0 §3.1.2.6: invalid_request_uri, kept on the OP.
    it('should reject a request_uri the client did not register with a non-redirectable invalid_request_uri without fetching it', async () => {
      const client = await registerRequestObjectClient('ro-client');
      const { fetch, urls } = fetchStub('never');
      requestObjectConfig.requestUriFetch = fetch;

      const resolving = resolveRequestObject(paramsWith(undefined, REQUEST_URI), client);

      await expect(resolving).rejects.toBeInstanceOf(AuthorizationError);
      await expect(resolving).rejects.toMatchObject({
        error: 'invalid_request_uri',
        errorDescription: 'request_uri is not registered for this client',
        redirectable: false,
      });
      expect(urls).toEqual([]);
    });

    it('should fetch an unregistered request_uri when requireRequestUriRegistration is off', async () => {
      config.requireRequestUriRegistration = false;
      const client = await registerRequestObjectClient('ro-client');
      const { fetch, urls } = fetchStub(await signRs256Jwt(CLAIMS, await rs256Key('ro-client-key')));
      requestObjectConfig.requestUriFetch = fetch;

      const resolved = await resolveRequestObject(paramsWith(undefined, REQUEST_URI), client);

      expect(urls).toEqual(['https://rp.example.com/requests/abc']);
      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
    });

    it('should reject a request_uri that does not return the Request Object with invalid_request_uri', async () => {
      const client = await registerRequestObjectClient('ro-client');
      requestObjectConfig.requestUriFetch = fetchStub(() => new Response('gone', { status: 404 })).fetch;

      await expect(
        resolveRequestObject(paramsWith(undefined, REQUEST_URI), { ...client, requestUris: [REQUEST_URI] }),
      ).rejects.toMatchObject({
        error: 'invalid_request_uri',
        errorDescription: 'request_uri did not return 200 OK',
        redirectable: false,
      });
    });

    it('should reject a retrieved Request Object signed with a key the client did not register', async () => {
      const client = await registerRequestObjectClient('ro-client');
      requestObjectConfig.requestUriFetch = fetchStub(await signRs256Jwt(CLAIMS, await rs256Key('ro-unregistered-key'))).fetch;

      await expect(
        resolveRequestObject(paramsWith(undefined, REQUEST_URI), { ...client, requestUris: [REQUEST_URI] }),
      ).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'no JWK matched the request object header (kid)',
        redirectable: false,
      });
    });

    it('should reject a request carrying both request and request_uri with invalid_request', async () => {
      const client = await registerRequestObjectClient('ro-client');
      const { fetch, urls } = fetchStub('never');
      requestObjectConfig.requestUriFetch = fetch;
      const request = await signRs256Jwt(CLAIMS, await rs256Key('ro-client-key'));

      await expect(
        resolveRequestObject(paramsWith(request, REQUEST_URI), { ...client, requestUris: [REQUEST_URI] }),
      ).rejects.toMatchObject({
        error: 'invalid_request',
        errorDescription: 'request and request_uri must not both be present',
        redirectable: false,
      });
      expect(urls).toEqual([]);
    });
  });

  // OIDC Dynamic Client Registration 1.0 §2: a client registered with
  // request_object_signing_alg is held to that alg.
  describe('request_object_signing_alg of the client', () => {
    it('should reject an unsigned Request Object of a client registered for RS256 even when unsigned ones are allowed', async () => {
      config.allowUnsignedRequestObject = true;
      const client = await registerRequestObjectClient('ro-client');

      await expect(
        resolveRequestObject(paramsWith(unsignedJwt(CLAIMS)), { ...client, requestObjectSigningAlg: 'RS256' }),
      ).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'unsigned request object (alg=none) is not supported',
      });
    });

    it('should accept only unsigned Request Objects of a client registered for none', async () => {
      config.allowUnsignedRequestObject = true;
      const client = { ...(await registerRequestObjectClient('ro-client')), requestObjectSigningAlg: 'none' };

      const resolved = await resolveRequestObject(paramsWith(unsignedJwt(CLAIMS)), client);

      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
      await expect(
        resolveRequestObject(paramsWith(await signRs256Jwt(CLAIMS, await rs256Key('ro-client-key'))), client),
      ).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'unsupported request object signing alg: RS256',
      });
    });
  });

  describe('Unsigned Request Objects', () => {
    // OIDC Core 1.0 §6.1: signed Request Objects only, by default (allowUnsignedRequestObject: false).
    it('should reject an unsigned Request Object by default', async () => {
      const client = await registerRequestObjectClient('ro-client');

      await expect(resolveRequestObject(paramsWith(unsignedJwt(CLAIMS)), client)).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'unsigned request object (alg=none) is not supported',
      });
    });

    it('should accept an unsigned Request Object when allowUnsignedRequestObject is on', async () => {
      config.allowUnsignedRequestObject = true;
      const client = await registerRequestObjectClient('ro-client');
      const request = unsignedJwt(CLAIMS);

      const resolved = await resolveRequestObject(paramsWith(request), client);

      expect(resolved).toEqual({
        effectiveParams: {
          client_id: 'ro-client',
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          scope: 'openid profile',
          state: 'ro-state',
          nonce: 'nonce-1',
          request,
        },
        requestObjectClaims: CLAIMS,
      });
    });
  });
});
