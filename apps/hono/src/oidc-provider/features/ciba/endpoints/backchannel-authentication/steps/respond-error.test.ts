import { TokenError, TokenErrorCode } from '@maronn-openid-connect/core';
import { BackchannelAuthenticationError } from '@maronn-openid-connect/experimental/ciba';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { BackchannelAuthenticationEndpointError } from '../response.js';
import { respondBackchannelAuthenticationError } from './respond-error.js';

describe('respondBackchannelAuthenticationError', () => {
  it('should answer a BackchannelAuthenticationEndpointError with its status, body and headers', async () => {
    const error = new BackchannelAuthenticationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'bad body' },
      headers: { 'X-Reason': 'malformed' },
    });

    const response = respondBackchannelAuthenticationError(contextOf(), error);

    expect(response.status).toBe(400);
    expect(response.headers.get('X-Reason')).toBe('malformed');
    expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'bad body' });
  });

  // CIBA Core 1.0 §13: what the experimental package rejects is a 400 OAuth error.
  it('should answer a BackchannelAuthenticationError with 400 and its code', async () => {
    const response = respondBackchannelAuthenticationError(
      contextOf(),
      new BackchannelAuthenticationError('unknown_user_id', 'The login_hint could not be matched to a user'),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'unknown_user_id',
      error_description: 'The login_hint could not be matched to a user',
    });
  });

  // RFC 6749 §5.2: invalid_client answers 401 with the scheme in WWW-Authenticate.
  it('should answer an invalid_client TokenError with 401 and WWW-Authenticate', async () => {
    const response = respondBackchannelAuthenticationError(
      contextOf(),
      new TokenError(TokenErrorCode.InvalidClient, 'Client authentication failed'),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(await response.json()).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' });
  });

  it('should answer a TokenError other than invalid_client with 400 and no WWW-Authenticate', async () => {
    const response = respondBackchannelAuthenticationError(
      contextOf(),
      new TokenError(TokenErrorCode.InvalidRequest, 'Multiple client authentication methods provided'),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('should answer any other error with 500 server_error, no-store', async () => {
    const response = respondBackchannelAuthenticationError(contextOf(), new Error('store is down'));

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});
