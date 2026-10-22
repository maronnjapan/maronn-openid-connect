import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { validateRegistrationMetadata } from './validate-metadata.js';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW = Date.UTC(2026, 0, 1) / 1000;
const CLIENT_ID = /^dcr-[A-Za-z0-9_-]{22}$/;
const CLIENT_SECRET = /^[A-Za-z0-9_-]{43}$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('validateRegistrationMetadata', () => {
  // RFC 7591 §2: the defaults of the metadata the client left out.
  it('should build a confidential client with a new client_id, a secret and the RFC 7591 defaults', async () => {
    const { c } = await providerContext();

    const client = validateRegistrationMetadata(c, JSON.stringify({ redirect_uris: ['https://rp.example.com/callback'] }));

    expect(client).toEqual({
      clientId: expect.stringMatching(CLIENT_ID),
      clientSecret: expect.stringMatching(CLIENT_SECRET),
      clientType: 'confidential',
      redirectUris: ['https://rp.example.com/callback'],
      grantTypes: ['authorization_code'],
      responseTypes: ['code'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
      clientIdIssuedAt: NOW,
    });
  });

  // RFC 6749 §2.1: a client with token_endpoint_auth_method none is public and gets no secret.
  it('should build a public client without a secret for token_endpoint_auth_method none', async () => {
    const { c } = await providerContext();

    const client = validateRegistrationMetadata(
      c,
      JSON.stringify({
        redirect_uris: ['http://127.0.0.1:8080/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['refresh_token', 'authorization_code'],
        client_name: 'Example App',
        software_statement: 'ignored',
      }),
    );

    expect(client).toEqual({
      clientId: expect.stringMatching(CLIENT_ID),
      clientType: 'public',
      redirectUris: ['http://127.0.0.1:8080/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethods: ['none'],
      clientName: 'Example App',
      clientIdIssuedAt: NOW,
    });
  });

  // RFC 7591 §3.2.2: invalid_redirect_uri, without echoing the URI.
  it('should reject a plain-http redirect URI that is not a loopback with invalid_redirect_uri', async () => {
    const { c } = await providerContext();

    expect(() =>
      validateRegistrationMetadata(c, JSON.stringify({ redirect_uris: ['http://rp.example.com/callback'] })),
    ).toThrow(
      expect.objectContaining({
        name: 'ClientRegistrationError',
        error: 'invalid_redirect_uri',
        errorDescription: 'each redirect_uri must be an absolute URI without a fragment and must not use a dangerous scheme or non-loopback http',
      }),
    );
  });

  // RFC 7591 §5: the body limit comes from the maxRegistrationBodyBytes setting.
  it('should reject a body over maxRegistrationBodyBytes with invalid_client_metadata', async () => {
    const { c } = await providerContext({ options: { dynamicClientRegistration: { maxRegistrationBodyBytes: 32 } } });

    expect(() =>
      validateRegistrationMetadata(c, JSON.stringify({ redirect_uris: ['https://rp.example.com/callback'] })),
    ).toThrow(
      expect.objectContaining({
        name: 'ClientRegistrationError',
        error: 'invalid_client_metadata',
        errorDescription: 'request body must not exceed the configured maximum size',
      }),
    );
  });
});
