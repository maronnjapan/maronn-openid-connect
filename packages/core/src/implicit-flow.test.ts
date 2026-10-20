/**
 * Implicit Flow（OIDC Core 1.0 §3.2）の部品関数のテスト。
 *
 * 認可リクエストの検証（nonce、redirect_uri、response_mode）と、認可エンドポイントが
 * 返すパラメータの組み立て、フラグメントへの載せ方をリテラルの引数で検証する。
 */
import { describe, expect, it } from 'vitest';
import { AuthorizationError } from './authorization-request.js';
import {
  buildFragmentResponseUrl,
  buildImplicitResponseParameters,
  requireNonce,
  returnsScopeClaimsInIdToken,
  validateImplicitRedirectUri,
  validateImplicitResponseMode,
} from './implicit-flow.js';

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

// OIDC Core 1.0 §3.2.2.1: nonce is REQUIRED in the Implicit Flow.
describe('requireNonce', () => {
  it('should return the nonce', () => {
    expect(requireNonce('n-0S6_WzA2Mj', redirectUri, 'state-1')).toBe('n-0S6_WzA2Mj');
  });

  it('should reject a missing nonce with a redirectable invalid_request', () => {
    const error = captureError(() => requireNonce(undefined, redirectUri, 'state-1'));

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({
      error: 'invalid_request',
      errorDescription: 'Missing required parameter: nonce',
      redirectUri,
      state: 'state-1',
    });
  });

  it('should reject an empty nonce', () => {
    const error = captureError(() => requireNonce('', redirectUri));

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.errorDescription).toBe('Missing required parameter: nonce');
  });
});

