import { AuthorizationError, type ClientInfo, type Jwk } from '@maronn-openid-connect/core';
import { describe, expect, it, vi } from 'vitest';
import { contextOf, providerContext } from '../../../../test-support/context.js';
import { signRs256Jwt, unsignedJwt } from '../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../test-support/keys.js';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { createProviderConfig, type ProviderConfig } from '../../../config.js';
import { registerClient } from '../../../db/memory/clients.js';
import { resolveRequestObject } from './resolve-request-object.js';

const REDIRECT_URI = 'https://rp.example.com/callback';
const client: ClientInfo = { clientId: 'ro-client', redirectUris: [REDIRECT_URI] };

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

async function contextWithClient(
  config: Partial<ProviderConfig> = {},
  registerKeys = true,
  requestUriFetch?: typeof fetch,
) {
  const context = await providerContext({ options: { config, requestUriFetch } });
  const clientKey = await rs256Key('ro-client-key');
  await registerClient(context.db, {
    clientId: 'ro-client',
    redirectUris: [REDIRECT_URI],
    ...(registerKeys ? { keys: { request_object: { keys: [clientKey.publicJwk as Jwk] } } } : {}),
  });
  return { ...context, clientKey };
}

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

function paramsWith(request?: string, requestUri?: string): AuthorizationRequestInput {
  return {
    ...QUERY,
    ...(request === undefined ? {} : { request }),
    ...(requestUri === undefined ? {} : { request_uri: requestUri }),
  } as AuthorizationRequestInput;
}

