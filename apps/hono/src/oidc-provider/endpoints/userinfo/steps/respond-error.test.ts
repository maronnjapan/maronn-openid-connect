import { UserInfoError, UserInfoErrorCode } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { UserInfoEndpointError } from '../response.js';
import { respondUserInfoError } from './respond-error.js';

describe('respondUserInfoError', () => {
  it('should answer the fixed response of a UserInfoEndpointError', async () => {
    const error = new UserInfoEndpointError({
      status: 401,
      body: { error: 'invalid_token', error_description: 'Access token is required' },
      headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo"' },
    });

    const response = respondUserInfoError(contextOf(), error);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'Access token is required' });
  });

  // RFC 6750 §3: the Bearer challenge names the error and its description.
  it('should answer invalid_token with 401 and the Bearer challenge', async () => {
    const error = new UserInfoError(UserInfoErrorCode.InvalidToken, 'Access token is invalid');

    const response = respondUserInfoError(contextOf(), error);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="UserInfo", error="invalid_token", error_description="Access token is invalid"',
    );
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'Access token is invalid' });
  });

  // RFC 6750 §3.1: insufficient_scope is 403.
  it('should answer insufficient_scope with 403', () => {
    const error = new UserInfoError(UserInfoErrorCode.InsufficientScope, 'The openid scope is required');

    const response = respondUserInfoError(contextOf(), error);

    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="UserInfo", error="insufficient_scope", error_description="The openid scope is required"',
    );
  });

  it('should answer any other error with 500 server_error', async () => {
    const response = respondUserInfoError(contextOf(), new Error('database is down'));

    expect(response.status).toBe(500);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});
