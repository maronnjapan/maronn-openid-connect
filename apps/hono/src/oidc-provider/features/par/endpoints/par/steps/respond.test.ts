import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { respondPar } from './respond.js';

describe('respondPar', () => {
  // RFC 9126 §2.2: the response is not cacheable.
  it('should answer the status and JSON body with no-cache, no-store headers', async () => {
    const response = respondPar(contextOf(), {
      status: 201,
      body: { request_uri: 'urn:ietf:params:oauth:request_uri:abc', expires_in: 60 },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({ request_uri: 'urn:ietf:params:oauth:request_uri:abc', expires_in: 60 });
  });

  it('should add the headers of the response', () => {
    const response = respondPar(contextOf(), {
      status: 401,
      body: { error: 'invalid_client' },
      headers: { 'WWW-Authenticate': 'Basic realm="Client Authentication"' },
    });

    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
  });
});
