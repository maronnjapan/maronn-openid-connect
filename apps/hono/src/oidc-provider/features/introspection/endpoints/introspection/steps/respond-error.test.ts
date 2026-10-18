import {
  IntrospectionError,
  IntrospectionErrorCode,
  TokenError,
  TokenErrorCode,
} from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { IntrospectionEndpointError } from '../response.js';
import { respondIntrospectionError } from './respond-error.js';

describe('respondIntrospectionError', () => {
  it('should answer the fixed response of an IntrospectionEndpointError', async () => {
    const error = new IntrospectionEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'bad' },
    });

    const response = respondIntrospectionError(contextOf(), error);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'bad' });
  });

  // RFC 6749 §5.2: a failed client authentication is a 401 with a Basic challenge.
  it('should answer a TokenError invalid_client with 401 and a WWW-Authenticate challenge', async () => {
    const response = respondIntrospectionError(
      contextOf(),
      new TokenError(TokenErrorCode.InvalidClient, 'Client authentication failed'),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    });
  });

  // RFC 7662 §2.3.
  it('should answer an IntrospectionError invalid_request with 400 and no WWW-Authenticate', async () => {
    const response = respondIntrospectionError(
      contextOf(),
      new IntrospectionError(IntrospectionErrorCode.InvalidRequest, 'Missing required parameter: token'),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Missing required parameter: token',
    });
  });

  it('should answer an unexpected error with 500 server_error', async () => {
    const response = respondIntrospectionError(contextOf(), new Error('database down'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});
