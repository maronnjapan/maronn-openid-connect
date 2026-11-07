import {
  AuthorizationError,
  signJwt,
  type AuthorizationRequestParams,
  type ClientInfo,
  type Jwk,
  type SigningKey,
} from '@maronn-openid-connect/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signRs256Jwt, unsignedJwt } from '../../../../test-support/jwt';
import { rs256Key } from '../../../../test-support/keys';
import type { RegisteredClient } from '../../config';
import { createDatabase, registerClient } from '../../db';
import { clientKeyResolver, config } from '../../provider';
import { fetchRequestUri, resolveRequestObject } from './authorize';

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

const defaults = {
  allowUnsignedRequestObject: config.allowUnsignedRequestObject,
  requestObjectSigningAlgValuesSupported: config.requestObjectSigningAlgValuesSupported,
  clientJwksUriRefetchIntervalSeconds: config.clientJwksUriRefetchIntervalSeconds,
};

afterEach(() => {
  Object.assign(config, defaults);
  vi.restoreAllMocks();
});

let jwksUriCount = 0;

/**
 * Register a client that publishes its keys at a jwks_uri of its own (the
 * cache of the process is shared by the tests), answered by a stub of fetch
 * with the key sets of published in turn.
 */
async function registerJwksUriClient(
  clientId: string,
  published: SigningKey[][],
  requestObjectSigningAlg?: string,
): Promise<{ client: RegisteredClient; fetch: ReturnType<typeof vi.spyOn> }> {
  jwksUriCount += 1;
  const jwksUri = `https://rp-${jwksUriCount}.example.com/jwks.json`;
  await registerClient(createDatabase(), {
    clientId,
    redirectUris: [REDIRECT_URI],
    jwksUri,
    ...(requestObjectSigningAlg === undefined ? {} : { requestObjectSigningAlg }),
  });
  const responses = [...published];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({ keys: (responses.shift() ?? []).map((key) => ({ ...key.publicJwk, kid: key.keyId })) }),
  );
  return {
    client: {
      clientId,
      redirectUris: [REDIRECT_URI],
      ...(requestObjectSigningAlg === undefined ? {} : { requestObjectSigningAlg }),
    },
    fetch,
  };
}

const es256Keys = new Map<string, Promise<SigningKey>>();

/** An ES256 key with the key id, generated once. */
function es256Key(keyId: string): Promise<SigningKey> {
  let key = es256Keys.get(keyId);
  if (!key) {
    key = (async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      return { privateKey: pair.privateKey, publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey), keyId };
    })();
    es256Keys.set(keyId, key);
  }
  return key;
}

