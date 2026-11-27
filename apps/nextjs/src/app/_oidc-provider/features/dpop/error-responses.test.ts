import { UserInfoError, UserInfoErrorCode } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';

import { BEARER_CHALLENGE, UserInfoEndpointError, userInfoChallengeHeader } from '../../../userinfo/response';
import { ambiguousUserInfoRequestError, tokenEndpointRejectionOf, userInfoEndpointErrorOf } from './error-responses';
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

  // RFC 6749 §5.2: invalid_request is also an error code of the token endpoint.
  it('should answer the invalid_request of a DPoP check with an uncacheable 400 error response', async () => {
    const response = tokenEndpointRejectionOf(new DpopError('invalid_request', 'Multiple access token methods are not allowed'));

    expect({
      status: response?.status,
      cacheControl: response?.headers.get('Cache-Control'),
      body: await response?.json(),
    }).toEqual({
      status: 400,
      cacheControl: 'no-store',
      body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
    });
  });

  // RFC 6750 §3.1: invalid_token is an error of a protected resource, never of the token endpoint.
  it.each([
    ['the invalid_token of a protected resource', new DpopError('invalid_token', 'The access token is bound to a different DPoP key')],
    ['an Error of a misconfiguration', new Error('The iat window of the DPoP proof checks must be non-negative finite numbers')],
  ])('should leave %s to the caller', (_name, error) => {
    expect(tokenEndpointRejectionOf(error)).toBeUndefined();
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

describe('ambiguousUserInfoRequestError', () => {
  // RFC 9449 §7.2 Figure 19: a token sent with both Bearer and DPoP is a 400 invalid_request, whose
  // error every challenge carries.
  it('should be a 400 invalid_request whose error goes in the challenge of every scheme', () => {
    const error = ambiguousUserInfoRequestError();
    const challenges = { offered: [BEARER_CHALLENGE, { scheme: 'DPoP', parameters: ['algs="ES256"'] }], scheme: 'Bearer' };

    expect([error.response, userInfoChallengeHeader(challenges, error.challenge ?? 'without-error')]).toEqual([
      { status: 400, body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' } },
      'Bearer realm="UserInfo", error="invalid_request", error_description="Multiple access token methods are not allowed", ' +
        'DPoP algs="ES256", error="invalid_request", error_description="Multiple access token methods are not allowed"',
    ]);
  });
});
