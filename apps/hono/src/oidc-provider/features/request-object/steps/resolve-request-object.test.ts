import {
  AuthorizationError,
  signJwt,
  type ClientInfo,
  type Jwk,
  type SigningKey,
} from '@maronn-openid-connect/core';
import { describe, expect, it, vi } from 'vitest';
import { contextOf, providerContext } from '../../../../test-support/context.js';
import { es256Key, signRs256Jwt, unsignedJwt } from '../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../test-support/keys.js';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { createProviderConfig, type ProviderConfig, type RegisteredClient } from '../../../config.js';
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

let jwksUriCount = 0;

/** The public JWK a jwks_uri publishes for a signing key. */
function publishedJwk(key: SigningKey): Record<string, unknown> {
  return { ...key.publicJwk, kid: key.keyId };
}

/**
 * A provider whose ClientKeyResolver hands out the keys of the jwks_uri of
 * ro-client (the default resolver of app.ts), fetched with a stub.
 */
async function contextWithJwksUriClient(
  input: { config?: Partial<ProviderConfig>; requestObjectSigningAlg?: string; published: SigningKey[][] },
) {
  jwksUriCount += 1;
  const context = await providerContext({ options: { config: input.config ?? {} } });
  await registerClient(context.db, {
    clientId: 'ro-client',
    redirectUris: [REDIRECT_URI],
    jwksUri: `https://rp-${jwksUriCount}.example.com/jwks.json`,
    ...(input.requestObjectSigningAlg === undefined ? {} : { requestObjectSigningAlg: input.requestObjectSigningAlg }),
  });
  const responses = [...input.published];
  const fetch = vi.fn(async () =>
    new Response(JSON.stringify({ keys: (responses.shift() ?? []).map(publishedJwk) }), { status: 200 }),
  );
  context.c.set('outboundFetch', fetch);
  return { ...context, fetch };
}

async function signEs256Jwt(payload: Record<string, unknown>, key: SigningKey): Promise<string> {
  return signJwt({ alg: 'ES256', kid: key.keyId }, payload, key.privateKey);
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

  // UC-1 / UC-2: RFC 7591 §2 jwks_uri, OIDC Core 1.0 §10.1.1.
  describe('Request Objects of a client with a jwks_uri', () => {
    it('should verify a Request Object with the keys of the jwks_uri of the client', async () => {
      const key = await rs256Key('ro-uri-key-1');
      const { c, fetch } = await contextWithJwksUriClient({ published: [[key]] });
      const request = await signRs256Jwt(CLAIMS, key);

      const resolved = await resolveRequestObject(c, paramsWith(request), client);

      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should fetch the jwks_uri again for the kid of a key the client added', async () => {
      const oldKey = await rs256Key('ro-uri-key-1');
      const newKey = await rs256Key('ro-uri-key-2');
      const { c, fetch } = await contextWithJwksUriClient({
        config: { clientJwksUriRefetchIntervalSeconds: 0 },
        published: [[oldKey], [oldKey, newKey]],
      });

      await resolveRequestObject(c, paramsWith(await signRs256Jwt(CLAIMS, oldKey)), client);
      const resolved = await resolveRequestObject(c, paramsWith(await signRs256Jwt(CLAIMS, newKey)), client);

      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    // UC-18
    it('should reject a Request Object signed with a key the jwks_uri does not publish', async () => {
      const { c } = await contextWithJwksUriClient({ published: [[await rs256Key('ro-uri-key-1')], []] });
      const request = await signRs256Jwt(CLAIMS, await rs256Key('ro-uri-key-unpublished'));

      await expect(resolveRequestObject(c, paramsWith(request), client)).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'no JWK matched the request object header (kid)',
        redirectable: false,
      });
    });
  });

  // UC-8 / UC-14: OIDC Core 1.0 §6.3.2.
  describe('request_object_signing_alg', () => {
    it('should accept an ES256 Request Object of a client that registered ES256', async () => {
      const key = await es256Key('ro-es256-key');
      const { c } = await contextWithJwksUriClient({ requestObjectSigningAlg: 'ES256', published: [[key]] });
      const registered: RegisteredClient = { ...client, requestObjectSigningAlg: 'ES256' };

      const resolved = await resolveRequestObject(c, paramsWith(await signEs256Jwt(CLAIMS, key)), registered);

      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
    });

    it('should reject an RS256 Request Object of a client that registered ES256 without fetching keys', async () => {
      const key = await rs256Key('ro-uri-key-1');
      const { c, fetch } = await contextWithJwksUriClient({ requestObjectSigningAlg: 'ES256', published: [[key]] });
      const registered: RegisteredClient = { ...client, requestObjectSigningAlg: 'ES256' };

      await expect(resolveRequestObject(c, paramsWith(await signRs256Jwt(CLAIMS, key)), registered)).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'request object alg does not match the registered request_object_signing_alg',
        redirectable: false,
      });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // UC-6 / D-20: the accepted algs are a setting.
  describe('requestObjectSigningAlgValuesSupported', () => {
    it('should accept an ES256 Request Object by default', async () => {
      const key = await es256Key('ro-es256-key');
      const { c } = await contextWithJwksUriClient({ published: [[key]] });

      const resolved = await resolveRequestObject(c, paramsWith(await signEs256Jwt(CLAIMS, key)), client);

      expect(resolved.requestObjectClaims).toEqual(CLAIMS);
    });

    it('should reject an alg left out of requestObjectSigningAlgValuesSupported', async () => {
      const key = await es256Key('ro-es256-key');
      const { c, fetch } = await contextWithJwksUriClient({
        config: { requestObjectSigningAlgValuesSupported: ['RS256'] },
        published: [[key]],
      });

      await expect(resolveRequestObject(c, paramsWith(await signEs256Jwt(CLAIMS, key)), client)).rejects.toMatchObject({
        error: 'invalid_request_object',
        errorDescription: 'unsupported request object signing alg: ES256',
      });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // UC-16 / D-14
  it('should reject a Request Object with a fixed message when the jwks_uri cannot be retrieved', async () => {
    const key = await rs256Key('ro-uri-key-1');
    const { c, fetch } = await contextWithJwksUriClient({ published: [] });
    fetch.mockImplementation(async () => new Response('not found', { status: 404 }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(resolveRequestObject(c, paramsWith(await signRs256Jwt(CLAIMS, key)), client)).rejects.toMatchObject({
      error: 'invalid_request_object',
      errorDescription: 'the client jwks_uri could not be retrieved',
      redirectable: false,
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
