/**
 * クライアント認証（OAuth 2.1 §2.3 / OIDC Core 1.0 §9）の
 * 機能単位ステップ関数のテスト。
 *
 * authenticateClient はこれらのステップ関数の合成であり、CLI 生成コードは各ステップを
 * 個別に呼び出して、利用者が認証方式を差し替えたり検証を消したりできるようにする。
 * 合成後の網羅的な振る舞いは client-auth.test.ts が担保し、本ファイルは
 * 各ステップ関数の入出力契約（成功値と代表的なエラー）を固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  extractClientCredentials,
  validateClientAuthMethod,
  verifyClientSecret,
} from './client-auth.js';
import { TokenError, TokenErrorCode } from './token-request.js';
import type { TokenClientInfo } from './token-request.js';

const confidentialClient: TokenClientInfo = {
  clientId: 'client123',
  clientSecret: 'secret',
  tokenEndpointAuthMethod: 'client_secret_basic',
};

const postClient: TokenClientInfo = {
  clientId: 'client123',
  clientSecret: 'secret',
  tokenEndpointAuthMethod: 'client_secret_post',
};

const publicClient: TokenClientInfo = {
  clientId: 'public-client',
  tokenEndpointAuthMethod: 'none',
};

function basicHeader(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

/** 同期ステップが投げた TokenError を取り出す（投げなければ undefined） */
function captureError(fn: () => unknown): TokenError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as TokenError;
  }
}

/** 非同期ステップが投げた TokenError を取り出す（投げなければ undefined） */
async function captureAsyncError(
  fn: () => Promise<unknown>,
): Promise<TokenError | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as TokenError;
  }
}

