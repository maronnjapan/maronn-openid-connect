import { ParError } from '@maronn-openid-connect/experimental/par';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { ParEndpointError } from '../response.js';
import { respondParError } from './respond-error.js';

describe('respondParError', () => {
  it('should answer the fixed response of a ParEndpointError', async () => {
    const error = new ParEndpointError({ status: 400, body: { error: 'invalid_request', error_description: 'bad' } });

    const response = respondParError(contextOf(), error);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'bad' });
  });

  // RFC 9126 §2.3 / RFC 6749 §5.2: a failed client authentication is a 401 with a Basic challenge.
  it('should answer invalid_client with 401 and a WWW-Authenticate challenge', async () => {
    const response = respondParError(contextOf(), new ParError('invalid_client', 'Client authentication failed'));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    });
  });

  it('should answer any other ParError with 400 and no WWW-Authenticate', async () => {
    const response = respondParError(contextOf(), new ParError('invalid_scope', 'openid scope is required'));

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store');
    expect(await response.json()).toEqual({ error: 'invalid_scope', error_description: 'openid scope is required' });
  });

  it('should answer an unexpected error with 500 server_error', async () => {
    const response = respondParError(contextOf(), new Error('database down'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});