describe('resolveRequestObject', () => {
  it('should return a copy of the query parameters without reading keys when there is no request parameter', async () => {
    const findClientKeys = vi.fn();
    const c = contextOf(undefined, { config: createProviderConfig(), clientKeyResolver: { findClientKeys } });

    const resolved = await resolveRequestObject(c, paramsWith(), client);

    expect(resolved).toEqual({ effectiveParams: QUERY });
    expect(findClientKeys).not.toHaveBeenCalled();
  });

  // OIDC Core 1.0 §6.1 / §6.3.2: verified with the client's request_object keys;
  // its claims supersede the query parameters.
  it('should overlay the claims of a Request Object signed with a registered key', async () => {
    const { c, clientKey } = await contextWithClient();
    const request = await signRs256Jwt(CLAIMS, clientKey);

    const resolved = await resolveRequestObject(c, paramsWith(request), client);

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

  // OIDC Core 1.0 §6.3: an unverifiable Request Object is invalid_request_object,
  // and its redirect_uri is not trusted (no redirect).
  it('should reject a Request Object signed with a key the client did not register', async () => {
    const { c } = await contextWithClient();
    const request = await signRs256Jwt(CLAIMS, await rs256Key('ro-client-key-2'));

    const resolving = resolveRequestObject(c, paramsWith(request), client);

    await expect(resolving).rejects.toBeInstanceOf(AuthorizationError);
    await expect(resolving).rejects.toMatchObject({
      error: 'invalid_request_object',
      errorDescription: 'no JWK matched the request object header (kid)',
      redirectable: false,
    });
  });

  it('should reject a signed Request Object of a client that registered no request_object keys', async () => {
    const { c, clientKey } = await contextWithClient({}, false);
    const request = await signRs256Jwt(CLAIMS, clientKey);

    await expect(resolveRequestObject(c, paramsWith(request), client)).rejects.toMatchObject({
      error: 'invalid_request_object',
      errorDescription: 'no JWKS registered to verify the request object signature',
    });
  });

  // OIDC Core 1.0 §6.2: the request_uri is matched against the request_uris the
  // client registered, fetched with a GET, and the retrieved JWT is verified
  // like one passed by value.
  describe('Request Objects by reference (request_uri)', () => {
    const registered: ClientInfo = { ...client, requestUris: [REQUEST_URI] };

    it('should fetch a registered request_uri with the requestUriFetch of the options and overlay the retrieved claims', async () => {
      const { fetch, urls } = fetchStub('placeholder');
      const { c, clientKey } = await contextWithClient({}, true, fetch);
      const request = await signRs256Jwt(CLAIMS, clientKey);
      const { fetch: signedFetch, urls: signedUrls } = fetchStub(request);
      c.set('requestUriFetch', signedFetch);

      const resolved = await resolveRequestObject(c, paramsWith(undefined, REQUEST_URI), registered);

      expect(urls).toEqual([]);
      // The fragment is a cache key for the OP (§6.2), not part of the resource.
      expect(signedUrls).toEqual(['https://rp.example.com/requests/abc']);
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

    it('should fetch with globalThis.fetch when no requestUriFetch option is set', async () => {
      const { c, clientKey } = await contextWithClient();
      const { fetch, urls } = fetchStub(await signRs256Jwt(CLAIMS, clientKey));
      vi.stubGlobal('fetch', fetch);
      try {
        const resolved = await resolveRequestObject(c, paramsWith(undefined, REQUEST_URI), registered);

        expect(urls).toEqual(['https://rp.example.com/requests/abc']);
        expect(resolved.requestObjectClaims).toEqual(CLAIMS);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // OIDC Core 1.0 §3.1.2.6: invalid_request_uri, kept on the OP.
    it('should reject a request_uri the client did not register with a non-redirectable invalid_request_uri without fetching it', async () => {
      const { fetch, urls } = fetchStub('never');
      const { c } = await contextWithClient({}, true, fetch);

      const resolving = resolveRequestObject(c, paramsWith(undefined, REQUEST_URI), client);

      await expect(resolving).rejects.toBeInstanceOf(AuthorizationError);
      await expect(resolving).rejects.toMatchObject({
        error: 'invalid_request_uri',
        errorDescription: 'request_uri is not registered for this client',
        redirectable: false,
      });
      expect(urls).toEqual([]);
    });

    it('should fetch an unregistered request_uri when requireRequestUriRegistration is off', async () => {
      const { c, clientKey } = await contextWithClient({ requireRequestUriRegistration: false });
      const { fetch, urls } = fetchStub(await signRs256Jwt(CLAIMS, clientKey));
      c.set('requestUriFetch', fetch);

      const resolved = await resolveRequestObject(c, paramsWith(undefined, REQUEST_URI), client);

      expect(urls).toEqual(['https://rp.example.com/requests/abc']);
      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
    });

    it('should reject a request_uri that does not return the Request Object with invalid_request_uri', async () => {
      const { fetch } = fetchStub(() => new Response('gone', { status: 404 }));
      const { c } = await contextWithClient({}, true, fetch);

      await expect(resolveRequestObject(c, paramsWith(undefined, REQUEST_URI), registered)).rejects.toMatchObject({
        error: 'invalid_request_uri',
        errorDescription: 'request_uri did not return 200 OK',
        redirectable: false,
      });
    });

    it('should reject a retrieved Request Object signed with a key the client did not register', async () => {
      const { fetch } = fetchStub(await signRs256Jwt(CLAIMS, await rs256Key('ro-client-key-2')));
      const { c } = await contextWithClient({}, true, fetch);

      await expect(resolveRequestObject(c, paramsWith(undefined, REQUEST_URI), registered)).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'no JWK matched the request object header (kid)',
        redirectable: false,
      });
    });

    it('should reject a request carrying both request and request_uri with invalid_request', async () => {
      const { fetch, urls } = fetchStub('never');
      const { c, clientKey } = await contextWithClient({}, true, fetch);
      const request = await signRs256Jwt(CLAIMS, clientKey);

      await expect(resolveRequestObject(c, paramsWith(request, REQUEST_URI), registered)).rejects.toMatchObject({
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
      const { c } = await contextWithClient({ allowUnsignedRequestObject: true });

      await expect(
        resolveRequestObject(c, paramsWith(unsignedJwt(CLAIMS)), { ...client, requestObjectSigningAlg: 'RS256' }),
      ).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'unsigned request object (alg=none) is not supported',
      });
    });

    it('should accept only unsigned Request Objects of a client registered for none', async () => {
      const { c, clientKey } = await contextWithClient({ allowUnsignedRequestObject: true });
      const noneClient = { ...client, requestObjectSigningAlg: 'none' };

      const resolved = await resolveRequestObject(c, paramsWith(unsignedJwt(CLAIMS)), noneClient);

      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
      await expect(
        resolveRequestObject(c, paramsWith(await signRs256Jwt(CLAIMS, clientKey)), noneClient),
      ).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'unsupported request object signing alg: RS256',
      });
    });
  });

  describe('Unsigned Request Objects', () => {
    // OIDC Core 1.0 §6.1: signed Request Objects only, by default (allowUnsignedRequestObject: false).
    it('should reject an unsigned Request Object by default', async () => {
      const { c } = await contextWithClient();

      await expect(resolveRequestObject(c, paramsWith(unsignedJwt(CLAIMS)), client)).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'unsigned request object (alg=none) is not supported',
      });
    });

    it('should accept an unsigned Request Object when allowUnsignedRequestObject is on', async () => {
      const { c } = await contextWithClient({ allowUnsignedRequestObject: true });
      const request = unsignedJwt(CLAIMS);

      const resolved = await resolveRequestObject(c, paramsWith(request), client);

      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
      expect(resolved.effectiveParams).toMatchObject({ scope: 'openid profile', state: 'ro-state', nonce: 'nonce-1' });
    });
  });
});
