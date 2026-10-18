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

afterEach(() => {
  config.allowUnsignedRequestObject = defaultAllowUnsigned;
  vi.restoreAllMocks();
});

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
