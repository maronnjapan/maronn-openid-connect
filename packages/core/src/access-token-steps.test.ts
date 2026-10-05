/**
 * アクセストークン発行時のペイロード検証の部品関数のテスト。
 */
import { describe, expect, it } from 'vitest';
import { validateAccessTokenExpiration } from './access-token.js';

describe('validateAccessTokenExpiration', () => {
  it('should accept exp equal to now minus leeway', () => {
    expect(validateAccessTokenExpiration(1_699_999_940, 1_700_000_000, 60)).toBeUndefined();
  });

  it('should reject exp before now minus leeway', () => {
    expect(() => validateAccessTokenExpiration(1_699_999_939, 1_700_000_000, 60)).toThrow(
      'Token expiration time is in the past',
    );
  });

  it('should reject a missing exp', () => {
    expect(() => validateAccessTokenExpiration(undefined, 1_700_000_000, 60)).toThrow(
      'Missing required claim: exp',
    );
  });
});
