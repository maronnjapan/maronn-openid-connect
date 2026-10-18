import type { DynamicallyRegisteredClient } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { respondRegistration } from './respond.js';

const confidentialClient: DynamicallyRegisteredClient = {
  clientId: 'dcr-1',
  clientSecret: 'secret-1',
  clientType: 'confidential',
  redirectUris: ['https://rp.example.com/callback'],
  grantTypes: ['authorization_code', 'refresh_token'],
  responseTypes: ['code'],
  tokenEndpointAuthMethods: ['client_secret_post'],
  clientName: 'Example RP',
  clientIdIssuedAt: 1_767_225_600,
};

describe('respondRegistration', () => {
  // RFC 7591 §3.2.1: 201 with the issued values and every registered metadata value.
  it('should answer 201 with the client information, never cached because it carries the secret', async () => {
    const response = respondRegistration(contextOf(), confidentialClient);

    expect(response.status).toBe(201);
    expect([response.headers.get('Cache-Control'), response.headers.get('Pragma')]).toEqual(['no-store', 'no-cache']);
    expect(await response.json()).toEqual({
      client_id: 'dcr-1',
      client_secret: 'secret-1',
      client_secret_expires_at: 0,
      client_id_issued_at: 1_767_225_600,
      redirect_uris: ['https://rp.example.com/callback'],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Example RP',
    });
  });

  // RFC 7591 §3.2.1: client_secret_expires_at is required only when a secret is issued.
  it('should leave the secret and its expiry out for a public client', async () => {
    const { clientSecret: _secret, clientName: _name, ...publicClient } = confidentialClient;

    const response = respondRegistration(contextOf(), {
      ...publicClient,
      clientType: 'public',
      tokenEndpointAuthMethods: ['none'],
    });

    expect(await response.json()).toEqual({
      client_id: 'dcr-1',
      client_id_issued_at: 1_767_225_600,
      redirect_uris: ['https://rp.example.com/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });
});
