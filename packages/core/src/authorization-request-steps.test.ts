/**
 * 認可リクエスト検証の機能単位ステップ関数と部品関数のテスト。
 *
 * CLI 生成コードはこれらのステップを個別に呼び出して、利用者が検証処理を
 * 消したり足したりできるようにする。ステップごとの網羅的な振る舞いは
 * authorization-request.test.ts が担保し、本ファイルは部品関数をリテラルの引数で
 * 検証するほか、ステップ関数の入出力契約のうち authorization-request.test.ts と
 * 重複しないもの（成功値、エラーの redirectUri / state など）を固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveClientForAuthorization,
  resolveRequestObjectParams,
  resolveAuthorizationRedirectUri,
  rejectUnsupportedRequestParams,
  validateRequestObjectConsistency,
  validateResponseType,
  validateAuthorizationScope,
  validateAuthorizationCodePkce,
  validatePromptParameter,
  applyOfflineAccessPolicy,
  validateDisplayParameter,
  resolveMaxAge,
  parseClaimsRequestParameter,
  validateSupportedResponseType,
  validateClientResponseType,
  validateClientScope,
  requireAuthorizationScope,
  validateOpenIdScope,
  filterOfflineAccessScope,
  validateMaxAge,
  validateDefaultMaxAge,
  parsePromptValues,
  validatePromptValues,
  validatePromptNoneNotCombined,
  requireCodeChallenge,
  requireCodeChallengeMethod,
  validateCodeChallengeMethod,
  validateS256CodeChallenge,
  AuthorizationError,
  AuthorizationErrorCode,
} from './authorization-request.js';
import { findUnregisteredClientScopes, parseScope } from './scope.js';
import type {
  AuthorizationRequestParams,
  ClientInfo,
  ClientResolver,
} from './authorization-request.js';
import { arrayBufferToBase64Url, stringToArrayBuffer } from './crypto-utils.js';

// Helpers for building compact-JWS Request Objects (OIDC Core 1.0 §6.1).
function encodeSegment(value: unknown): string {
  return arrayBufferToBase64Url(stringToArrayBuffer(JSON.stringify(value)));
}

function buildUnsignedRequestObject(claims: Record<string, unknown>): string {
  // RFC 7515 §6: the "none" algorithm has an empty signature segment.
  return `${encodeSegment({ alg: 'none' })}.${encodeSegment(claims)}.`;
}

// Helper: create a ClientResolver from an array of clients
function createClientResolver(clients: ClientInfo[]): ClientResolver {
  return {
    findClient: async (clientId: string): Promise<ClientInfo | null> => {
      return clients.find((c) => c.clientId === clientId) ?? null;
    },
  };
}

const defaultClient: ClientInfo = {
  clientId: 'client123',
  redirectUris: ['https://client.example.org/cb'],
};

const redirectUri = 'https://client.example.org/cb';

function validParams(
  overrides?: Partial<AuthorizationRequestParams>
): AuthorizationRequestParams {
  return {
    response_type: 'code',
    client_id: 'client123',
    redirect_uri: 'https://client.example.org/cb',
    scope: 'openid',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    ...overrides,
  };
}

// Helper: capture the AuthorizationError thrown by a sync step (undefined if none)
function captureError(fn: () => unknown): AuthorizationError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as AuthorizationError;
  }
}

describe('resolveClientForAuthorization', () => {
  it('should return the client resolved from client_id', async () => {
    const client = await resolveClientForAuthorization(
      validParams(),
      createClientResolver([defaultClient])
    );

    expect(client).toEqual(defaultClient);
  });
});

describe('resolveRequestObjectParams', () => {
  it('should return copied params and no claims when request parameter is absent', async () => {
    const params = validParams();

    const result = await resolveRequestObjectParams(params, defaultClient);

    expect(result.requestObjectClaims).toBe(undefined);
    expect(result.effectiveParams).toEqual(params);
    // 引数は変更しない純粋関数（コピーを返す）
    expect(result.effectiveParams).not.toBe(params);
  });

  it('should overlay request object claims onto the query parameters', async () => {
    const request = buildUnsignedRequestObject({
      response_type: 'code',
      client_id: 'client123',
      scope: 'openid',
      state: 'ro-state',
      nonce: 'ro-nonce',
    });

    const result = await resolveRequestObjectParams(
      validParams({ request, state: 'query-state' }),
      defaultClient,
      { allowUnsigned: true }
    );

    // OIDC Core 1.0 §6.1: Request Object の値がクエリ値を supersede する
    expect(result.effectiveParams.state).toBe('ro-state');
    expect(result.effectiveParams.nonce).toBe('ro-nonce');
    expect(result.requestObjectClaims).toMatchObject({
      response_type: 'code',
      client_id: 'client123',
      state: 'ro-state',
      nonce: 'ro-nonce',
    });
  });

  it('should reject an unsigned request object when allowUnsigned is not enabled', async () => {
    const request = buildUnsignedRequestObject({
      response_type: 'code',
      client_id: 'client123',
    });

    const error = await resolveRequestObjectParams(
      validParams({ request }),
      defaultClient
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthorizationError);
    const authError = error as AuthorizationError;
    expect(authError.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
    expect(authError.redirectable).toBe(false);
  });
});

describe('resolveAuthorizationRedirectUri', () => {
  it('should reject an omitted redirect_uri when multiple URIs are registered', () => {
    const multiUriClient: ClientInfo = {
      clientId: 'client123',
      redirectUris: [
        'https://client.example.org/cb',
        'https://client.example.org/cb2',
      ],
    };

    const error = captureError(() =>
      resolveAuthorizationRedirectUri(
        validParams({ redirect_uri: undefined }),
        multiUriClient
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.redirectable).toBe(false);
  });
});

describe('rejectUnsupportedRequestParams', () => {
  it('should not reject request when requestParameterSupported is left default', () => {
    const error = captureError(() =>
      rejectUnsupportedRequestParams(
        validParams({ request: 'header.payload.sig' }),
        redirectUri,
        'abc'
      )
    );

    expect(error).toBe(undefined);
  });
});

describe('validateRequestObjectConsistency', () => {
  it('should pass when requestObjectClaims is undefined', () => {
    const error = captureError(() =>
      validateRequestObjectConsistency(validParams(), undefined, redirectUri, 'abc')
    );

    expect(error).toBe(undefined);
  });

  it('should pass when response_type and client_id match the query parameters', () => {
    const error = captureError(() =>
      validateRequestObjectConsistency(
        validParams(),
        { response_type: 'code', client_id: 'client123' },
        redirectUri,
        'abc'
      )
    );

    expect(error).toBe(undefined);
  });

  it('should reject a response_type mismatch with a redirectable invalid_request', () => {
    const error = captureError(() =>
      validateRequestObjectConsistency(
        validParams(),
        { response_type: 'token' },
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.redirectUri).toBe(redirectUri);
    expect(error?.state).toBe('abc');
  });

  it('should reject a client_id mismatch with a redirectable invalid_request', () => {
    const error = captureError(() =>
      validateRequestObjectConsistency(
        validParams(),
        { client_id: 'other-client' },
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.redirectUri).toBe(redirectUri);
  });
});

describe('validateResponseType', () => {
  it('should reject missing response_type with a redirectable invalid_request', () => {
    const error = captureError(() =>
      validateResponseType(
        validParams({ response_type: undefined }),
        defaultClient,
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.redirectUri).toBe(redirectUri);
    expect(error?.state).toBe('abc');
  });

  it('should reject unsupported response_type with unsupported_response_type', () => {
    const error = captureError(() =>
      validateResponseType(
        validParams({ response_type: 'token' }),
        defaultClient,
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.UnsupportedResponseType);
    expect(error?.redirectUri).toBe(redirectUri);
  });

  it('should reject a response_type the client is not registered for with unauthorized_client', () => {
    const restrictedClient: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      responseTypes: [],
    };

    const error = captureError(() =>
      validateResponseType(validParams(), restrictedClient, redirectUri, 'abc')
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.UnauthorizedClient);
    expect(error?.redirectUri).toBe(redirectUri);
  });
});

describe('validateAuthorizationScope', () => {
  it('should return the deduplicated scope array', () => {
    const params = validParams({ scope: 'openid profile openid' });

    const result = validateAuthorizationScope(params, params, redirectUri, 'abc');

    expect(result).toEqual(['openid', 'profile']);
  });

  it('should reject missing scope in the query parameters with invalid_request', () => {
    // OIDC Core 1.0 §6.1: scope は Request Object があってもクエリ側に必須
    const queryParams = validParams({ scope: undefined });
    const effectiveParams = validParams({ scope: 'openid' });

    const error = captureError(() =>
      validateAuthorizationScope(queryParams, effectiveParams, redirectUri, 'abc')
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.redirectUri).toBe(redirectUri);
  });

  it('should reject scope without openid with invalid_scope', () => {
    const params = validParams({ scope: 'profile email' });

    const error = captureError(() =>
      validateAuthorizationScope(params, params, redirectUri, 'abc')
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidScope);
    expect(error?.redirectUri).toBe(redirectUri);
    expect(error?.state).toBe('abc');
  });

  it('should use the effective scope when the request object supersedes the query', () => {
    const queryParams = validParams({ scope: 'openid' });
    const effectiveParams = validParams({ scope: 'openid profile' });

    const result = validateAuthorizationScope(
      queryParams,
      effectiveParams,
      redirectUri,
      'abc'
    );

    expect(result).toEqual(['openid', 'profile']);
  });
});

describe('validateAuthorizationCodePkce', () => {
  it('should reject missing code_challenge with a redirectable invalid_request', () => {
    const error = captureError(() =>
      validateAuthorizationCodePkce(
        validParams({ code_challenge: undefined, code_challenge_method: 'S256' }),
        defaultClient,
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.redirectUri).toBe(redirectUri);
  });
});

describe('validatePromptParameter', () => {
  it('should return undefined when prompt is absent', () => {
    const result = validatePromptParameter(validParams(), redirectUri, 'abc');

    expect(result).toBe(undefined);
  });

  it('should reject an invalid prompt value with a redirectable invalid_request', () => {
    const error = captureError(() =>
      validatePromptParameter(
        validParams({ prompt: 'signup' }),
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.redirectUri).toBe(redirectUri);
    expect(error?.state).toBe('abc');
  });
});

describe('applyOfflineAccessPolicy', () => {
  // RFC 7591 §2: grant_types の既定は ["authorization_code"] なので、offline_access を
  // 扱うケースでは refresh_token を登録したクライアントを渡す。
  const refreshGrantClient: ClientInfo = {
    clientId: 'client123',
    redirectUris: ['https://client.example.org/cb'],
    grantTypes: ['authorization_code', 'refresh_token'],
  };

  it('should return the scope unchanged when offline_access is not requested', async () => {
    const result = await applyOfflineAccessPolicy(
      ['openid', 'profile'],
      validParams({ scope: 'openid profile' }),
      undefined,
      refreshGrantClient
    );

    expect(result).toEqual(['openid', 'profile']);
  });
});

describe('validateDisplayParameter', () => {
  it('should reject an unsupported display value with a redirectable invalid_request', () => {
    const error = captureError(() =>
      validateDisplayParameter(
        validParams({ display: 'fullscreen' }),
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.redirectUri).toBe(redirectUri);
    expect(error?.state).toBe('abc');
  });
});

describe('resolveMaxAge', () => {
  it('should reject a non-integer max_age with a redirectable invalid_request', () => {
    const error = captureError(() =>
      resolveMaxAge(
        validParams({ max_age: 'abc' }),
        defaultClient,
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.redirectUri).toBe(redirectUri);
  });
});

describe('parseClaimsRequestParameter', () => {
  it('should reject invalid JSON with a redirectable invalid_request', () => {
    const error = captureError(() =>
      parseClaimsRequestParameter(
        validParams({ claims: '{not-json' }),
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.redirectUri).toBe(redirectUri);
    expect(error?.state).toBe('abc');
  });
});

describe('validateSupportedResponseType', () => {
  it('should accept code', () => {
    expect(validateSupportedResponseType('code', 'https://client.example/cb', 'state-1')).toBe('code');
  });

  it('should reject a missing response_type with invalid_request', () => {
    expect(() =>
      validateSupportedResponseType(undefined, 'https://client.example/cb', 'state-1'),
    ).toThrow(
      expect.objectContaining({
        error: 'invalid_request',
        redirectUri: 'https://client.example/cb',
        state: 'state-1',
      }),
    );
  });

  it('should reject token with unsupported_response_type', () => {
    expect(() =>
      validateSupportedResponseType('token', 'https://client.example/cb'),
    ).toThrow(expect.objectContaining({ error: 'unsupported_response_type' }));
  });
});

describe('validateClientResponseType', () => {
  it('should accept a response type registered for the client', () => {
    expect(
      validateClientResponseType('code', ['code'], 'https://client.example/cb'),
    ).toBeUndefined();
  });

  it('should accept code when the client has no registered response types', () => {
    expect(
      validateClientResponseType('code', undefined, 'https://client.example/cb'),
    ).toBeUndefined();
  });

  it('should reject a response type not registered for the client', () => {
    expect(() =>
      validateClientResponseType('code', [], 'https://client.example/cb'),
    ).toThrow(expect.objectContaining({ error: 'unauthorized_client' }));
  });
});

// RFC 7591 §2: the scope client metadata lists the scope values the client can
// request. Requesting a value outside it is invalid_scope (RFC 6749 §4.1.2.1).
describe('validateClientScope', () => {
  it('should accept scopes the client is registered for', () => {
    expect(
      validateClientScope(['openid', 'profile'], ['openid', 'profile', 'email'], 'https://client.example/cb'),
    ).toBeUndefined();
  });

  it('should accept any scope when the client has no registered scopes', () => {
    expect(
      validateClientScope(['openid', 'email'], undefined, 'https://client.example/cb'),
    ).toBeUndefined();
  });

  it('should reject a scope the client is not registered for with the request state', () => {
    expect(() =>
      validateClientScope(['openid', 'email', 'phone'], ['openid', 'profile'], 'https://client.example/cb', 'state-1'),
    ).toThrow(
      expect.objectContaining({
        error: 'invalid_scope',
        errorDescription: 'Client is not registered for scope: email phone',
        redirectUri: 'https://client.example/cb',
        state: 'state-1',
      }),
    );
  });

  it('should reject every scope when the client is registered for none', () => {
    expect(() => validateClientScope(['openid'], [], 'https://client.example/cb')).toThrow(
      expect.objectContaining({ error: 'invalid_scope' }),
    );
  });
});

describe('findUnregisteredClientScopes', () => {
  it('should return the requested scopes missing from the registration in request order', () => {
    expect(findUnregisteredClientScopes(['phone', 'openid', 'email'], ['openid'])).toEqual([
      'phone',
      'email',
    ]);
  });

  it('should return nothing when every requested scope is registered', () => {
    expect(findUnregisteredClientScopes(['openid', 'email'], ['email', 'openid'])).toEqual([]);
  });

  it('should return nothing when the client has no registered scopes', () => {
    expect(findUnregisteredClientScopes(['openid', 'email'], undefined)).toEqual([]);
  });
});

describe('requireAuthorizationScope', () => {
  it('should return the query scope', () => {
    expect(requireAuthorizationScope('openid email', 'https://client.example/cb')).toBe(
      'openid email',
    );
  });

  it('should reject an empty query scope', () => {
    expect(() => requireAuthorizationScope('', 'https://client.example/cb')).toThrow(
      'Missing required parameter: scope',
    );
  });
});

describe('parseScope', () => {
  // RFC 6749 §3.3: scope is a space-delimited set, so duplicates collapse
  it('should split on spaces and drop duplicates in insertion order', () => {
    expect(parseScope('openid  email openid')).toEqual(['openid', 'email']);
  });

  it('should return an empty array for a blank value', () => {
    expect(parseScope(' ')).toEqual([]);
  });
});

describe('validateOpenIdScope', () => {
  it('should accept a scope list containing openid', () => {
    expect(validateOpenIdScope(['email', 'openid'], 'https://client.example/cb')).toBeUndefined();
  });

  it('should reject a scope list without openid', () => {
    expect(() => validateOpenIdScope(['email'], 'https://client.example/cb')).toThrow(
      expect.objectContaining({ error: 'invalid_scope' }),
    );
  });
});

describe('filterOfflineAccessScope', () => {
  it('should keep offline_access when granted', () => {
    expect(filterOfflineAccessScope(['openid', 'offline_access'], true)).toEqual([
      'openid',
      'offline_access',
    ]);
  });

  it('should drop offline_access when not granted', () => {
    expect(filterOfflineAccessScope(['openid', 'offline_access'], false)).toEqual(['openid']);
  });
});

describe('validateMaxAge', () => {
  it('should accept zero', () => {
    expect(validateMaxAge('0', 'https://client.example/cb')).toBe(0);
  });

  it('should reject a negative value', () => {
    expect(() => validateMaxAge('-1', 'https://client.example/cb')).toThrow(
      'max_age must be a non-negative integer',
    );
  });
});

describe('validateDefaultMaxAge', () => {
  it('should accept a non-negative integer', () => {
    expect(validateDefaultMaxAge(60)).toBe(60);
  });

  it('should reject a fractional value with server_error', () => {
    expect(() => validateDefaultMaxAge(0.5)).toThrow(
      expect.objectContaining({ error: 'server_error' }),
    );
  });
});

describe('parsePromptValues', () => {
  it('should split prompt values on spaces', () => {
    expect(parsePromptValues('login  consent')).toEqual(['login', 'consent']);
  });

  it('should keep unknown values for the caller to validate', () => {
    expect(parsePromptValues('custom')).toEqual(['custom']);
  });
});

describe('validatePromptValues', () => {
  it('should accept defined prompt values', () => {
    expect(
      validatePromptValues(['login', 'consent', 'select_account'], 'https://client.example/cb'),
    ).toBeUndefined();
  });

  it('should reject an undefined prompt value', () => {
    expect(() =>
      validatePromptValues(['custom'], 'https://client.example/cb', 'state-1'),
    ).toThrow(
      expect.objectContaining({
        error: 'invalid_request',
        errorDescription: 'Invalid prompt value: custom',
        state: 'state-1',
      }),
    );
  });
});

describe('validatePromptNoneNotCombined', () => {
  it('should accept none alone', () => {
    expect(validatePromptNoneNotCombined(['none'], 'https://client.example/cb')).toBeUndefined();
  });

  it('should reject none combined with login', () => {
    expect(() =>
      validatePromptNoneNotCombined(['none', 'login'], 'https://client.example/cb', 'state-1'),
    ).toThrow(
      expect.objectContaining({
        error: 'invalid_request',
        redirectUri: 'https://client.example/cb',
        state: 'state-1',
      }),
    );
  });
});

describe('requireCodeChallenge', () => {
  it('should return the code_challenge', () => {
    expect(requireCodeChallenge('challenge', 'https://client.example/cb')).toBe('challenge');
  });

  it('should reject a missing code_challenge', () => {
    expect(() => requireCodeChallenge(undefined, 'https://client.example/cb')).toThrow(
      'Missing required parameter: code_challenge',
    );
  });
});

describe('requireCodeChallengeMethod', () => {
  it('should return the code_challenge_method', () => {
    expect(requireCodeChallengeMethod('S256', 'https://client.example/cb')).toBe('S256');
  });

  it('should reject a missing code_challenge_method', () => {
    expect(() => requireCodeChallengeMethod(undefined, 'https://client.example/cb')).toThrow(
      'Missing required parameter: code_challenge_method',
    );
  });
});

describe('validateCodeChallengeMethod', () => {
  it('should accept S256', () => {
    expect(validateCodeChallengeMethod('S256', 'https://client.example/cb')).toBe('S256');
  });

  // OAuth 2.1 §4.1.1: plain is not supported
  it('should reject plain', () => {
    expect(() => validateCodeChallengeMethod('plain', 'https://client.example/cb')).toThrow(
      'Unsupported code_challenge_method: plain',
    );
  });
});

describe('validateS256CodeChallenge', () => {
  // RFC 7636 §4.2: BASE64URL(SHA256(...)) without padding is 43 characters
  it('should accept a 43-character base64url value', () => {
    expect(
      validateS256CodeChallenge('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'https://client.example/cb'),
    ).toBeUndefined();
  });

  it('should reject a 42-character value', () => {
    expect(() =>
      validateS256CodeChallenge('a'.repeat(42), 'https://client.example/cb'),
    ).toThrow('code_challenge must be a 43-character base64url-encoded SHA-256 hash for S256');
  });

  it('should reject a 44-character value', () => {
    expect(() =>
      validateS256CodeChallenge('a'.repeat(44), 'https://client.example/cb'),
    ).toThrow('code_challenge must be a 43-character base64url-encoded SHA-256 hash for S256');
  });

  it('should reject characters outside base64url', () => {
    expect(() =>
      validateS256CodeChallenge('+'.repeat(43), 'https://client.example/cb'),
    ).toThrow(
      'code_challenge contains invalid characters (must be base64url: [A-Za-z0-9-_], 43 chars)',
    );
  });
});
