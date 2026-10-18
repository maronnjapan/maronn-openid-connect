import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { respondBackchannelAuthentication } from './respond.js';

describe('respondBackchannelAuthentication', () => {
  // CIBA Core 1.0 §7.3: the authentication request acknowledgement.
  it('should answer 200 with the acknowledgement as JSON', async () => {
    const response = respondBackchannelAuthentication(contextOf(), {
      auth_req_id: 'auth-req-1',
      expires_in: 120,
      interval: 5,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ auth_req_id: 'auth-req-1', expires_in: 120, interval: 5 });
  });

  // RFC 6749 §5.1: auth_req_id is a credential, so the response must not be cached.
  it('should mark the response no-store', () => {
    const response = respondBackchannelAuthentication(contextOf(), { auth_req_id: 'auth-req-1' });

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
  });
});
