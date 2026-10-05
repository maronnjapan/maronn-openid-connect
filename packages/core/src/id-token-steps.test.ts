/**
 * ID Token 発行時のペイロード検証の部品関数のテスト。
 *
 * validatePayload は以下の部品関数を呼ぶ。合成した振る舞いは id-token.test.ts が担保する。
 */
import { describe, expect, it } from 'vitest';
import {
  validateIdTokenIssuer,
  validateIdTokenExpiration,
  validateIdTokenAuthorizedParty,
} from './id-token.js';

describe('validateIdTokenIssuer', () => {
  it('should accept an https URL', () => {
    expect(validateIdTokenIssuer('https://op.example')).toBeUndefined();
  });

  it('should reject a missing issuer', () => {
    expect(() => validateIdTokenIssuer('')).toThrow('Missing required claim: iss');
  });

  it('should reject a non-loopback http URL', () => {
    expect(() => validateIdTokenIssuer('http://op.example')).toThrow(
      'Issuer must use https scheme (except for loopback hosts)',
    );
  });

  it('should reject an issuer with a query', () => {
    expect(() => validateIdTokenIssuer('https://op.example?tenant=1')).toThrow(
      'Issuer must not contain query parameters',
    );
  });
});

describe('validateIdTokenExpiration', () => {
  it('should accept exp equal to now minus leeway', () => {
    expect(validateIdTokenExpiration(1_699_999_940, 1_700_000_000, 60)).toBeUndefined();
  });

  it('should reject exp before now minus leeway', () => {
    expect(() => validateIdTokenExpiration(1_699_999_939, 1_700_000_000, 60)).toThrow(
      'Token expiration time is in the past',
    );
  });

  it('should reject a missing exp', () => {
    expect(() => validateIdTokenExpiration(undefined, 1_700_000_000, 60)).toThrow(
      'Missing required claim: exp',
    );
  });

  // RFC 7519 §4.1.4: exp is a NumericDate
  it('should reject a string exp', () => {
    expect(() => validateIdTokenExpiration('1700000000', 1_700_000_000, 60)).toThrow(
      'exp must be a number (NumericDate)',
    );
  });
});

describe('validateIdTokenAuthorizedParty', () => {
  it('should accept a single audience without azp', () => {
    expect(validateIdTokenAuthorizedParty('client-1', undefined)).toBeUndefined();
  });

  // OIDC Core 1.0 §2: azp is required when aud has multiple values
  it('should accept multiple audiences with azp among them', () => {
    expect(validateIdTokenAuthorizedParty(['client-1', 'api'], 'client-1')).toBeUndefined();
  });

  it('should reject multiple audiences without azp', () => {
    expect(() => validateIdTokenAuthorizedParty(['client-1', 'api'], undefined)).toThrow(
      'azp is required when aud contains multiple values',
    );
  });

  it('should reject azp outside the audiences', () => {
    expect(() => validateIdTokenAuthorizedParty(['client-1', 'api'], 'client-2')).toThrow(
      'azp must be one of the audience values',
    );
  });
});
