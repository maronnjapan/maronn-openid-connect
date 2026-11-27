import { TokenError, TokenErrorCode, UserInfoError, UserInfoErrorCode } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';

import { TokenEndpointError } from '../../endpoints/token/response.js';
import { UserInfoEndpointError } from '../../endpoints/userinfo/response.js';
import { tokenEndpointErrorOf, userInfoEndpointErrorOf } from './error-responses.js';
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

describe('userInfoEndpointErrorOf', () => {
  // RFC 9449 §7.1 / RFC 6750 §3.1: a rejected proof or token is a 401, a malformed request a 400; the
  // error goes in the JSON and in the challenge of the scheme the request used.
  it.each([
    ['invalid_dpop_proof', 'The DPoP proof has already been used', 401],
    ['invalid_token', 'The access token is bound to a different DPoP key', 401],
    ['invalid_request', 'The DPoP authorization header has no access token', 400],
  ] as const)('should turn the %s of a DPoP check into an error of the UserInfo endpoint', (code, description, status) => {
    const error = userInfoEndpointErrorOf(new DpopError(code, description));

    expect(error).toBeInstanceOf(UserInfoEndpointError);
    expect([(error as UserInfoEndpointError).response, (error as UserInfoEndpointError).challenge]).toEqual([
      { status, body: { error: code, error_description: description } },
      { error: code, errorDescription: description },
    ]);
  });

  // RFC 6749 §5.2: invalid_grant is an error of the token endpoint, never of a protected resource.
  it.each([
    ['the invalid_grant of a bound grant', new DpopError('invalid_grant', 'The grant is bound to a DPoP key, but no DPoP proof was sent')],
    ['a UserInfoError', new UserInfoError(UserInfoErrorCode.InvalidToken, 'Access token is invalid')],
    ['an Error of a misconfiguration', new Error('The iat window of the DPoP proof checks must be non-negative finite numbers')],
  ])('should return %s as it is', (_name, error) => {
    expect(userInfoEndpointErrorOf(error)).toBe(error);
  });
});
