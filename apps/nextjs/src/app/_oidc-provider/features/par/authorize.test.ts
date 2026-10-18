import { AuthorizationError, type AuthorizationRequestParams } from '@maronn-openid-connect/core';
import { PAR_REQUEST_URI_PREFIX } from '@maronn-openid-connect/experimental/par';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePushedAuthorizationRequest } from './authorize';
import { parConfig } from './config';
import { parStore } from './store';

const OPAQUE_FAILURE = 'The request_uri is invalid, expired, or has already been used';
const defaults = { ...parConfig };

const PUSHED_PARAMS = {
  client_id: 'client-1',
  response_type: 'code',
  redirect_uri: 'https://rp.example.com/callback',
  scope: 'openid',
  state: 'state-1',
};

afterEach(() => {
  Object.assign(parConfig, defaults);
  vi.restoreAllMocks();
});

type AuthorizationRequestInput = Record<string, string> & AuthorizationRequestParams;

function authorizationParams(params: Record<string, string>): AuthorizationRequestInput {
  return params as AuthorizationRequestInput;
}

/**
 * Save a pushed request in the parStore as the par endpoint does, and return
 * its request_uri (a new one each time, so the tests share no record).
 */
async function push(
  params: Record<string, string> = PUSHED_PARAMS,
  expiresAt = new Date(Date.now() + 60_000),
): Promise<string> {
  const requestUri = PAR_REQUEST_URI_PREFIX + crypto.randomUUID();
  await parStore.save({ requestUri, clientId: 'client-1', params: { ...params }, createdAt: new Date(), expiresAt });
  return requestUri;
}

describe('resolvePushedAuthorizationRequest', () => {
  describe('Requests Without a Pushed Request', () => {
    it('should return the parameters unchanged when the request carries no request_uri', async () => {
      const params = authorizationParams({ ...PUSHED_PARAMS });

      expect(await resolvePushedAuthorizationRequest(params)).toBe(params);
    });

    // OIDC Core 1.0 §6.2: a URL request_uri is left to the authorization endpoint (request_uri_not_supported).
    it('should leave a request_uri that is not a PAR URN unchanged', async () => {
      const params = authorizationParams({ client_id: 'client-1', request_uri: 'https://rp.example.com/request.jwt' });

      expect(await resolvePushedAuthorizationRequest(params)).toBe(params);
    });
  });

  describe('Pushed Requests', () => {
    // RFC 9126 §4: the authorization endpoint answers the pushed parameters.
    it('should expand a pushed request_uri into the pushed parameters', async () => {
      const requestUri = await push();

      const resolved = await resolvePushedAuthorizationRequest(
        authorizationParams({ client_id: 'client-1', request_uri: requestUri }),
      );

      expect(resolved).toEqual(PUSHED_PARAMS);
    });

    // RFC 9126 §4: the query parameters other than client_id and request_uri are not merged in.
    it('should answer the pushed parameters only, not the other query parameters', async () => {
      const requestUri = await push();

      const resolved = await resolvePushedAuthorizationRequest(
        authorizationParams({ client_id: 'client-1', request_uri: requestUri, scope: 'openid profile', state: 'query-state' }),
      );

      expect(resolved).toEqual(PUSHED_PARAMS);
    });

    // RFC 9126 §4 / RFC 6749 §4.1.2.1: without a resolved request there is no verified
    // redirect_uri, so the error stays on the OP (no redirectUri).
    it('should reject a request_uri that was never pushed with a non-redirectable invalid_request_uri', async () => {
      const resolving = resolvePushedAuthorizationRequest(
        authorizationParams({ client_id: 'client-1', request_uri: `${PAR_REQUEST_URI_PREFIX}unknown` }),
      );

      await expect(resolving).rejects.toBeInstanceOf(AuthorizationError);
      await expect(resolving).rejects.toMatchObject({
        error: 'invalid_request_uri',
        errorDescription: OPAQUE_FAILURE,
        redirectUri: undefined,
        redirectable: false,
      });
    });

    // RFC 9126 §7.3: a request_uri is single use.
    it('should reject a request_uri that was already used with the same invalid_request_uri', async () => {
      const requestUri = await push();
      const params = authorizationParams({ client_id: 'client-1', request_uri: requestUri });
      await resolvePushedAuthorizationRequest(params);

      await expect(resolvePushedAuthorizationRequest(params)).rejects.toMatchObject({
        error: 'invalid_request_uri',
        errorDescription: OPAQUE_FAILURE,
        redirectable: false,
      });
    });

    // RFC 9126 §2.2: the request_uri is bound to the client that pushed the request.
    it('should reject a request_uri pushed by another client with the same invalid_request_uri', async () => {
      const requestUri = await push();

      await expect(
        resolvePushedAuthorizationRequest(authorizationParams({ client_id: 'client-2', request_uri: requestUri })),
      ).rejects.toMatchObject({ error: 'invalid_request_uri', errorDescription: OPAQUE_FAILURE, redirectable: false });
    });

    // RFC 9126 §4: an expired request_uri MUST be rejected as invalid.
    it('should reject an expired request_uri with the same invalid_request_uri', async () => {
      const requestUri = await push(PUSHED_PARAMS, new Date(Date.now() - 1000));

      await expect(
        resolvePushedAuthorizationRequest(authorizationParams({ client_id: 'client-1', request_uri: requestUri })),
      ).rejects.toMatchObject({ error: 'invalid_request_uri', errorDescription: OPAQUE_FAILURE, redirectable: false });
    });

    it('should reject a pushed request whose parameters lack client_id with the same invalid_request_uri', async () => {
      const { client_id: _clientId, ...withoutClientId } = PUSHED_PARAMS;
      const requestUri = await push(withoutClientId);

      await expect(
        resolvePushedAuthorizationRequest(authorizationParams({ client_id: 'client-1', request_uri: requestUri })),
      ).rejects.toMatchObject({ error: 'invalid_request_uri', errorDescription: OPAQUE_FAILURE, redirectable: false });
    });

    it('should pass on an error of the store that is not a request_uri failure', async () => {
      const failure = new Error('store unavailable');
      vi.spyOn(parStore, 'consume').mockRejectedValueOnce(failure);

      await expect(
        resolvePushedAuthorizationRequest(
          authorizationParams({ client_id: 'client-1', request_uri: `${PAR_REQUEST_URI_PREFIX}any` }),
        ),
      ).rejects.toBe(failure);
    });
  });

  // RFC 9126 §5: require_pushed_authorization_requests.
  describe('When Pushed Authorization Requests Are Required', () => {
    it('should reject a request that did not go through the par endpoint with a non-redirectable invalid_request', async () => {
      parConfig.requirePushedAuthorizationRequests = true;

      const resolving = resolvePushedAuthorizationRequest(authorizationParams({ ...PUSHED_PARAMS }));

      await expect(resolving).rejects.toBeInstanceOf(AuthorizationError);
      await expect(resolving).rejects.toMatchObject({
        error: 'invalid_request',
        errorDescription: 'Pushed authorization requests are required by this authorization server',
        redirectable: false,
      });
    });

    it('should still expand a pushed request_uri', async () => {
      parConfig.requirePushedAuthorizationRequests = true;
      const requestUri = await push();

      const resolved = await resolvePushedAuthorizationRequest(
        authorizationParams({ client_id: 'client-1', request_uri: requestUri }),
      );

      expect(resolved).toEqual(PUSHED_PARAMS);
    });
  });
});