describe('extractClientCredentials', () => {
  it('should extract credentials from the Authorization Basic header', () => {
    const result = extractClientCredentials({
      params: {},
      authorizationHeader: basicHeader('client123', 'secret'),
    });

    expect(result).toEqual({
      clientId: 'client123',
      clientSecret: 'secret',
      method: 'client_secret_basic',
    });
  });

  it('should form-urldecode the Basic credentials', () => {
    const result = extractClientCredentials({
      params: {},
      authorizationHeader: `Basic ${btoa('client%20id:sec%2Bret')}`,
    });

    expect(result).toEqual({
      clientId: 'client id',
      clientSecret: 'sec+ret',
      method: 'client_secret_basic',
    });
  });

  it('should match the Basic scheme case-insensitively', () => {
    const result = extractClientCredentials({
      params: {},
      authorizationHeader: `basic ${btoa('client123:secret')}`,
    });

    expect(result).toEqual({
      clientId: 'client123',
      clientSecret: 'secret',
      method: 'client_secret_basic',
    });
  });

  it('should extract credentials from the request body', () => {
    const result = extractClientCredentials({
      params: { client_id: 'client123', client_secret: 'secret' },
      authorizationHeader: '',
    });

    expect(result).toEqual({
      clientId: 'client123',
      clientSecret: 'secret',
      method: 'client_secret_post',
    });
  });

  it('should report method none when only client_id is presented', () => {
    const result = extractClientCredentials({
      params: { client_id: 'public-client' },
      authorizationHeader: '',
    });

    expect(result).toEqual({
      clientId: 'public-client',
      clientSecret: undefined,
      method: 'none',
    });
  });

  // RFC 6749 §3.2: Parameters sent without a value MUST be treated as if they
  // were omitted from the request. 空文字列の client_secret は未提示として扱う。
  it('should treat an empty client_secret field as absent for a public client', () => {
    const result = extractClientCredentials({
      params: { client_id: 'public-client', client_secret: '' },
      authorizationHeader: '',
    });

    expect(result).toEqual({
      clientId: 'public-client',
      clientSecret: undefined,
      method: 'none',
    });
  });

  // RFC 6749 §2.3: 空の client_secret は資格情報を運ばないため
  // 「もう一つの認証方式」に当たらず、多重方式の invalid_request にしない。
  it('should not reject Basic authentication combined with an empty client_secret field', () => {
    const result = extractClientCredentials({
      params: { client_secret: '' },
      authorizationHeader: basicHeader('client123', 'secret'),
    });

    expect(result).toEqual({
      clientId: 'client123',
      clientSecret: 'secret',
      method: 'client_secret_basic',
    });
  });

  // 空文字列の client_secret 単独（client_id なし）は何も提示していないのと同じ。
  // RFC 6749 §4.1.3: 未認証クライアントも client_id を送らなければならない。
  it('should require a client identifier when only an empty client_secret is sent', () => {
    const error = captureError(() =>
      extractClientCredentials({
        params: { client_secret: '' },
        authorizationHeader: '',
      }),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication required');
  });

  // confidential client が空の client_secret を送った場合は method 'none' の未提示となり、
  // 後段 validateClientAuthMethod が「方式不一致」ではなく「認証必須」で拒否する。
  it('should still require authentication when a confidential client sends an empty client_secret', () => {
    const presented = extractClientCredentials({
      params: { client_id: 'client123', client_secret: '' },
      authorizationHeader: '',
    });

    expect(presented).toEqual({
      clientId: 'client123',
      clientSecret: undefined,
      method: 'none',
    });

    const error = captureError(() =>
      validateClientAuthMethod(confidentialClient, presented),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication required');
  });

  it('should reject combining the Basic header with body credentials', () => {
    const error = captureError(() =>
      extractClientCredentials({
        params: { client_id: 'client123', client_secret: 'secret' },
        authorizationHeader: basicHeader('client123', 'secret'),
      }),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidRequest);
  });

  it('should reject a malformed Basic header with invalid_client', () => {
    const error = captureError(() =>
      extractClientCredentials({ params: {}, authorizationHeader: 'Basic not-base64!!' }),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Invalid Authorization header format');
  });

  it('should reject a request without any client identifier', () => {
    const error = captureError(() =>
      extractClientCredentials({ params: {}, authorizationHeader: '' }),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication required');
  });
});

describe('validateClientAuthMethod', () => {
  it('should accept client_secret_basic for a client registered with it', () => {
    const error = captureError(() =>
      validateClientAuthMethod(confidentialClient, {
        clientId: 'client123',
        clientSecret: 'secret',
        method: 'client_secret_basic',
      }),
    );

    expect(error).toBeUndefined();
  });

  it('should default the registered method to client_secret_basic', () => {
    const error = captureError(() =>
      validateClientAuthMethod(
        { clientId: 'client123', clientSecret: 'secret' },
        { clientId: 'client123', clientSecret: 'secret', method: 'client_secret_basic' },
      ),
    );

    expect(error).toBeUndefined();
  });

  it('should reject client_secret_post for a client registered with client_secret_basic', () => {
    const error = captureError(() =>
      validateClientAuthMethod(confidentialClient, {
        clientId: 'client123',
        clientSecret: 'secret',
        method: 'client_secret_post',
      }),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe(
      'Client authentication method does not match the registered token_endpoint_auth_method',
    );
  });

  it('should accept client_secret_post for a client registered with it', () => {
    const error = captureError(() =>
      validateClientAuthMethod(postClient, {
        clientId: 'client123',
        clientSecret: 'secret',
        method: 'client_secret_post',
      }),
    );

    expect(error).toBeUndefined();
  });

  it('should accept a public client that presents only its client_id', () => {
    const error = captureError(() =>
      validateClientAuthMethod(publicClient, {
        clientId: 'public-client',
        clientSecret: undefined,
        method: 'none',
      }),
    );

    expect(error).toBeUndefined();
  });

  it('should reject a public client that presents a secret', () => {
    const error = captureError(() =>
      validateClientAuthMethod(publicClient, {
        clientId: 'public-client',
        clientSecret: 'secret',
        method: 'client_secret_post',
      }),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe(
      'Client authentication method does not match the registered token_endpoint_auth_method',
    );
  });

  it('should reject a confidential client that presents no secret', () => {
    const error = captureError(() =>
      validateClientAuthMethod(confidentialClient, {
        clientId: 'client123',
        clientSecret: undefined,
        method: 'none',
      }),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication required');
  });

  it('should reject a confidential client that presents an empty secret', () => {
    const error = captureError(() =>
      validateClientAuthMethod(confidentialClient, {
        clientId: 'client123',
        clientSecret: '',
        method: 'client_secret_post',
      }),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.errorDescription).toBe('Client authentication required');
  });
});

describe('verifyClientSecret', () => {
  it('should accept the registered secret', async () => {
    const error = await captureAsyncError(() =>
      verifyClientSecret(confidentialClient, 'secret'),
    );

    expect(error).toBeUndefined();
  });

  it('should reject a wrong secret with invalid_client', async () => {
    const error = await captureAsyncError(() =>
      verifyClientSecret(confidentialClient, 'wrong'),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication failed');
  });

  it('should skip verification for a public client', async () => {
    const error = await captureAsyncError(() => verifyClientSecret(publicClient, undefined));

    expect(error).toBeUndefined();
  });

  it('should reject a confidential client with no presented secret', async () => {
    const error = await captureAsyncError(() =>
      verifyClientSecret(confidentialClient, undefined),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication failed');
  });
});
