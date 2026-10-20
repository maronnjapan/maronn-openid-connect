import { AuthorizationError, AuthorizationErrorCode } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { RECORDED_RESPONSE, recordingResponseMode, REDIRECT_URI, STATE } from '../../../../test-support/authorize.js';
import { contextOf, TEST_ISSUER } from '../../../../test-support/context.js';
import { authorizationErrorOutcome } from './respond-error.js';

const c = contextOf(undefined, { config: { issuer: TEST_ISSUER } });

describe('authorizationErrorOutcome', () => {
  // OIDC Core 1.0 §3.1.2.6 / RFC 9207 §2
  it('should redirect a redirectable error to the client with error, error_description, state and iss', async () => {
    const error = new AuthorizationError(AuthorizationErrorCode.InvalidScope, 'scope must include openid', REDIRECT_URI, STATE);

    expect(await authorizationErrorOutcome(c, error, undefined)).toEqual({
      kind: 'authorization_response',
      response: {
        method: 'redirect',
        location:
          'https://rp.example.com/callback?error=invalid_scope&error_description=scope+must+include+openid' +
          '&state=state-1&iss=https%3A%2F%2Fop.example.com',
      },
    });
  });

  // JARM §2.1: the error members go back in the response mode the request asked for.
  it('should hand a redirectable error to the response mode the request asked for', async () => {
    const { responseMode, respond } = recordingResponseMode();
    const error = new AuthorizationError(AuthorizationErrorCode.LoginRequired, 'No active session', REDIRECT_URI, STATE);

    expect(await authorizationErrorOutcome(c, error, responseMode)).toEqual({
      kind: 'authorization_response',
      response: RECORDED_RESPONSE,
    });
    expect(respond.mock.calls).toEqual([
      [REDIRECT_URI, { error: 'login_required', error_description: 'No active session', state: STATE }],
    ]);
  });

  // OIDC Core 1.0 §3.1.2.2: without a verified redirect_uri the error stays on the OP.
  it('should keep an error without a redirect_uri on the OP, even with a response mode', async () => {
    const { responseMode, respond } = recordingResponseMode();
    const error = new AuthorizationError(AuthorizationErrorCode.InvalidRequest, 'Unknown client_id');

    expect(await authorizationErrorOutcome(c, error, responseMode)).toEqual({
      kind: 'error',
      error: 'invalid_request',
      errorDescription: 'Unknown client_id',
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', new Error('database is unavailable')],
    ['a thrown string', 'unexpected'],
  ])('should answer server_error for %s that is not an AuthorizationError', async (_label, error) => {
    expect(await authorizationErrorOutcome(c, error, undefined)).toEqual({ kind: 'server_error' });
  });
});
