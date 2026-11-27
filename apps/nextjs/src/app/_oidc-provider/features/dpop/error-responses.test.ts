import { UserInfoError, UserInfoErrorCode } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';

import { UserInfoEndpointError } from '../../../userinfo/response';
import { tokenEndpointRejectionOf, userInfoEndpointErrorOf } from './error-responses';
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

  // RFC 9449 §5 / §10: a code or refresh token bound to another key is a 400 invalid_grant.
  it('should answer the invalid_grant of a grant bound to a DPoP key with an uncacheable 400 error response', async () => {
    const response = tokenEndpointRejectionOf(new DpopError('invalid_grant', 'The DPoP proof key does not match the key the grant is bound to'));

    expect({
      status: response?.status,
      cacheControl: response?.headers.get('Cache-Control'),
      body: await response?.json(),
    }).toEqual({
      status: 400,
      cacheControl: 'no-store',
      body: { error: 'invalid_grant', error_description: 'The DPoP proof key does not match the key the grant is bound to' },
    });
  });

  it('should leave any other error to the caller', () => {
    expect(tokenEndpointRejectionOf(new Error('The iat window of the DPoP proof checks must be non-negative finite numbers'))).toBeUndefined();
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
