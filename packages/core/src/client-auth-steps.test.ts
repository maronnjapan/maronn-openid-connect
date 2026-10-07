/**
 * クライアント認証（OAuth 2.1 §2.3 / OIDC Core 1.0 §9）の
 * 機能単位ステップ関数のテスト。
 *
 * CLI 生成コードはこれらのステップを個別に呼び出して、利用者が認証方式を
 * 差し替えたり検証を消したりできるようにする。ステップごとの網羅的な振る舞いは
 * client-auth.test.ts が担保し、本ファイルは client-auth.test.ts が扱わない
 * ステップ関数のケースと、ステップを構成する部品関数の入出力を固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  extractClientCredentials,
  validateClientAuthMethod,
  verifyClientSecret,
  parseBasicClientCredentials,
  validateSingleClientAuthMethod,
  validateClientIdConsistency,
  requireClientId,
  selectPresentedClientAuthMethod,
  selectRegisteredClientAuthMethod,
  requireClientSecret,
  validateClientAuthMethodMatch,
  verifyClientSecretValue,
} from './client-auth.js';
import { TokenError, TokenErrorCode } from './token-error.js';
import type { TokenClientInfo } from './token-request.js';

const confidentialClient: TokenClientInfo = {
  clientId: 'client123',
  clientSecret: 'secret',
  tokenEndpointAuthMethod: 'client_secret_basic',
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
});

describe('validateClientAuthMethod', () => {
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

describe('parseBasicClientCredentials', () => {
  // RFC 6749 §2.3.1: credentials are form-urlencoded before Base64 encoding
  it('should decode form-urlencoded credentials', () => {
    expect(parseBasicClientCredentials(`Basic ${btoa('a%3Ab:c+d')}`)).toEqual({
      clientId: 'a:b',
      clientSecret: 'c d',
    });
  });

  it('should return null for invalid base64', () => {
    expect(parseBasicClientCredentials('Basic !!!')).toBeNull();
  });

  it('should return null for another scheme', () => {
    expect(parseBasicClientCredentials('Bearer abc')).toBeNull();
  });
});

describe('validateSingleClientAuthMethod', () => {
  it('should accept Basic without a body secret', () => {
    expect(validateSingleClientAuthMethod(true, undefined)).toBeUndefined();
  });

  it('should reject Basic combined with a body secret', () => {
    expect(() => validateSingleClientAuthMethod(true, 'secret')).toThrow(
      expect.objectContaining({ error: 'invalid_request' }),
    );
  });
});

describe('validateClientIdConsistency', () => {
  it('should accept an omitted body client_id', () => {
    expect(validateClientIdConsistency(undefined, 'client-1')).toBeUndefined();
  });

  it('should reject a body client_id different from Basic', () => {
    expect(() => validateClientIdConsistency('client-2', 'client-1')).toThrow(
      'client_id in request body does not match the Authorization header',
    );
  });
});

describe('requireClientId', () => {
  it('should return the client_id', () => {
    expect(requireClientId('client-1')).toBe('client-1');
  });

  // RFC 6749 §4.1.3: an unauthenticated client must still send client_id
  it('should reject a missing client_id with invalid_client', () => {
    expect(() => requireClientId(undefined)).toThrow(
      expect.objectContaining({
        error: 'invalid_client',
        errorDescription: 'Client authentication required',
      }),
    );
  });
});

describe('selectPresentedClientAuthMethod', () => {
  it('should select client_secret_basic when Basic is used', () => {
    expect(selectPresentedClientAuthMethod({ hasBasicHeader: true, hasClientSecret: true })).toBe(
      'client_secret_basic',
    );
  });

  it('should select client_secret_post for a body secret', () => {
    expect(selectPresentedClientAuthMethod({ hasBasicHeader: false, hasClientSecret: true })).toBe(
      'client_secret_post',
    );
  });

  it('should select none without a secret', () => {
    expect(selectPresentedClientAuthMethod({ hasBasicHeader: false, hasClientSecret: false })).toBe(
      'none',
    );
  });
});

describe('selectRegisteredClientAuthMethod', () => {
  // OIDC Core 1.0 §9 / RFC 7591 §2: the default is client_secret_basic
  it('should default to client_secret_basic', () => {
    expect(selectRegisteredClientAuthMethod(undefined)).toBe('client_secret_basic');
  });

  it('should keep a registered method', () => {
    expect(selectRegisteredClientAuthMethod('none')).toBe('none');
  });
});

describe('requireClientSecret', () => {
  it('should return the client_secret', () => {
    expect(requireClientSecret('secret')).toBe('secret');
  });

  it('should reject a missing client_secret with invalid_client', () => {
    expect(() => requireClientSecret(undefined)).toThrow(
      expect.objectContaining({
        error: 'invalid_client',
        errorDescription: 'Client authentication required',
      }),
    );
  });
});

describe('validateClientAuthMethodMatch', () => {
  it('should accept the registered method', () => {
    expect(
      validateClientAuthMethodMatch('client_secret_post', 'client_secret_post'),
    ).toBeUndefined();
  });

  it('should reject a different method', () => {
    expect(() =>
      validateClientAuthMethodMatch('client_secret_post', 'client_secret_basic'),
    ).toThrow(
      expect.objectContaining({
        error: 'invalid_client',
        errorDescription:
          'Client authentication method does not match the registered token_endpoint_auth_method',
      }),
    );
  });
});

describe('verifyClientSecretValue', () => {
  it('should accept the registered secret', async () => {
    await expect(verifyClientSecretValue('secret', 'secret')).resolves.toBeUndefined();
  });

  it('should reject a different secret', async () => {
    await expect(verifyClientSecretValue('wrong', 'secret')).rejects.toThrow(
      expect.objectContaining({
        error: 'invalid_client',
        errorDescription: 'Client authentication failed',
      }),
    );
  });
});
