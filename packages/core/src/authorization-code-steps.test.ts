/**
 * 認可コード発行データの部品関数のテスト。
 *
 * createAuthorizationCode は乱数と時計を読んでから buildAuthorizationCodeData を呼ぶ。
 * 本ファイルは生成済みの値と固定の時刻で組み立て結果を検証する。
 */
import { describe, expect, it } from 'vitest';
import { buildAuthorizationCodeData } from './authorization-code.js';

describe('buildAuthorizationCodeData', () => {
  it('should compute expiresAt from now and the TTL', () => {
    expect(
      buildAuthorizationCodeData(
        {
          clientId: 'client-1',
          redirectUri: 'https://client.example/cb',
          redirectUriExplicit: true,
          scope: ['openid'],
        },
        {
          code: 'code-1',
          grantId: 'grant-1',
          subject: 'user-1',
          authTime: 1_699_999_000,
          ttlSeconds: 300,
          now: 1_700_000_000,
        },
      ),
    ).toEqual({
      code: 'code-1',
      grantId: 'grant-1',
      clientId: 'client-1',
      redirectUri: 'https://client.example/cb',
      redirectUriExplicit: true,
      scope: ['openid'],
      subject: 'user-1',
      used: false,
      expiresAt: 1_700_000_300,
      authTime: 1_699_999_000,
    });
  });

  it('should copy optional response values and the session id', () => {
    expect(
      buildAuthorizationCodeData(
        {
          clientId: 'client-1',
          redirectUri: 'https://client.example/cb',
          redirectUriExplicit: false,
          scope: ['openid'],
          nonce: 'nonce-1',
          codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          codeChallengeMethod: 'S256',
        },
        {
          code: 'code-1',
          grantId: 'grant-1',
          subject: 'user-1',
          authTime: 1_699_999_000,
          ttlSeconds: 60,
          now: 1_700_000_000,
          sessionId: 'session-1',
        },
      ),
    ).toEqual({
      code: 'code-1',
      grantId: 'grant-1',
      clientId: 'client-1',
      redirectUri: 'https://client.example/cb',
      redirectUriExplicit: false,
      scope: ['openid'],
      subject: 'user-1',
      used: false,
      expiresAt: 1_700_000_060,
      authTime: 1_699_999_000,
      nonce: 'nonce-1',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      sessionId: 'session-1',
    });
  });

  it('should carry the transaction the authorization response came from', () => {
    expect(
      buildAuthorizationCodeData(
        {
          clientId: 'client-1',
          redirectUri: 'https://client.example/cb',
          redirectUriExplicit: true,
          scope: ['openid'],
          transactionId: 'txn-1',
        },
        {
          code: 'code-1',
          grantId: 'grant-1',
          subject: 'user-1',
          authTime: 1_699_999_000,
          ttlSeconds: 300,
          now: 1_700_000_000,
        },
      ),
    ).toEqual({
      code: 'code-1',
      grantId: 'grant-1',
      clientId: 'client-1',
      redirectUri: 'https://client.example/cb',
      redirectUriExplicit: true,
      scope: ['openid'],
      subject: 'user-1',
      used: false,
      expiresAt: 1_700_000_300,
      authTime: 1_699_999_000,
      transactionId: 'txn-1',
    });
  });
});
