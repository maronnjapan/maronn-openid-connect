import { describe, expect, it } from 'vitest';

import { tokenEndpointRejectionOf } from './error-responses';
import { DpopError } from './errors';

describe('tokenEndpointRejectionOf', () => {
  // RFC 9449 §5 / RFC 6749 §5.2: an invalid DPoP proof is a 400 OAuth error response, never cached.
  it('should turn a failure of the DPoP checks into an uncacheable 400 error response', async () => {
    const response = tokenEndpointRejectionOf(new DpopError('invalid_dpop_proof', 'The DPoP proof has already been used'));

    expect({
      status: response?.status,
      cacheControl: response?.headers.get('Cache-Control'),
      pragma: response?.headers.get('Pragma'),
      body: await response?.json(),
    }).toEqual({
      status: 400,
      cacheControl: 'no-store',
      pragma: 'no-cache',
      body: { error: 'invalid_dpop_proof', error_description: 'The DPoP proof has already been used' },
    });
  });

  it('should leave any other error to the caller', () => {
    expect(tokenEndpointRejectionOf(new Error('The iat window of the DPoP proof checks must be non-negative finite numbers'))).toBeUndefined();
  });
});
