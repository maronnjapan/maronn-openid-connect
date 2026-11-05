import { AuthorizationError } from '@maronn-openid-connect/core';
import { describe, expect, it, vi } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import type { ProviderConfig, RegisteredClient } from '../../../config.js';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { fetchRequestUri } from './fetch-request-uri.js';

const REQUEST_URI = 'https://rp.example.com/request-objects/1#content-hash';
const JWT = 'eyJhbGciOiJub25lIn0.eyJpc3MiOiJyby1jbGllbnQifQ.';
const client: RegisteredClient = { clientId: 'ro-client', redirectUris: ['https://rp.example.com/callback'] };
const QUERY = { client_id: 'ro-client', response_type: 'code', scope: 'openid' };

function paramsWith(requestUri?: string): AuthorizationRequestInput {
  return (requestUri === undefined ? { ...QUERY } : { ...QUERY, request_uri: requestUri }) as AuthorizationRequestInput;
}

/** A provider whose outboundFetch answers the request_uri with `response`. */
async function contextFetching(response: () => Response, config: Partial<ProviderConfig> = {}) {
  const context = await providerContext({ options: { config } });
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response());
  context.c.set('outboundFetch', fetch);
  return { ...context, fetch };
}

describe('fetchRequestUri', () => {
  it('should return the parameters as they are without fetching when there is no request_uri', async () => {
    const { c, fetch } = await contextFetching(() => new Response(JWT));
    const params = paramsWith();

    expect(await fetchRequestUri(c, params, client)).toBe(params);
    expect(fetch).not.toHaveBeenCalled();
  });

  // OIDC Core 1.0 §6.2: the Request Object of the request_uri takes its place as request.
  it('should fetch the request_uri without its fragment and put the Request Object into request', async () => {
    const { c, fetch } = await contextFetching(() => new Response(JWT, { status: 200 }));

    const resolved = await fetchRequestUri(c, paramsWith(REQUEST_URI), client);

    expect(resolved).toEqual({ ...QUERY, request: JWT });
    expect(fetch.mock.calls.map(([input]) => input)).toEqual(['https://rp.example.com/request-objects/1']);
  });

  it('should leave request_uri for validate-request to reject when requestUriParameterSupported is off', async () => {
    const { c, fetch } = await contextFetching(() => new Response(JWT), { requestUriParameterSupported: false });
    const params = paramsWith(REQUEST_URI);

    expect(await fetchRequestUri(c, params, client)).toBe(params);
    expect(fetch).not.toHaveBeenCalled();
  });

  // OIDC Discovery 1.0 §3: require_request_uri_registration.
  describe('requireRequestUriRegistration', () => {
    it('should reject a request_uri the client did not register without fetching it', async () => {
      const { c, fetch } = await contextFetching(() => new Response(JWT), { requireRequestUriRegistration: true });

      await expect(
        fetchRequestUri(c, paramsWith(REQUEST_URI), { ...client, requestUris: ['https://rp.example.com/request-objects/2'] }),
      ).rejects.toMatchObject({
        error: 'invalid_request_uri',
        errorDescription: 'request_uri is not registered for the client',
        redirectable: false,
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should fetch a request_uri the client registered', async () => {
      const { c } = await contextFetching(() => new Response(JWT), { requireRequestUriRegistration: true });

      const resolved = await fetchRequestUri(c, paramsWith(REQUEST_URI), { ...client, requestUris: [REQUEST_URI] });

      expect(resolved).toEqual({ ...QUERY, request: JWT });
    });
  });

  // RFC 9101 §10.4.1: https URLs of public hosts only, unless allowed for development.
  it('should reject an http request_uri with invalid_request_uri without fetching it', async () => {
    const { c, fetch } = await contextFetching(() => new Response(JWT));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(fetchRequestUri(c, paramsWith('http://rp.example.com/ro'), client)).rejects.toMatchObject({
      error: 'invalid_request_uri',
      errorDescription: 'the request_uri could not be retrieved',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should fetch an http request_uri on localhost when allowInsecureRequestUri is on', async () => {
    const { c } = await contextFetching(() => new Response(JWT), { allowInsecureRequestUri: true });

    expect((await fetchRequestUri(c, paramsWith('http://localhost:3020/ro'), client)).request).toBe(JWT);
  });

  it('should reject a request_uri longer than requestUriMaxLength', async () => {
    const { c, fetch } = await contextFetching(() => new Response(JWT), { requestUriMaxLength: 40 });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(fetchRequestUri(c, paramsWith(REQUEST_URI), client)).rejects.toMatchObject({ error: 'invalid_request_uri' });
    expect(fetch).not.toHaveBeenCalled();
  });

  // The reason is logged with the host, never sent to the client.
  it('should log the host and reason of a failed fetch and answer a fixed description without redirecting', async () => {
    const { c } = await contextFetching(() => new Response('gone', { status: 404 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const resolving = fetchRequestUri(c, paramsWith(REQUEST_URI), client);

    await expect(resolving).rejects.toBeInstanceOf(AuthorizationError);
    await expect(resolving).rejects.toMatchObject({
      error: 'invalid_request_uri',
      errorDescription: 'the request_uri could not be retrieved',
      redirectable: false,
    });
    expect(warn).toHaveBeenCalledWith(
      '[oidc-provider] could not fetch the request_uri at rp.example.com: the request_uri answered HTTP 404',
    );
  });

  // OIDC Core 1.0 §6.2: request and request_uri are not combined.
  it('should reject request together with request_uri', async () => {
    const { c, fetch } = await contextFetching(() => new Response(JWT));

    await expect(fetchRequestUri(c, { ...paramsWith(REQUEST_URI), request: JWT }, client)).rejects.toMatchObject({
      error: 'invalid_request',
      errorDescription: 'request and request_uri must not be used together',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
