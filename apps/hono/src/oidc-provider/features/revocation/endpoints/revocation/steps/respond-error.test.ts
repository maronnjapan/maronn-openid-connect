import { RevocationError, RevocationErrorCode, TokenError, TokenErrorCode } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { RevocationEndpointError } from '../response.js';
import { respondRevocationError } from './respond-error.js';

describe('respondRevocationError', () => {
  it('should answer the fixed response and headers of a RevocationEndpointError', async () => {
    const error = new RevocationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'bad' },
      headers: { 'X-Reason': 'malformed' },
    });

    const response = respondRevocationError(contextOf(), error);

    expect(response.status).toBe(400);
    expect(response.headers.get('X-Reason')).toBe('malformed');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'bad' });
  });

  // RFC 6749 §5.2: a failed client authentication is a 401 with a Basic challenge.
  it('should answer a TokenError invalid_client with 401 and a WWW-Authenticate challenge', async () => {
    const response = respondRevocationError(
      contextOf(),
      new TokenError(TokenErrorCode.InvalidClient, 'Client authentication failed'),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    });
  });

  // RFC 7009 §2.2.1.
  it('should answer a RevocationError invalid_grant with 400 and no WWW-Authenticate', async () => {
    const response = respondRevocationError(
      contextOf(),
      new RevocationError(RevocationErrorCode.InvalidGrant, 'Token was not issued to the requesting client'),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'Token was not issued to the requesting client',
    });
  });

  it('should answer an unexpected error with 500 server_error and no-store', async () => {
    const response = respondRevocationError(contextOf(), new Error('database down'));

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});
