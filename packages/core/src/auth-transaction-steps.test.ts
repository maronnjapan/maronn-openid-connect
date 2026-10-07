/**
 * 認証トランザクションの部品関数のテスト。
 *
 * ストアへの保存や削除を伴わない判定と変換だけを、リテラルの引数で検証する。
 * ストアを使うステップ関数の振る舞いは auth-transaction.test.ts が担保する。
 */
import { describe, it, expect } from 'vitest';
import {
  validateAuthTransactionExpiration,
  evaluateLoginFailure,
  computeAuthTransactionTtlSeconds,
  buildAuthTransaction,
  buildAuthorizationResponseParams,
  requiresReauthentication,
} from './auth-transaction.js';

describe('validateAuthTransactionExpiration', () => {
  it('should accept a transaction expiring after now', () => {
    expect(validateAuthTransactionExpiration(1_700_000_000_001, 1_700_000_000_000)).toBeUndefined();
  });

  it('should reject a transaction expiring exactly now', () => {
    expect(() =>
      validateAuthTransactionExpiration(1_700_000_000_000, 1_700_000_000_000),
    ).toThrow('Auth transaction has expired. Please start the authorization flow again.');
  });
});

describe('evaluateLoginFailure', () => {
  it('should allow a retry below the limit', () => {
    expect(evaluateLoginFailure(3, 5)).toEqual({ canRetry: true, failedAttempts: 4, maxAttempts: 5 });
  });

  it('should stop retries when the limit is reached', () => {
    expect(evaluateLoginFailure(4, 5)).toEqual({ canRetry: false, failedAttempts: 5, maxAttempts: 5 });
  });
});

describe('computeAuthTransactionTtlSeconds', () => {
  it('should round the remaining milliseconds up to seconds', () => {
    expect(computeAuthTransactionTtlSeconds(1_700_000_001_001, 1_700_000_000_000)).toBe(2);
  });

  it('should keep at least one second for an expired transaction', () => {
    expect(computeAuthTransactionTtlSeconds(1_700_000_000_000, 1_700_000_005_000)).toBe(1);
  });
});

describe('buildAuthTransaction', () => {
  it('should compute timestamps from the given clock and TTL', () => {
    expect(
      buildAuthTransaction(
        {
          clientId: 'client-1',
          redirectUri: 'https://client.example/cb',
          redirectUriExplicit: true,
          responseType: 'code',
          scope: ['openid', 'email'],
        },
        { csrfToken: 'csrf-1', ttlMs: 600_000, now: 1_700_000_000_000 },
      ),
    ).toEqual({
      clientId: 'client-1',
      redirectUri: 'https://client.example/cb',
      redirectUriExplicit: true,
      responseType: 'code',
      scope: 'openid email',
      csrfToken: 'csrf-1',
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_600_000,
      failedAttempts: 0,
    });
  });

  it('should copy optional request values and the binding hash', () => {
    expect(
      buildAuthTransaction(
        {
          clientId: 'client-1',
          redirectUri: 'https://client.example/cb',
          redirectUriExplicit: false,
          responseType: 'code',
          scope: ['openid'],
          state: 'state-1',
          prompt: ['login', 'consent'],
        },
        { csrfToken: 'csrf-1', ttlMs: 1_000, now: 1_700_000_000_000, bindingHash: 'hash-1' },
      ),
    ).toEqual({
      clientId: 'client-1',
      redirectUri: 'https://client.example/cb',
      redirectUriExplicit: false,
      responseType: 'code',
      scope: 'openid',
      csrfToken: 'csrf-1',
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_001_000,
      failedAttempts: 0,
      state: 'state-1',
      prompt: 'login consent',
      bindingHash: 'hash-1',
    });
  });
});

describe('buildAuthorizationResponseParams', () => {
  it('should project response fields from the transaction', () => {
    expect(
      buildAuthorizationResponseParams({
        clientId: 'client-1',
        redirectUri: 'https://client.example/cb',
        redirectUriExplicit: true,
        scope: 'openid email',
        state: 'state-1',
      }),
    ).toEqual({
      clientId: 'client-1',
      redirectUri: 'https://client.example/cb',
      redirectUriExplicit: true,
      scope: ['openid', 'email'],
      state: 'state-1',
    });
  });
});

describe('requiresReauthentication', () => {
  it('should not require re-authentication at the max_age boundary', () => {
    expect(requiresReauthentication(10, 1_700_000_000, 1_700_000_010)).toBe(false);
  });
});
