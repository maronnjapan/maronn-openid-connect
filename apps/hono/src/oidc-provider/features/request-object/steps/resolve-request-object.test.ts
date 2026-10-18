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

async function contextWithClient(config: Partial<ProviderConfig> = {}, registerKeys = true) {
  const context = await providerContext({ options: { config } });
  const clientKey = await rs256Key('ro-client-key');
  await registerClient(context.db, {
    clientId: 'ro-client',
    redirectUris: [REDIRECT_URI],
    ...(registerKeys ? { keys: { request_object: { keys: [clientKey.publicJwk as Jwk] } } } : {}),
  });
  return { ...context, clientKey };
}

function paramsWith(request?: string): AuthorizationRequestInput {
  return (request === undefined ? { ...QUERY } : { ...QUERY, request }) as AuthorizationRequestInput;
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
