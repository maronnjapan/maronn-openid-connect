/**
 * Hybrid Flow（OIDC Core 1.0 §3.3）の部品関数のテスト。
 *
 * 認可リクエストの検証（nonce、response_mode）と、認可エンドポイントが認可コードと一緒に
 * 返すパラメータの組み立てをリテラルの引数で検証する。
 */
import { describe, expect, it } from 'vitest';
import { AuthorizationError } from './authorization-request.js';
import {
  buildHybridResponseParameters,
  requireHybridNonce,
  validateHybridResponseMode,
} from './hybrid-flow.js';

const redirectUri = 'https://client.example.org/cb';

// Helper: capture the AuthorizationError thrown by a step (undefined if none)
function captureError(fn: () => unknown): AuthorizationError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as AuthorizationError;
  }
}

// OIDC Core 1.0 §3.3.2.11: nonce is REQUIRED when the authorization endpoint
// returns an ID Token; code token returns none there, so nonce stays optional
// as in the code flow (the errata NonceNotes; the OIDF
// oidcc-ensure-request-without-nonce-succeeds-for-code-flow module).
describe('requireHybridNonce', () => {
  it('should return the nonce of a code id_token and a code id_token token request', () => {
    expect([
      requireHybridNonce('code id_token', 'n-0S6_WzA2Mj', redirectUri, 'state-1'),
      requireHybridNonce('code id_token token', 'n-0S6_WzA2Mj', redirectUri, 'state-1'),
    ]).toEqual(['n-0S6_WzA2Mj', 'n-0S6_WzA2Mj']);
  });

  it('should reject a code id_token request without nonce with a redirectable invalid_request', () => {
    const error = captureError(() => requireHybridNonce('code id_token', undefined, redirectUri, 'state-1'));

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({
      error: 'invalid_request',
      errorDescription: 'Missing required parameter: nonce',
      redirectUri,
      state: 'state-1',
    });
  });

  it('should reject a code id_token token request with an empty nonce', () => {
    const error = captureError(() => requireHybridNonce('code id_token token', '', redirectUri));

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.errorDescription).toBe('Missing required parameter: nonce');
  });

  it('should accept a code token request without nonce', () => {
    expect(requireHybridNonce('code token', undefined, redirectUri, 'state-1')).toBeUndefined();
  });

  it('should return the nonce of a code token request that has one', () => {
    expect(requireHybridNonce('code token', 'n-0S6_WzA2Mj', redirectUri)).toBe('n-0S6_WzA2Mj');
  });
});

// OAuth 2.0 Multiple Response Type Encoding Practices §5: the default response
// mode of the Hybrid Flow is the fragment, and the query must not be used.
describe('validateHybridResponseMode', () => {
  it('should accept a request without response_mode', () => {
    expect(validateHybridResponseMode(undefined, ['fragment'], redirectUri, 'state-1')).toBeUndefined();
  });

  it('should accept a response mode the OP answers the request in', () => {
    expect([
      validateHybridResponseMode('fragment', ['fragment'], redirectUri),
      validateHybridResponseMode('form_post', ['form_post'], redirectUri),
    ]).toEqual([undefined, undefined]);
  });

  it('should reject response_mode=query with a redirectable invalid_request', () => {
    const error = captureError(() => validateHybridResponseMode('query', ['fragment'], redirectUri, 'state-1'));

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({
      error: 'invalid_request',
      errorDescription: 'response_mode=query must not be used with the Hybrid Flow',
      redirectUri,
      state: 'state-1',
    });
  });

  // Even an OP that answers code in the query never answers the Hybrid Flow in it.
  it('should reject response_mode=query even when the query is among the supported response modes', () => {
    const error = captureError(() => validateHybridResponseMode('query', ['query', 'fragment'], redirectUri));

    expect(error?.errorDescription).toBe('response_mode=query must not be used with the Hybrid Flow');
  });

  it('should reject a response mode the OP does not answer the request in', () => {
    const error = captureError(() => validateHybridResponseMode('query.jwt', ['fragment'], redirectUri, 'state-1'));

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({
      error: 'invalid_request',
      errorDescription: 'Unsupported response_mode: query.jwt',
      redirectUri,
      state: 'state-1',
    });
  });

  // Response mode values are case-sensitive (Multiple Response Type Encoding Practices §2.1).
  it('should reject a response mode that differs from a supported one in case', () => {
    const error = captureError(() => validateHybridResponseMode('FRAGMENT', ['fragment'], redirectUri));

    expect(error?.errorDescription).toBe('Unsupported response_mode: FRAGMENT');
  });
});

// OIDC Core 1.0 §3.3.2.5: the parameters of a successful Hybrid Flow response.
describe('buildHybridResponseParameters', () => {
  it('should return the code, the access token, its type, lifetime and scope, the ID Token and the state', () => {
    expect(
      buildHybridResponseParameters({
        code: 'code-1',
        idToken: 'id-token-1',
        accessToken: 'access-token-1',
        expiresIn: 3600,
        scope: ['openid', 'profile'],
        state: 'state-1',
      }),
    ).toEqual({
      code: 'code-1',
      access_token: 'access-token-1',
      token_type: 'Bearer',
      expires_in: '3600',
      scope: 'openid profile',
      id_token: 'id-token-1',
      state: 'state-1',
    });
  });

  // response_type=code id_token: no access token, so no token_type, expires_in or scope.
  it('should return the code, the ID Token and the state without an access token', () => {
    expect(buildHybridResponseParameters({ code: 'code-1', idToken: 'id-token-1', state: 'state-1' })).toEqual({
      code: 'code-1',
      id_token: 'id-token-1',
      state: 'state-1',
    });
  });

  // response_type=code token: no ID Token from the authorization endpoint.
  it('should return the code and the access token without an ID Token', () => {
    expect(
      buildHybridResponseParameters({
        code: 'code-1',
        accessToken: 'access-token-1',
        expiresIn: 3600,
        scope: ['openid'],
        state: 'state-1',
      }),
    ).toEqual({
      code: 'code-1',
      access_token: 'access-token-1',
      token_type: 'Bearer',
      expires_in: '3600',
      scope: 'openid',
      state: 'state-1',
    });
  });

  it('should leave state out when the request had none', () => {
    expect(buildHybridResponseParameters({ code: 'code-1', idToken: 'id-token-1' })).toEqual({
      code: 'code-1',
      id_token: 'id-token-1',
    });
  });

  it('should leave expires_in and scope out when they are not given', () => {
    expect(buildHybridResponseParameters({ code: 'code-1', accessToken: 'access-token-1' })).toEqual({
      code: 'code-1',
      access_token: 'access-token-1',
      token_type: 'Bearer',
    });
  });
});