function signEs256Jwt(payload: Record<string, unknown>, key: SigningKey): Promise<string> {
  return signJwt({ alg: 'ES256', kid: key.keyId }, payload, key.privateKey);
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

function paramsWith(request?: string): AuthorizationRequestParams {
  return (request === undefined ? { ...QUERY } : { ...QUERY, request }) as AuthorizationRequestParams;
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
    // OIDC Core 1.0 §10.1.1: the kid of the header goes along as the hint.
    expect(findClientKeys).toHaveBeenCalledWith('ro-client', 'request_object', { kid: 'ro-client-key' });
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

  // UC-1 / UC-2: RFC 7591 §2 jwks_uri, OIDC Core 1.0 §10.1.1.
  describe('Request Objects of a client with a jwks_uri', () => {
    it('should verify a Request Object with the keys of the jwks_uri of the client', async () => {
      const key = await rs256Key('ro-uri-key-1');
      const { client, fetch } = await registerJwksUriClient('ro-uri-client', [[key]]);

      const resolved = await resolveRequestObject(paramsWith(await signRs256Jwt(CLAIMS, key)), client);

      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should fetch the jwks_uri again for the kid of a key the client added', async () => {
      config.clientJwksUriRefetchIntervalSeconds = 0;
      const oldKey = await rs256Key('ro-uri-key-1');
      const newKey = await rs256Key('ro-uri-key-2');
      const { client, fetch } = await registerJwksUriClient('ro-uri-client', [[oldKey], [oldKey, newKey]]);

      await resolveRequestObject(paramsWith(await signRs256Jwt(CLAIMS, oldKey)), client);
      const resolved = await resolveRequestObject(paramsWith(await signRs256Jwt(CLAIMS, newKey)), client);

      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    // UC-16 / D-14
    it('should reject a Request Object with a fixed message when the jwks_uri cannot be retrieved', async () => {
      const { client, fetch } = await registerJwksUriClient('ro-uri-client', []);
      fetch.mockImplementation(async () => new Response('not found', { status: 404 }));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(
        resolveRequestObject(paramsWith(await signRs256Jwt(CLAIMS, await rs256Key('ro-uri-key-1'))), client),
      ).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'the client jwks_uri could not be retrieved',
        redirectable: false,
      });
    });
  });

  // UC-8 / UC-14: OIDC Core 1.0 §6.3.2.
  describe('request_object_signing_alg', () => {
    it('should accept an ES256 Request Object of a client that registered ES256', async () => {
      const key = await es256Key('ro-es256-key');
      const { client } = await registerJwksUriClient('ro-es256-client', [[key]], 'ES256');

      const resolved = await resolveRequestObject(paramsWith(await signEs256Jwt(CLAIMS, key)), client);

      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
    });

    it('should reject an RS256 Request Object of a client that registered ES256 without fetching keys', async () => {
      const key = await rs256Key('ro-uri-key-1');
      const { client, fetch } = await registerJwksUriClient('ro-es256-client', [[key]], 'ES256');

      await expect(resolveRequestObject(paramsWith(await signRs256Jwt(CLAIMS, key)), client)).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'request object alg does not match the registered request_object_signing_alg',
        redirectable: false,
      });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // UC-6 / D-20: the accepted algs are a setting.
  it('should reject an alg left out of requestObjectSigningAlgValuesSupported', async () => {
    config.requestObjectSigningAlgValuesSupported = ['RS256'];
    const key = await es256Key('ro-es256-key');
    const { client, fetch } = await registerJwksUriClient('ro-es256-client', [[key]]);

    await expect(resolveRequestObject(paramsWith(await signEs256Jwt(CLAIMS, key)), client)).rejects.toMatchObject({
      error: 'invalid_request_object',
      errorDescription: 'unsupported request object signing alg: ES256',
    });
    expect(fetch).not.toHaveBeenCalled();
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

// OIDC Core 1.0 §6.2: the Request Object of a request_uri, fetched with
// globalThis.fetch (provider.ts sets no outboundFetch).
describe('fetchRequestUri', () => {
  const REQUEST_URI = 'https://rp.example.com/request-objects/1#content-hash';
  const JWT = 'eyJhbGciOiJub25lIn0.eyJpc3MiOiJyby1jbGllbnQifQ.';
  const roClient: RegisteredClient = { clientId: 'ro-client', redirectUris: [REDIRECT_URI] };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return the parameters as they are when there is no request_uri', async () => {
    const params: AuthorizationRequestParams = { ...QUERY };

    expect(await fetchRequestUri(params, roClient)).toBe(params);
  });

  it('should fetch the request_uri without its fragment and put the Request Object into request', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JWT, { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const resolved = await fetchRequestUri({ ...QUERY, request_uri: REQUEST_URI }, roClient);

    expect(resolved).toEqual({ ...QUERY, request: JWT });
    expect(fetch.mock.calls.map(([input]) => input)).toEqual(['https://rp.example.com/request-objects/1']);
  });

  it('should answer invalid_request_uri without redirecting when the request_uri cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const resolving = fetchRequestUri({ ...QUERY, request_uri: REQUEST_URI }, roClient);

    await expect(resolving).rejects.toBeInstanceOf(AuthorizationError);
    await expect(resolving).rejects.toMatchObject({
      error: 'invalid_request_uri',
      errorDescription: 'the request_uri could not be retrieved',
      redirectable: false,
    });
  });
});
