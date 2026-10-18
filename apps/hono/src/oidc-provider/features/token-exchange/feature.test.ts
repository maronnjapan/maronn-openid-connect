import { describe, expect, it } from 'vitest';
import { tokenExchange } from './feature.js';

describe('tokenExchange', () => {
  // RFC 8693 §2.1: the grant the token endpoint answers, also advertised in grant_types_supported.
  it('should answer the token-exchange grant at the token endpoint', () => {
    expect(tokenExchange).toEqual({
      id: 'token-exchange',
      token: { grants: ['urn:ietf:params:oauth:grant-type:token-exchange'] },
    });
  });
});
