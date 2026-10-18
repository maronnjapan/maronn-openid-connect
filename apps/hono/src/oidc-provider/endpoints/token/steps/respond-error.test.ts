import { TokenError, TokenErrorCode } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { TokenEndpointError } from '../response.js';
import { respondTokenError } from './respond-error.js';

describe('respondTokenError', () => {
  it('should send the response of a TokenEndpointError as it is', async () => {
    const error = new TokenEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Missing required parameter: grant_type' },
    });

    const response = respondTokenError(contextOf(), error);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Missing required parameter: grant_type',
    });
  });

  // RFC 6749 §5.2: a 400 with error and error_description.
  it('should answer a TokenError with 400, its error and error_description, and no WWW-Authenticate', async () => {
    const response = respondTokenError(
      contextOf(),
      new TokenError(TokenErrorCode.InvalidGrant, 'Authorization code not found'),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: 'Authorization code not found' });
  });

  // RFC 6749 §5.2 / RFC 6750 §3 / OAuth 2.1 §5.2: invalid_client is a 401 with WWW-Authenticate.
  it('should answer invalid_client with 401 and a Basic WWW-Authenticate challenge', async () => {
    const response = respondTokenError(
      contextOf(),
      new TokenError(TokenErrorCode.InvalidClient, 'Client authentication failed'),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(await response.json()).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' });
  });

  // RFC 6749 §5.2: server_error responses MUST NOT be cached either.
  it('should answer any other error with an uncached 500 server_error that reveals nothing of it', async () => {
    const response = respondTokenError(contextOf(), new Error('database connection lost'));

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});
