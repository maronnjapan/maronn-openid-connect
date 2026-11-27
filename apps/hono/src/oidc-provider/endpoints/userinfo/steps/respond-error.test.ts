import { UserInfoError, UserInfoErrorCode } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { BEARER_CHALLENGE, UserInfoEndpointError, type UserInfoChallenges } from '../response.js';
import { respondUserInfoError } from './respond-error.js';

/** The challenges of the pipeline without a feature: Bearer alone. */
function bearerOnly(): UserInfoChallenges {
  return { offered: [BEARER_CHALLENGE], scheme: 'Bearer' };
}

/** The challenges of an endpoint that also accepts the DPoP scheme (RFC 9449 §7.2), with the scheme the request used. */
function bearerAndDpop(scheme: string): UserInfoChallenges {
  return { offered: [BEARER_CHALLENGE, { scheme: 'DPoP', parameters: ['algs="ES256"'] }], scheme };
}

describe('respondUserInfoError', () => {
  it('should answer the fixed response of a UserInfoEndpointError that asks for no challenge', async () => {
    const error = new UserInfoEndpointError({ status: 400, body: { error: 'invalid_request' } });

    const response = respondUserInfoError(contextOf(), error, bearerOnly());

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  // RFC 6750 §3.1: a request without authentication information gets challenges without an error.
  it('should add the challenges without an error to a UserInfoEndpointError without one', async () => {
    const error = new UserInfoEndpointError(
      { status: 401, body: { error: 'invalid_token', error_description: 'Access token is required' } },
      'without-error',
    );

    const response = respondUserInfoError(contextOf(), error, bearerOnly());

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo"');
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'Access token is required' });
  });

  // RFC 9449 §7.2 Figure 17: with another scheme, every challenge is offered, none with an error.
  it('should offer the challenge of every accepted scheme without an error when no token was presented', () => {
    const error = new UserInfoEndpointError({ status: 401, body: { error: 'invalid_token' } }, 'without-error');

    const response = respondUserInfoError(contextOf(), error, bearerAndDpop('Bearer'));

    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo", DPoP algs="ES256"');
  });

  // RFC 9449 §7.2 Figure 19: the mechanism is ambiguous, so every challenge carries the error.
  it('should put the error of an ambiguous request in every challenge and keep the other headers', () => {
    const error = new UserInfoEndpointError(
      { status: 400, body: { error: 'invalid_request' }, headers: { 'X-Example': 'kept' } },
      { error: 'invalid_request', everyScheme: true },
    );

    const response = respondUserInfoError(contextOf(), error, bearerAndDpop('Bearer'));

    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="UserInfo", error="invalid_request", DPoP algs="ES256", error="invalid_request"',
    );
    expect(response.headers.get('X-Example')).toBe('kept');
  });

  // RFC 6750 §3: the Bearer challenge names the error and its description.
  it('should answer invalid_token with 401 and the Bearer challenge', async () => {
    const error = new UserInfoError(UserInfoErrorCode.InvalidToken, 'Access token is invalid');

    const response = respondUserInfoError(contextOf(), error, bearerOnly());

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="UserInfo", error="invalid_token", error_description="Access token is invalid"',
    );
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'Access token is invalid' });
  });

  // RFC 6750 §3.1: insufficient_scope is 403.
  it('should answer insufficient_scope with 403', () => {
    const error = new UserInfoError(UserInfoErrorCode.InsufficientScope, 'The openid scope is required');

    const response = respondUserInfoError(contextOf(), error, bearerOnly());

    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="UserInfo", error="insufficient_scope", error_description="The openid scope is required"',
    );
  });

  // RFC 9449 §7.2 Figure 18: the challenge of the scheme the request used carries the error, the others are bare.
  it('should put the error of a rejected token in the challenge of the scheme the request used', () => {
    const error = new UserInfoError(UserInfoErrorCode.InvalidToken, 'Access token is invalid');

    const response = respondUserInfoError(contextOf(), error, bearerAndDpop('DPoP'));

    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="UserInfo", DPoP algs="ES256", error="invalid_token", error_description="Access token is invalid"',
    );
  });

  it('should answer any other error with 500 server_error', async () => {
    const response = respondUserInfoError(contextOf(), new Error('database is down'), bearerOnly());

    expect(response.status).toBe(500);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});
