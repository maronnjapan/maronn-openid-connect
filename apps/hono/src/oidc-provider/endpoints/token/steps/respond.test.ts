import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { respondToken } from './respond.js';

describe('respondToken', () => {
  // RFC 6749 §5.1: the response is JSON and MUST NOT be cached.
  it('should answer with the status and JSON body and the no-store and no-cache headers', async () => {
    const response = respondToken(contextOf(), { status: 200, body: { access_token: 'at-1', token_type: 'Bearer' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual({ access_token: 'at-1', token_type: 'Bearer' });
  });

  // RFC 6750 §3: e.g. the WWW-Authenticate header of a 401.
  it('should add the headers the response carries', () => {
    const response = respondToken(contextOf(), {
      status: 401,
      body: { error: 'invalid_client' },
      headers: { 'WWW-Authenticate': 'Basic realm="Client Authentication"' },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
