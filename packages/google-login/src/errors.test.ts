import { describe, expect, it } from 'vitest';

import { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';

describe('GoogleLoginError', () => {
  it('should set name to GoogleLoginError', () => {
    const error = new GoogleLoginError(GoogleLoginErrorCode.InvalidSignature, 'bad signature');

    expect(error.name).toBe('GoogleLoginError');
    expect(error.message).toBe('bad signature');
    expect(error).toBeInstanceOf(Error);
  });

  it('should expose the error code', () => {
    const error = new GoogleLoginError(GoogleLoginErrorCode.InvalidAudience, 'bad aud');

    expect(error.code).toBe('invalid_audience');
  });

  describe('httpStatusCode', () => {
    // Google のドキュメントの CSRF 検証サンプルは 3 つの失敗をいずれも 400 で止める。
    // nonce の不備は core の transaction_not_found と同じく 400。
    it.each([
      [GoogleLoginErrorCode.MissingCredential, 400],
      [GoogleLoginErrorCode.CsrfTokenMissingInCookie, 400],
      [GoogleLoginErrorCode.CsrfTokenMissingInBody, 400],
      [GoogleLoginErrorCode.CsrfTokenMismatch, 400],
      [GoogleLoginErrorCode.InvalidNonce, 400],
      [GoogleLoginErrorCode.LoginNonceNotFound, 400],
      [GoogleLoginErrorCode.LoginNonceExpired, 400],
      [GoogleLoginErrorCode.MalformedIdToken, 401],
      [GoogleLoginErrorCode.UnsupportedAlgorithm, 401],
      [GoogleLoginErrorCode.UnknownSigningKey, 401],
      [GoogleLoginErrorCode.InvalidSignature, 401],
      [GoogleLoginErrorCode.InvalidIssuer, 401],
      [GoogleLoginErrorCode.InvalidAudience, 401],
      [GoogleLoginErrorCode.IdTokenExpired, 401],
      [GoogleLoginErrorCode.IdTokenNotYetValid, 401],
      [GoogleLoginErrorCode.InvalidHostedDomain, 403],
      [GoogleLoginErrorCode.EmailNotVerified, 403],
      [GoogleLoginErrorCode.AccountNotLinked, 403],
      [GoogleLoginErrorCode.SigningKeyUnavailable, 503],
    ])('should map %s to %d', (code, status) => {
      expect(new GoogleLoginError(code, 'x').httpStatusCode).toBe(status);
    });
  });
});
