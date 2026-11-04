import { describe, expect, it } from 'vitest';
import { TokenEndpointError } from '../../../endpoints/token/response.js';
import { rejectTokenRequestAuthorizationDetails } from './reject-token-request-details.js';

describe('rejectTokenRequestAuthorizationDetails', () => {
  it('should do nothing without the parameter', () => {
    expect(() =>
      rejectTokenRequestAuthorizationDetails({ grant_type: 'authorization_code', code: 'code-1' }),
    ).not.toThrow();
  });

  // RFC 9396 §6 の narrowing は非対応。黙殺せず明示拒否する。
  it('should reject a token request carrying authorization_details with 400 invalid_authorization_details', () => {
    let caught: unknown;
    try {
      rejectTokenRequestAuthorizationDetails({
        grant_type: 'authorization_code',
        code: 'code-1',
        authorization_details: '[{"type":"payment_initiation"}]',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TokenEndpointError);
    expect((caught as TokenEndpointError).response).toEqual({
      status: 400,
      body: {
        error: 'invalid_authorization_details',
        error_description: 'authorization_details is not accepted at the token endpoint',
      },
    });
  });

  it('should reject the refresh_token grant the same way', () => {
    expect(() =>
      rejectTokenRequestAuthorizationDetails({
        grant_type: 'refresh_token',
        refresh_token: 'rt-1',
        authorization_details: '[]',
      }),
    ).toThrow(TokenEndpointError);
  });
});
