/**
 * 認可リクエスト検証の機能単位ステップ関数のテスト。
 *
 * CLI 生成コードはこれらのステップを個別に呼び出して、利用者が検証処理を
 * 消したり足したりできるようにする。ステップごとの網羅的な振る舞いは
 * authorization-request.test.ts が担保し、本ファイルは各ステップ関数の
 * 入出力契約（成功値と代表的なエラー）を固定する。
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
  parseAudienceParameter,
  parseClaimsRequestParameter,
  validateSupportedResponseType,
  validateClientResponseType,
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
import { parseScope } from './scope.js';
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

  it('should reject missing client_id with a non-redirectable invalid_request', async () => {
    const error = await resolveClientForAuthorization(
      validParams({ client_id: undefined as unknown as string }),
      createClientResolver([defaultClient])
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthorizationError);
    const authError = error as AuthorizationError;
    expect(authError.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(authError.redirectable).toBe(false);
  });

  it('should reject unknown client_id with a non-redirectable invalid_request', async () => {
    const error = await resolveClientForAuthorization(
      validParams({ client_id: 'unknown-client' }),
      createClientResolver([defaultClient])
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthorizationError);
    const authError = error as AuthorizationError;
    expect(authError.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(authError.redirectable).toBe(false);
  });

  it('should reject a resolver returning a mismatched clientId with server_error', async () => {
    const buggyResolver: ClientResolver = {
      findClient: async () => ({
        clientId: 'different-client',
        redirectUris: ['https://client.example.org/cb'],
      }),
    };

    const error = await resolveClientForAuthorization(
      validParams(),
      buggyResolver
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthorizationError);
    const authError = error as AuthorizationError;
    expect(authError.error).toBe(AuthorizationErrorCode.ServerError);
    expect(authError.redirectable).toBe(false);
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

  it('should reject a broken request JWT with a non-redirectable invalid_request_object', async () => {
    const error = await resolveRequestObjectParams(
      validParams({ request: 'not-a-jwt' }),
      defaultClient,
      { allowUnsigned: true }
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthorizationError);
    const authError = error as AuthorizationError;
    expect(authError.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
    expect(authError.redirectable).toBe(false);
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
  it('should return the redirect_uri when it matches a registered URI', () => {
    const result = resolveAuthorizationRedirectUri(validParams(), defaultClient);

    expect(result).toBe('https://client.example.org/cb');
  });

  it('should return the single registered URI when redirect_uri is omitted', () => {
    const result = resolveAuthorizationRedirectUri(
      validParams({ redirect_uri: undefined }),
      defaultClient
    );

    expect(result).toBe('https://client.example.org/cb');
  });

  it('should reject an unregistered redirect_uri with a non-redirectable invalid_request', () => {
    const error = captureError(() =>
      resolveAuthorizationRedirectUri(
        validParams({ redirect_uri: 'https://evil.example.org/cb' }),
        defaultClient
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.redirectable).toBe(false);
  });

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
  it('should pass when request, request_uri and registration are all absent', () => {
    const error = captureError(() =>
      rejectUnsupportedRequestParams(validParams(), redirectUri, 'abc')
    );

    expect(error).toBe(undefined);
  });

  it('should reject request_uri with a redirectable request_uri_not_supported', () => {
    const error = captureError(() =>
      rejectUnsupportedRequestParams(
        validParams({ request_uri: 'https://client.example.org/request.jwt' }),
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.RequestUriNotSupported);
    expect(error?.redirectUri).toBe(redirectUri);
    expect(error?.state).toBe('abc');
  });

  it('should reject registration with a redirectable registration_not_supported', () => {
    const error = captureError(() =>
      rejectUnsupportedRequestParams(
        validParams({ registration: '{"policy_uri":"https://rp.example.org"}' }),
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.RegistrationNotSupported);
    expect(error?.redirectUri).toBe(redirectUri);
  });

  it('should reject request with request_not_supported when requestParameterSupported is false', () => {
    const error = captureError(() =>
      rejectUnsupportedRequestParams(
        validParams({ request: 'header.payload.sig' }),
        redirectUri,
        'abc',
        { requestParameterSupported: false }
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.RequestNotSupported);
    expect(error?.redirectUri).toBe(redirectUri);
  });

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
  it('should return code for response_type=code', () => {
    const result = validateResponseType(validParams(), defaultClient, redirectUri, 'abc');

    expect(result).toBe('code');
  });

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
  it('should return the code_challenge and S256 method', () => {
    const result = validateAuthorizationCodePkce(
      validParams(),
      defaultClient,
      redirectUri,
      'abc'
    );

    expect(result).toEqual({
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
    });
  });

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

  it('should reject unsupported code_challenge_method plain', () => {
    const error = captureError(() =>
      validateAuthorizationCodePkce(
        validParams({ code_challenge_method: 'plain' }),
        defaultClient,
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
  });

  it('should allow omitted PKCE for a confidential client in compatibility mode', () => {
    const confidentialClient: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      clientType: 'confidential',
    };

    const result = validateAuthorizationCodePkce(
      validParams({ code_challenge: undefined, code_challenge_method: undefined }),
      confidentialClient,
      redirectUri,
      'abc',
      { allowNonPkceAuthorizationCodeFlow: true }
    );

    expect(result).toEqual({});
  });

  it('should still require PKCE for a public client in compatibility mode', () => {
    const publicClient: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      clientType: 'public',
    };

    const error = captureError(() =>
      validateAuthorizationCodePkce(
        validParams({ code_challenge: undefined, code_challenge_method: undefined }),
        publicClient,
        redirectUri,
        'abc',
        { allowNonPkceAuthorizationCodeFlow: true }
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
  });
});

describe('validatePromptParameter', () => {
  it('should return undefined when prompt is absent', () => {
    const result = validatePromptParameter(validParams(), redirectUri, 'abc');

    expect(result).toBe(undefined);
  });

  it('should return the prompt values as an array', () => {
    const result = validatePromptParameter(
      validParams({ prompt: 'login consent' }),
      redirectUri,
      'abc'
    );

    expect(result).toEqual(['login', 'consent']);
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

  it('should reject none combined with other prompt values', () => {
    const error = captureError(() =>
      validatePromptParameter(
        validParams({ prompt: 'none login' }),
        redirectUri,
        'abc'
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
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

  it('should keep offline_access when prompt includes consent', async () => {
    const result = await applyOfflineAccessPolicy(
      ['openid', 'offline_access'],
      validParams({ scope: 'openid offline_access', prompt: 'consent' }),
      ['consent'],
      refreshGrantClient
    );

    expect(result).toEqual(['openid', 'offline_access']);
  });

  it('should drop offline_access when prompt does not include consent', async () => {
    // OIDC Core 1.0 §11: 許可条件を満たさない offline_access 要求は無視する（MUST）
    const result = await applyOfflineAccessPolicy(
      ['openid', 'offline_access'],
      validParams({ scope: 'openid offline_access' }),
      undefined,
      refreshGrantClient
    );

    expect(result).toEqual(['openid']);
  });

  it('should drop offline_access when the client does not register the refresh_token grant type', async () => {
    // RFC 7591 §2: grant_types 未登録 = ["authorization_code"]。発行しても使えない
    // Refresh Token を配らないよう、認可の時点で offline_access を落とす。
    const result = await applyOfflineAccessPolicy(
      ['openid', 'offline_access'],
      validParams({ scope: 'openid offline_access', prompt: 'consent' }),
      ['consent'],
      { clientId: 'client123', redirectUris: ['https://client.example.org/cb'] }
    );

    expect(result).toEqual(['openid']);
  });

  it('should return the scope unchanged when offline_access is not requested', async () => {
    const result = await applyOfflineAccessPolicy(
      ['openid', 'profile'],
      validParams({ scope: 'openid profile' }),
      undefined,
      refreshGrantClient
    );

    expect(result).toEqual(['openid', 'profile']);
  });

  it('should honor a custom isOfflineAccessGranted callback', async () => {
    const result = await applyOfflineAccessPolicy(
      ['openid', 'offline_access'],
      validParams({ scope: 'openid offline_access' }),
      undefined,
      refreshGrantClient,
      () => true
    );

    expect(result).toEqual(['openid', 'offline_access']);
  });
});

describe('validateDisplayParameter', () => {
  it('should return undefined when display is absent', () => {
    const result = validateDisplayParameter(validParams(), redirectUri, 'abc');

    expect(result).toBe(undefined);
  });

  it('should return a valid display value', () => {
    const result = validateDisplayParameter(
      validParams({ display: 'page' }),
      redirectUri,
      'abc'
    );

    expect(result).toBe('page');
  });

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
  it('should return undefined when neither max_age nor default_max_age is set', () => {
    const result = resolveMaxAge(validParams(), defaultClient, redirectUri, 'abc');

    expect(result).toBe(undefined);
  });

  it('should return the parsed max_age', () => {
    const result = resolveMaxAge(
      validParams({ max_age: '3600' }),
      defaultClient,
      redirectUri,
      'abc'
    );

    expect(result).toBe(3600);
  });

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

  it('should fall back to the registered default_max_age when max_age is absent', () => {
    const clientWithDefault: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      defaultMaxAge: 86400,
    };

    const result = resolveMaxAge(validParams(), clientWithDefault, redirectUri, 'abc');

    expect(result).toBe(86400);
  });

  it('should prefer the request max_age over the registered default_max_age', () => {
    const clientWithDefault: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      defaultMaxAge: 86400,
    };

    const result = resolveMaxAge(
      validParams({ max_age: '60' }),
      clientWithDefault,
      redirectUri,
      'abc'
    );

    expect(result).toBe(60);
  });

  it('should reject a negative registered default_max_age with server_error', () => {
    const misconfiguredClient: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      defaultMaxAge: -1,
    };

    const error = captureError(() =>
      resolveMaxAge(validParams(), misconfiguredClient, redirectUri, 'abc')
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
  });
});

describe('parseAudienceParameter', () => {
  it('should return undefined when audience is absent', () => {
    const result = parseAudienceParameter(validParams());

    expect(result).toBe(undefined);
  });

  it('should split the space-delimited audience into an array', () => {
    const result = parseAudienceParameter(
      validParams({ audience: 'https://api.example.org https://api2.example.org' })
    );

    expect(result).toEqual([
      'https://api.example.org',
      'https://api2.example.org',
    ]);
  });
});

describe('parseClaimsRequestParameter', () => {
  it('should return undefined when claims is absent', () => {
    const result = parseClaimsRequestParameter(validParams(), redirectUri, 'abc');

    expect(result).toBe(undefined);
  });

  it('should parse userinfo and id_token members', () => {
    const result = parseClaimsRequestParameter(
      validParams({
        claims: JSON.stringify({
          userinfo: { email: { essential: true } },
          id_token: { acr: { values: ['urn:example:loa:2'] } },
        }),
      }),
      redirectUri,
      'abc'
    );

    expect(result).toEqual({
      userinfo: { email: { essential: true } },
      id_token: { acr: { values: ['urn:example:loa:2'] } },
    });
  });

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

  it('should reject claims exceeding the maximum allowed length', () => {
    const error = captureError(() =>
      parseClaimsRequestParameter(
        validParams({ claims: JSON.stringify({ userinfo: { email: null } }) }),
        redirectUri,
        'abc',
        10
      )
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
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
