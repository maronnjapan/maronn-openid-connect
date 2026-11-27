import { TokenError, TokenErrorCode } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';

import { TokenEndpointError } from '../../endpoints/token/response.js';
import { tokenEndpointErrorOf } from './error-responses.js';
import { DpopError } from './errors.js';

describe('tokenEndpointErrorOf', () => {
  // RFC 9449 §5 / RFC 6749 §5.2: an invalid DPoP proof is a 400 OAuth error response.
  it('should turn a failure of the DPoP checks into a 400 error response of the token endpoint', () => {
    const error = tokenEndpointErrorOf(new DpopError('invalid_dpop_proof', 'The DPoP proof has already been used'));

    expect(error).toBeInstanceOf(TokenEndpointError);
    expect((error as TokenEndpointError).response).toEqual({
      status: 400,
      body: { error: 'invalid_dpop_proof', error_description: 'The DPoP proof has already been used' },
    });
  });

  // RFC 9449 §5 / §10: a code or refresh token bound to another key is a 400 invalid_grant.
  it('should turn the invalid_grant of a grant bound to a DPoP key into a 400 error response of the token endpoint', () => {
    const error = tokenEndpointErrorOf(new DpopError('invalid_grant', 'The DPoP proof key does not match the key the grant is bound to'));

    expect(error).toBeInstanceOf(TokenEndpointError);
    expect((error as TokenEndpointError).response).toEqual({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'The DPoP proof key does not match the key the grant is bound to' },
    });
  });

  it.each([
    ['a TokenError', new TokenError(TokenErrorCode.InvalidGrant, 'The code has expired')],
    ['an Error of a misconfiguration', new Error('The iat window of the DPoP proof checks must be non-negative finite numbers')],
  ])('should return %s as it is', (_name, error) => {
    expect(tokenEndpointErrorOf(error)).toBe(error);
  });
});
