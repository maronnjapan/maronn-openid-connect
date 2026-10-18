import { AuthorizationError } from '@maronn-openid-connect/core';
import { PAR_REQUEST_URI_PREFIX } from '@maronn-openid-connect/experimental/par';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { parConfig } from '../config.js';
import { InMemoryPushedAuthorizationRequestStore } from '../store.js';
import { resolvePushedAuthorizationRequest } from './resolve-pushed-request.js';

const OPAQUE_FAILURE = 'The request_uri is invalid, expired, or has already been used';

const PUSHED_PARAMS = {
  client_id: 'client-1',
  response_type: 'code',
  redirect_uri: 'https://rp.example.com/callback',
  scope: 'openid',
};

function contextWithStore() {
  const parStore = new InMemoryPushedAuthorizationRequestStore();
  return { c: contextOf(undefined, { parStore }), parStore };
}

/** Save a pushed request as the par endpoint does, and return its request_uri. */
async function push(
  parStore: InMemoryPushedAuthorizationRequestStore,
  expiresAt = new Date(Date.now() + 60_000),
): Promise<string> {
  const requestUri = PAR_REQUEST_URI_PREFIX + crypto.randomUUID();
  await parStore.save({ requestUri, clientId: 'client-1', params: { ...PUSHED_PARAMS }, createdAt: new Date(), expiresAt });
  return requestUri;
}

function authorizationParams(params: Record<string, string>): AuthorizationRequestInput {
  return params as AuthorizationRequestInput;
}

describe('resolvePushedAuthorizationRequest', () => {
  describe('Requests Without a Pushed Request', () => {
    it('should return the parameters unchanged when the request carries no request_uri', async () => {
      const { c } = contextWithStore();
      const params = authorizationParams({ ...PUSHED_PARAMS });

      expect(await resolvePushedAuthorizationRequest(c, params)).toBe(params);
    });

    // OIDC Core 1.0 §6.2: a URL request_uri is left to the pipeline (request_uri_not_supported).
    it('should leave a request_uri that is not a PAR URN to the pipeline', async () => {
      const { c } = contextWithStore();
      const params = authorizationParams({ client_id: 'client-1', request_uri: 'https://rp.example.com/request.jwt' });

      expect(await resolvePushedAuthorizationRequest(c, params)).toBe(params);
    });
  });

  describe('Pushed Requests', () => {
    // RFC 9126 §4: the authorization endpoint answers the pushed parameters.
    it('should expand a pushed request_uri into the pushed parameters', async () => {
      const { c, parStore } = contextWithStore();
      const requestUri = await push(parStore);

      const resolved = await resolvePushedAuthorizationRequest(
        c,
        authorizationParams({ client_id: 'client-1', request_uri: requestUri }),
      );

      expect(resolved).toEqual(PUSHED_PARAMS);
    });

    // RFC 9126 §7.3: a request_uri is single use. Without a resolved request there
    // is no verified redirect_uri, so the error stays on the OP (no redirectUri).
    it('should reject a request_uri that was already used with a non-redirectable invalid_request_uri', async () => {
      const { c, parStore } = contextWithStore();
      const requestUri = await push(parStore);
      const params = authorizationParams({ client_id: 'client-1', request_uri: requestUri });
      await resolvePushedAuthorizationRequest(c, params);

      const replay = resolvePushedAuthorizationRequest(c, params);

      await expect(replay).rejects.toBeInstanceOf(AuthorizationError);
      await expect(replay).rejects.toMatchObject({
        error: 'invalid_request_uri',
        errorDescription: OPAQUE_FAILURE,
        redirectable: false,
      });
    });

    // RFC 9126 §2.2: the request_uri is bound to the client that pushed the request.
    it('should reject a request_uri pushed by another client with the same invalid_request_uri', async () => {
      const { c, parStore } = contextWithStore();
      const requestUri = await push(parStore);

      await expect(
        resolvePushedAuthorizationRequest(c, authorizationParams({ client_id: 'client-2', request_uri: requestUri })),
      ).rejects.toMatchObject({ error: 'invalid_request_uri', errorDescription: OPAQUE_FAILURE, redirectable: false });
    });

    // RFC 9126 §4: an expired request_uri MUST be rejected as invalid.
    it('should reject an expired request_uri with the same invalid_request_uri', async () => {
      const { c, parStore } = contextWithStore();
      const requestUri = await push(parStore, new Date(Date.now() - 1000));

      await expect(
        resolvePushedAuthorizationRequest(c, authorizationParams({ client_id: 'client-1', request_uri: requestUri })),
      ).rejects.toMatchObject({ error: 'invalid_request_uri', errorDescription: OPAQUE_FAILURE, redirectable: false });
    });
  });

  // RFC 9126 §5: require_pushed_authorization_requests.
  describe('When Pushed Authorization Requests Are Required', () => {
    beforeEach(() => {
      parConfig.requirePushedAuthorizationRequests = true;
    });
    afterEach(() => {
      parConfig.requirePushedAuthorizationRequests = false;
    });

    it('should reject a request that did not go through the par endpoint with invalid_request', async () => {
      const { c } = contextWithStore();

      await expect(
        resolvePushedAuthorizationRequest(c, authorizationParams({ ...PUSHED_PARAMS })),
      ).rejects.toMatchObject({
        error: 'invalid_request',
        errorDescription: 'Pushed authorization requests are required by this authorization server',
        redirectable: false,
      });
    });

    it('should still expand a pushed request_uri', async () => {
      const { c, parStore } = contextWithStore();
      const requestUri = await push(parStore);

      const resolved = await resolvePushedAuthorizationRequest(
        c,
        authorizationParams({ client_id: 'client-1', request_uri: requestUri }),
      );

      expect(resolved).toEqual(PUSHED_PARAMS);
    });
  });
});