// OIDC Core 1.0 §3.2.2.1: the Redirection URI MUST NOT use the http scheme
// unless the client is a native application, which MAY use http on localhost
// or a loopback IP literal.
describe('validateImplicitRedirectUri', () => {
  describe('https', () => {
    it('should accept an https redirect_uri of a confidential client', () => {
      expect(validateImplicitRedirectUri(redirectUri, 'confidential')).toBeUndefined();
    });

    it('should accept an https redirect_uri of a public client', () => {
      expect(validateImplicitRedirectUri(redirectUri, 'public')).toBeUndefined();
    });
  });

  describe('loopback http', () => {
    it('should accept localhost, 127.0.0.1 and [::1] for a public client', () => {
      expect([
        validateImplicitRedirectUri('http://localhost:8080/cb', 'public'),
        validateImplicitRedirectUri('http://127.0.0.1:3020/implicit-callback', 'public'),
        validateImplicitRedirectUri('http://[::1]/cb', 'public'),
      ]).toEqual([undefined, undefined, undefined]);
    });

    it('should reject a loopback http redirect_uri of a confidential client', () => {
      const error = captureError(() =>
        validateImplicitRedirectUri('http://127.0.0.1:3020/cb', 'confidential', 'state-1'),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error).toMatchObject({
        error: 'invalid_request',
        errorDescription:
          'redirect_uri of the Implicit Flow must use https, or http on a loopback host for a public client',
        redirectUri: 'http://127.0.0.1:3020/cb',
        state: 'state-1',
      });
    });

    // Without a registered client type the client is treated as confidential.
    it('should reject a loopback http redirect_uri when the client type is not registered', () => {
      const error = captureError(() =>
        validateImplicitRedirectUri('http://localhost:8080/cb', undefined),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe('invalid_request');
    });
  });

  it('should reject a non-loopback http redirect_uri of a public client', () => {
    const error = captureError(() =>
      validateImplicitRedirectUri('http://client.example.org/cb', 'public'),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe('invalid_request');
  });

  // The rule is about the http scheme only: a native app's private-use URI
  // scheme (RFC 8252 §7.1) is not http.
  it('should accept a private-use URI scheme', () => {
    expect(validateImplicitRedirectUri('com.example.app:/oauth2redirect', 'public')).toBeUndefined();
  });

  it('should compare the scheme case-insensitively', () => {
    const error = captureError(() =>
      validateImplicitRedirectUri('HTTP://127.0.0.1:3020/cb', 'confidential'),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe('invalid_request');
  });
});

// OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5 / §7: the
// Implicit Flow answers in the fragment by default, and never in the query.
describe('validateImplicitResponseMode', () => {
  it('should accept a request without response_mode', () => {
    expect(validateImplicitResponseMode(undefined, ['fragment'], redirectUri)).toBeUndefined();
  });

  it('should accept the response mode the OP answers the request in', () => {
    expect([
      validateImplicitResponseMode('fragment', ['fragment'], redirectUri),
      validateImplicitResponseMode('form_post', ['form_post'], redirectUri),
    ]).toEqual([undefined, undefined]);
  });

  it('should reject response_mode=query with a redirectable invalid_request', () => {
    const error = captureError(() =>
      validateImplicitResponseMode('query', ['fragment'], redirectUri, 'state-1'),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({
      error: 'invalid_request',
      errorDescription: 'response_mode=query must not be used with the Implicit Flow',
      redirectUri,
      state: 'state-1',
    });
  });

  // query must not carry tokens even when the caller lists it.
  it('should reject response_mode=query even when it is listed', () => {
    const error = captureError(() => validateImplicitResponseMode('query', ['query'], redirectUri));

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.errorDescription).toBe('response_mode=query must not be used with the Implicit Flow');
  });

  it('should reject a response mode the OP does not answer the request in', () => {
    const error = captureError(() =>
      validateImplicitResponseMode('query.jwt', ['fragment'], redirectUri, 'state-1'),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({
      error: 'invalid_request',
      errorDescription: 'Unsupported response_mode: query.jwt',
      redirectUri,
      state: 'state-1',
    });
  });
});

// OIDC Core 1.0 §5.4: when no access token is issued (response_type=id_token),
// the claims of the scope values are returned in the ID Token.
describe('returnsScopeClaimsInIdToken', () => {
  it('should return true for id_token', () => {
    expect(returnsScopeClaimsInIdToken('id_token')).toBe(true);
  });

  it('should return false for the response types that issue an access token', () => {
    expect([returnsScopeClaimsInIdToken('id_token token'), returnsScopeClaimsInIdToken('code')]).toEqual([
      false,
      false,
    ]);
  });

  // OIDC Core 1.0 §3.3 / §5.4: the code of the Hybrid Flow is exchanged for an
  // access token at the token endpoint, which reaches the UserInfo endpoint.
  it('should return false for the Hybrid Flow response types', () => {
    expect([
      returnsScopeClaimsInIdToken('code id_token'),
      returnsScopeClaimsInIdToken('code token'),
      returnsScopeClaimsInIdToken('code id_token token'),
    ]).toEqual([false, false, false]);
  });
});

// OIDC Core 1.0 §3.2.2.5: the parameters of a successful Implicit Flow response.
describe('buildImplicitResponseParameters', () => {
  it('should return the access token, its type and lifetime, the scope, the ID Token and the state', () => {
    expect(
      buildImplicitResponseParameters({
        idToken: 'id-token-1',
        accessToken: 'access-token-1',
        expiresIn: 3600,
        scope: ['openid', 'profile'],
        state: 'state-1',
      }),
    ).toEqual({
      access_token: 'access-token-1',
      token_type: 'Bearer',
      expires_in: '3600',
      scope: 'openid profile',
      id_token: 'id-token-1',
      state: 'state-1',
    });
  });

  // response_type=id_token: no access token, so no token_type, expires_in or scope.
  it('should return only the ID Token and the state without an access token', () => {
    expect(
      buildImplicitResponseParameters({ idToken: 'id-token-1', state: 'state-1' }),
    ).toEqual({ id_token: 'id-token-1', state: 'state-1' });
  });

  it('should leave state out when the request had none', () => {
    expect(buildImplicitResponseParameters({ idToken: 'id-token-1' })).toEqual({ id_token: 'id-token-1' });
  });

  it('should leave expires_in and scope out when they are not given', () => {
    expect(
      buildImplicitResponseParameters({ idToken: 'id-token-1', accessToken: 'access-token-1' }),
    ).toEqual({ access_token: 'access-token-1', token_type: 'Bearer', id_token: 'id-token-1' });
  });
});

// RFC 6749 §4.2.2 / Multiple Response Type Encoding Practices §2.1: the
// parameters go into the fragment, application/x-www-form-urlencoded.
describe('buildFragmentResponseUrl', () => {
  it('should put the parameters into the fragment', () => {
    expect(
      buildFragmentResponseUrl(redirectUri, { id_token: 'eyJ.a.b', state: 'state-1' }),
    ).toBe('https://client.example.org/cb#id_token=eyJ.a.b&state=state-1');
  });

  // RFC 6749 §3.1.2: the query component of the redirection URI is retained.
  it('should keep the query of the redirect URI', () => {
    expect(
      buildFragmentResponseUrl('https://client.example.org/cb?tenant=a', { error: 'access_denied' }),
    ).toBe('https://client.example.org/cb?tenant=a#error=access_denied');
  });

  it('should leave out parameters without a value', () => {
    expect(
      buildFragmentResponseUrl(redirectUri, { error: 'login_required', error_description: undefined, state: '' }),
    ).toBe('https://client.example.org/cb#error=login_required');
  });

  it('should form-encode the values', () => {
    expect(
      buildFragmentResponseUrl(redirectUri, { state: 'a b&c=d', error_description: 'x#y' }),
    ).toBe('https://client.example.org/cb#state=a+b%26c%3Dd&error_description=x%23y');
  });
});
