import { TokenError, TokenErrorCode } from '@maronn-openid-connect/core';
import { DeviceAuthorizationError } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { DeviceAuthorizationEndpointError } from '../response.js';
import { respondDeviceAuthorizationError } from './respond-error.js';

describe('respondDeviceAuthorizationError', () => {
  it('should answer a DeviceAuthorizationEndpointError with its status, body and headers', async () => {
    const error = new DeviceAuthorizationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'bad body' },
      headers: { 'X-Reason': 'malformed' },
    });

    const response = respondDeviceAuthorizationError(contextOf(), error);

    expect(response.status).toBe(400);
    expect(response.headers.get('X-Reason')).toBe('malformed');
    expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'bad body' });
  });

  // RFC 6749 §5.2: what the experimental package rejects is a 400 OAuth error.
  it('should answer a DeviceAuthorizationError with 400 and its code', async () => {
    const response = respondDeviceAuthorizationError(
      contextOf(),
      new DeviceAuthorizationError('invalid_scope', 'The openid scope is required'),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_scope', error_description: 'The openid scope is required' });
  });

  // RFC 6749 §5.2: invalid_client answers 401 with the scheme in WWW-Authenticate.
  it('should answer an invalid_client TokenError with 401 and WWW-Authenticate', async () => {
    const response = respondDeviceAuthorizationError(
      contextOf(),
      new TokenError(TokenErrorCode.InvalidClient, 'Client authentication failed'),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(await response.json()).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' });
  });

  it('should answer any other error with 500 server_error, no-store', async () => {
    const response = respondDeviceAuthorizationError(contextOf(), new Error('store is down'));

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});
