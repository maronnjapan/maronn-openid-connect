import { describe, expect, it } from 'vitest';
import type { AccessTokenInfo, AccessTokenResolver, TokenClientInfo } from '@maronn-openid-connect/core';
import {
  ACTOR_TOKEN_INVALID_DESCRIPTION,
  SUBJECT_TOKEN_INVALID_DESCRIPTION,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ACCESS_TOKEN,
  TokenExchangeError,
  authorizeTokenExchangeClient,
  buildTokenExchangeResponse,
  composeActClaim,
  computeExchangedTokenLifetime,
  parseTokenExchangeParams,
  processTokenExchangeRequest,
  resolveActorToken,
  resolveExchangeTarget,
  resolveSubjectToken,
  validateExchangeScope,
  type ExchangedAccessTokenInfo,
} from './token-exchange-request.js';

/** 2026-01-01T00:00:00Z。Unix epoch 秒で 1767225600。 */
const NOW = new Date('2026-01-01T00:00:00Z');
const NOW_SECONDS = 1767225600;

function confidentialClient(overrides: Partial<TokenClientInfo> = {}): TokenClientInfo {
  return {
    clientId: 'exchange-client',
    clientSecret: 'secret',
    grantTypes: ['authorization_code', TOKEN_EXCHANGE_GRANT_TYPE],
    tokenEndpointAuthMethod: 'client_secret_basic',
    ...overrides,
  };
}

function subjectTokenInfo(overrides: Partial<AccessTokenInfo> = {}): AccessTokenInfo {
  return {
    sub: 'user-1',
    scope: ['openid', 'profile', 'api:read'],
    clientId: 'front-api',
    expiresAt: NOW_SECONDS + 300,
    grantId: 'grant-1',
    audience: ['https://op.example.com/userinfo'],
    ...overrides,
  };
}

function resolverFor(info: AccessTokenInfo | null): AccessTokenResolver {
  return {
    findAccessToken: async () => info,
  };
}

/** delegation テスト用: トークン文字列ごとに別の情報を返す resolver。 */
function resolverByToken(map: Record<string, AccessTokenInfo>): AccessTokenResolver {
  return {
    findAccessToken: async (token) => map[token] ?? null,
  };
}

function validParams(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: 'subject-access-token',
    subject_token_type: TOKEN_TYPE_ACCESS_TOKEN,
    ...overrides,
  };
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) params[key] = value;
  }
  return params;
}

describe('token exchange constants', () => {
  // RFC 8693 §2.1 / §3
  it('should expose the RFC 8693 grant type URN', () => {
    expect(TOKEN_EXCHANGE_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
  });

  it('should expose the RFC 8693 access token type URN', () => {
    expect(TOKEN_TYPE_ACCESS_TOKEN).toBe('urn:ietf:params:oauth:token-type:access_token');
  });
});

describe('TokenExchangeError', () => {
  it('should expose the error code as given', () => {
    expect(new TokenExchangeError('invalid_target', 'nope').code).toBe('invalid_target');
  });

  // 401 を返すのはクライアント認証失敗のみで、それは分岐より前の共有パイプラインが担う。
  it('should always report status code 400', () => {
    expect(new TokenExchangeError('invalid_request', 'nope').statusCode).toBe(400);
  });

  // RFC 6749 §5.2: error_description は %x20-21 / %x23-5B / %x5D-7E に限定される。
  // core の sanitizeErrorDescription は範囲外の文字（改行・二重引用符）を '?' に置換する。
  it('should sanitize control characters out of the error description', () => {
    expect(new TokenExchangeError('invalid_request', 'bad\n"value"').errorDescription).toBe(
      'bad??value?',
    );
  });

  it('should set the error name to TokenExchangeError', () => {
    expect(new TokenExchangeError('invalid_scope', 'nope').name).toBe('TokenExchangeError');
  });
});

describe('parseTokenExchangeParams', () => {
  describe('Valid requests', () => {
    it('should return only the subject token when no optional parameter is present', () => {
      expect(parseTokenExchangeParams(validParams())).toEqual({
        subjectToken: 'subject-access-token',
        scope: undefined,
        audience: undefined,
        resource: undefined,
        actorToken: undefined,
      });
    });

    it('should return every optional parameter when all are present', () => {
      const params = validParams({
        scope: 'api:read',
        audience: 'internal-api',
        resource: 'https://internal.example.com/api',
        requested_token_type: TOKEN_TYPE_ACCESS_TOKEN,
        actor_token: 'actor-access-token',
        actor_token_type: TOKEN_TYPE_ACCESS_TOKEN,
      });
      expect(parseTokenExchangeParams(params)).toEqual({
        subjectToken: 'subject-access-token',
        scope: 'api:read',
        audience: 'internal-api',
        resource: 'https://internal.example.com/api',
        actorToken: 'actor-access-token',
      });
    });

    // 空文字のフォームフィールドは「送られなかった」と同じに扱う（本仕様の設計判断）。
    it('should treat a blank optional parameter as omitted', () => {
      const params = validParams({ scope: '', audience: '  ', resource: '' });
      expect(parseTokenExchangeParams(params)).toEqual({
        subjectToken: 'subject-access-token',
        scope: undefined,
        audience: undefined,
        resource: undefined,
        actorToken: undefined,
      });
    });

    // RFC 8693 §2.1: resource は絶対 URI。query は許容される。
    it('should accept a resource with a query component', () => {
      const params = validParams({ resource: 'https://internal.example.com/api?tenant=a' });
      expect(parseTokenExchangeParams(params).resource).toBe(
        'https://internal.example.com/api?tenant=a',
      );
    });

    // RFC 8693 §2.1: requested_token_type は OPTIONAL。省略時はアクセストークンを発行する。
    it('should accept an omitted requested_token_type', () => {
      expect(parseTokenExchangeParams(validParams()).subjectToken).toBe('subject-access-token');
    });
  });

  describe('Missing required parameters', () => {
    it('should reject a missing subject_token with invalid_request', () => {
      const params = validParams({ subject_token: undefined });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError('invalid_request', 'subject_token is required'),
      );
    });

    it('should reject a blank subject_token with invalid_request', () => {
      const params = validParams({ subject_token: '   ' });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError('invalid_request', 'subject_token is required'),
      );
    });

    it('should reject a missing subject_token_type with invalid_request', () => {
      const params = validParams({ subject_token_type: undefined });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError('invalid_request', 'subject_token_type is required'),
      );
    });
  });

  describe('Unsupported token types', () => {
    // 非目標: id_token / refresh_token / jwt / saml の subject_token_type は受け付けない。
    it('should reject an id_token subject_token_type with invalid_request', () => {
      const params = validParams({
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError(
          'invalid_request',
          'Unsupported subject_token_type. Only urn:ietf:params:oauth:token-type:access_token is supported.',
        ),
      );
    });

    it('should reject a refresh_token subject_token_type with invalid_request', () => {
      const params = validParams({
        subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
      });
      expect(() => parseTokenExchangeParams(params)).toThrow(TokenExchangeError);
    });

    it('should reject an id_token requested_token_type with invalid_request', () => {
      const params = validParams({
        requested_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError(
          'invalid_request',
          'Unsupported requested_token_type. Only urn:ietf:params:oauth:token-type:access_token is supported.',
        ),
      );
    });
  });

  describe('Delegation parameters (RFC 8693 §2.1)', () => {
    it('should return the actor token when actor_token and actor_token_type are present', () => {
      const params = validParams({
        actor_token: 'actor-access-token',
        actor_token_type: TOKEN_TYPE_ACCESS_TOKEN,
      });
      expect(parseTokenExchangeParams(params)).toEqual({
        subjectToken: 'subject-access-token',
        scope: undefined,
        audience: undefined,
        resource: undefined,
        actorToken: 'actor-access-token',
      });
    });

    // RFC 8693 §2.1: actor_token_type は actor_token があるとき REQUIRED。
    it('should reject actor_token without actor_token_type with invalid_request', () => {
      const params = validParams({ actor_token: 'actor-access-token' });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError(
          'invalid_request',
          'actor_token_type is required when actor_token is present',
        ),
      );
    });

    // RFC 8693 §2.1: actor_token_type は actor_token が無いとき MUST NOT be included。
    it('should reject actor_token_type without actor_token with invalid_request', () => {
      const params = validParams({ actor_token_type: TOKEN_TYPE_ACCESS_TOKEN });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError(
          'invalid_request',
          'actor_token_type must not be present without actor_token',
        ),
      );
    });

    // 空文字の actor_token は「送られなかった」扱い。残った actor_token_type が
    // 単独指定として拒否される。
    it('should treat a blank actor_token as omitted and reject the remaining actor_token_type', () => {
      const params = validParams({
        actor_token: '   ',
        actor_token_type: TOKEN_TYPE_ACCESS_TOKEN,
      });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError(
          'invalid_request',
          'actor_token_type must not be present without actor_token',
        ),
      );
    });

    it('should reject an id_token actor_token_type with invalid_request', () => {
      const params = validParams({
        actor_token: 'actor-access-token',
        actor_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError(
          'invalid_request',
          'Unsupported actor_token_type. Only urn:ietf:params:oauth:token-type:access_token is supported.',
        ),
      );
    });
  });

  describe('resource syntax (RFC 8693 §2.1)', () => {
    it('should reject a relative resource with invalid_request', () => {
      const params = validParams({ resource: '/api' });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError(
          'invalid_request',
          'resource must be an absolute URI without a fragment component',
        ),
      );
    });

    it('should reject a resource carrying a fragment with invalid_request', () => {
      const params = validParams({ resource: 'https://internal.example.com/api#section' });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError(
          'invalid_request',
          'resource must be an absolute URI without a fragment component',
        ),
      );
    });

    it('should reject a resource with an empty fragment with invalid_request', () => {
      const params = validParams({ resource: 'https://internal.example.com/api#' });
      expect(() => parseTokenExchangeParams(params)).toThrow(
        new TokenExchangeError(
          'invalid_request',
          'resource must be an absolute URI without a fragment component',
        ),
      );
    });
  });
});

describe('authorizeTokenExchangeClient', () => {
  it('should accept a confidential client registered for the exchange grant', () => {
    expect(authorizeTokenExchangeClient(confidentialClient())).toBeUndefined();
  });

  it('should accept a client_secret_post client registered for the exchange grant', () => {
    const client = confidentialClient({ tokenEndpointAuthMethod: 'client_secret_post' });
    expect(authorizeTokenExchangeClient(client)).toBeUndefined();
  });

  // RFC 6749 §5.2 / OIDC Dynamic Client Registration §2: 未指定の grantTypes は
  // ['authorization_code'] 扱いなので、交換は常に拒否される。
  it('should reject a client whose grantTypes omit the exchange URN with unauthorized_client', () => {
    const client = confidentialClient({ grantTypes: ['authorization_code', 'refresh_token'] });
    expect(() => authorizeTokenExchangeClient(client)).toThrow(
      new TokenExchangeError(
        'unauthorized_client',
        'The client is not authorized to use the token-exchange grant type',
      ),
    );
  });

  it('should reject a client with unspecified grantTypes with unauthorized_client', () => {
    const client = confidentialClient({ grantTypes: undefined });
    expect(() => authorizeTokenExchangeClient(client)).toThrow(
      new TokenExchangeError(
        'unauthorized_client',
        'The client is not authorized to use the token-exchange grant type',
      ),
    );
  });

  // RFC 8693 §2.1 の注記（窃取トークンの STS 経由の増幅）に対する設計判断。
  it('should reject a public client with unauthorized_client', () => {
    const client = confidentialClient({
      tokenEndpointAuthMethod: 'none',
      clientSecret: undefined,
    });
    expect(() => authorizeTokenExchangeClient(client)).toThrow(
      new TokenExchangeError(
        'unauthorized_client',
        'Public clients are not allowed to use the token-exchange grant type',
      ),
    );
  });
});

describe('resolveSubjectToken', () => {
  it('should return the resolved access token info when the token is valid', async () => {
    const info = subjectTokenInfo();
    const resolved = await resolveSubjectToken({
      subjectToken: 'subject-access-token',
      accessTokenResolver: resolverFor(info),
      now: NOW,
    });
    expect(resolved).toEqual(info);
  });

  it('should accept a token whose nbf is exactly now', async () => {
    const info = subjectTokenInfo({ nbf: NOW_SECONDS });
    const resolved = await resolveSubjectToken({
      subjectToken: 'subject-access-token',
      accessTokenResolver: resolverFor(info),
      now: NOW,
    });
    expect(resolved).toEqual(info);
  });

  it('should pass the subject token through to the resolver', async () => {
    const seen: string[] = [];
    const resolver: AccessTokenResolver = {
      findAccessToken: async (token) => {
        seen.push(token);
        return subjectTokenInfo();
      },
    };
    await resolveSubjectToken({
      subjectToken: 'subject-access-token',
      accessTokenResolver: resolver,
      now: NOW,
    });
    expect(seen).toEqual(['subject-access-token']);
  });

  describe('Invalid subject tokens', () => {
    // オラクル化防止: 失敗種別を error_description から区別できないようにする。
    it('should reject an unknown token with the fixed invalid_request description', async () => {
      await expect(
        resolveSubjectToken({
          subjectToken: 'unknown',
          accessTokenResolver: resolverFor(null),
          now: NOW,
        }),
      ).rejects.toThrow(new TokenExchangeError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION));
    });

    it('should reject an expired token with the fixed invalid_request description', async () => {
      await expect(
        resolveSubjectToken({
          subjectToken: 'expired',
          accessTokenResolver: resolverFor(subjectTokenInfo({ expiresAt: NOW_SECONDS - 1 })),
          now: NOW,
        }),
      ).rejects.toThrow(new TokenExchangeError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION));
    });

    it('should reject a token expiring exactly now with the fixed invalid_request description', async () => {
      await expect(
        resolveSubjectToken({
          subjectToken: 'expired-now',
          accessTokenResolver: resolverFor(subjectTokenInfo({ expiresAt: NOW_SECONDS })),
          now: NOW,
        }),
      ).rejects.toThrow(new TokenExchangeError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION));
    });

    it('should reject a token whose nbf is in the future with the fixed invalid_request description', async () => {
      await expect(
        resolveSubjectToken({
          subjectToken: 'not-yet',
          accessTokenResolver: resolverFor(subjectTokenInfo({ nbf: NOW_SECONDS + 1 })),
          now: NOW,
        }),
      ).rejects.toThrow(new TokenExchangeError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION));
    });

    it('should report the same error code for every failure kind', async () => {
      const codes: string[] = [];
      const cases: Array<AccessTokenInfo | null> = [
        null,
        subjectTokenInfo({ expiresAt: NOW_SECONDS - 1 }),
        subjectTokenInfo({ nbf: NOW_SECONDS + 1 }),
      ];
      for (const info of cases) {
        await resolveSubjectToken({
          subjectToken: 'x',
          accessTokenResolver: resolverFor(info),
          now: NOW,
        }).catch((error: TokenExchangeError) => {
          codes.push(`${error.code}:${error.errorDescription}`);
        });
      }
      expect(codes).toEqual([
        `invalid_request:${SUBJECT_TOKEN_INVALID_DESCRIPTION}`,
        `invalid_request:${SUBJECT_TOKEN_INVALID_DESCRIPTION}`,
        `invalid_request:${SUBJECT_TOKEN_INVALID_DESCRIPTION}`,
      ]);
    });
  });
});

describe('resolveActorToken', () => {
  it('should return the resolved access token info when the actor token is valid', async () => {
    const info = subjectTokenInfo({ sub: 'service-a', clientId: 'gateway' });
    const resolved = await resolveActorToken({
      actorToken: 'actor-access-token',
      accessTokenResolver: resolverFor(info),
      now: NOW,
    });
    expect(resolved).toEqual(info);
  });

  it('should pass the actor token through to the resolver', async () => {
    const seen: string[] = [];
    const resolver: AccessTokenResolver = {
      findAccessToken: async (token) => {
        seen.push(token);
        return subjectTokenInfo();
      },
    };
    await resolveActorToken({ actorToken: 'actor-access-token', accessTokenResolver: resolver, now: NOW });
    expect(seen).toEqual(['actor-access-token']);
  });

  describe('Invalid actor tokens', () => {
    // subject_token と同じオラクル排除方針: 失敗理由は応答から区別できない。
    it('should reject an unknown actor token with the fixed invalid_request description', async () => {
      await expect(
        resolveActorToken({
          actorToken: 'unknown',
          accessTokenResolver: resolverFor(null),
          now: NOW,
        }),
      ).rejects.toThrow(new TokenExchangeError('invalid_request', ACTOR_TOKEN_INVALID_DESCRIPTION));
    });

    it('should reject an expired actor token with the fixed invalid_request description', async () => {
      await expect(
        resolveActorToken({
          actorToken: 'expired',
          accessTokenResolver: resolverFor(subjectTokenInfo({ expiresAt: NOW_SECONDS - 1 })),
          now: NOW,
        }),
      ).rejects.toThrow(new TokenExchangeError('invalid_request', ACTOR_TOKEN_INVALID_DESCRIPTION));
    });

    it('should reject an actor token whose nbf is in the future with the fixed invalid_request description', async () => {
      await expect(
        resolveActorToken({
          actorToken: 'not-yet-valid',
          accessTokenResolver: resolverFor(subjectTokenInfo({ nbf: NOW_SECONDS + 1 })),
          now: NOW,
        }),
      ).rejects.toThrow(new TokenExchangeError('invalid_request', ACTOR_TOKEN_INVALID_DESCRIPTION));
    });
  });
});

describe('composeActClaim', () => {
  // RFC 8693 §4.1: act claim は現在の actor を識別する。
  it('should build a single-level act claim for the first delegation', () => {
    expect(composeActClaim({ actorSub: 'service-a' })).toEqual({ sub: 'service-a' });
  });

  // RFC 8693 §4.1: 委譲チェーンは act のネストで表す。最外が現在の actor、
  // ネストが過去の actor（最も古い actor が最深）。
  it('should nest the subject token act chain under the current actor', () => {
    expect(
      composeActClaim({
        actorSub: 'service-b',
        subjectActChain: { sub: 'service-a' },
      }),
    ).toEqual({ sub: 'service-b', act: { sub: 'service-a' } });
  });

  it('should keep a two-level prior chain intact under the current actor', () => {
    expect(
      composeActClaim({
        actorSub: 'service-c',
        subjectActChain: { sub: 'service-b', act: { sub: 'service-a' } },
      }),
    ).toEqual({
      sub: 'service-c',
      act: { sub: 'service-b', act: { sub: 'service-a' } },
    });
  });
});

describe('validateExchangeScope', () => {
  it('should inherit the subject scope when scope is omitted', () => {
    expect(validateExchangeScope(undefined, ['openid', 'profile'])).toEqual(['openid', 'profile']);
  });

  it('should inherit the subject scope when scope is blank', () => {
    expect(validateExchangeScope('   ', ['openid', 'profile'])).toEqual(['openid', 'profile']);
  });

  it('should return the requested subset in the requested order', () => {
    expect(validateExchangeScope('api:read openid', ['openid', 'profile', 'api:read'])).toEqual([
      'api:read',
      'openid',
    ]);
  });

  it('should return the full subject scope when every value is requested', () => {
    expect(validateExchangeScope('openid profile', ['openid', 'profile'])).toEqual([
      'openid',
      'profile',
    ]);
  });

  it('should collapse duplicate requested values', () => {
    expect(validateExchangeScope('openid openid', ['openid', 'profile'])).toEqual(['openid']);
  });

  it('should ignore repeated whitespace between scope values', () => {
    expect(validateExchangeScope('openid   profile', ['openid', 'profile'])).toEqual([
      'openid',
      'profile',
    ]);
  });

  // 権限昇格の防止: 交換で scope は単調に縮小する。
  it('should reject a scope value outside the subject scope with invalid_scope', () => {
    expect(() => validateExchangeScope('openid admin', ['openid', 'profile'])).toThrow(
      new TokenExchangeError(
        'invalid_scope',
        'The requested scope exceeds the scope of the subject_token',
      ),
    );
  });

  it('should reject a scope request against an empty subject scope with invalid_scope', () => {
    expect(() => validateExchangeScope('openid', [])).toThrow(
      new TokenExchangeError(
        'invalid_scope',
        'The requested scope exceeds the scope of the subject_token',
      ),
    );
  });
});

describe('resolveExchangeTarget', () => {
  it('should inherit the subject audience when neither audience nor resource is given', () => {
    expect(
      resolveExchangeTarget({
        allowedTargets: ['internal-api'],
        subjectAudience: ['https://op.example.com/userinfo'],
      }),
    ).toEqual(['https://op.example.com/userinfo']);
  });

  it('should return undefined when nothing is requested and the subject has no audience', () => {
    expect(resolveExchangeTarget({ allowedTargets: ['internal-api'] })).toBeUndefined();
  });

  it('should return the requested audience when it is allowed', () => {
    expect(
      resolveExchangeTarget({ audience: 'internal-api', allowedTargets: ['internal-api'] }),
    ).toEqual(['internal-api']);
  });

  it('should return the requested resource when it is allowed', () => {
    expect(
      resolveExchangeTarget({
        resource: 'https://internal.example.com/api',
        allowedTargets: ['https://internal.example.com/api'],
      }),
    ).toEqual(['https://internal.example.com/api']);
  });

  // RFC 8693 §2.1 は audience と resource の併用を許容する。
  it('should return both targets when audience and resource are used together', () => {
    expect(
      resolveExchangeTarget({
        audience: 'internal-api',
        resource: 'https://internal.example.com/api',
        allowedTargets: ['internal-api', 'https://internal.example.com/api'],
      }),
    ).toEqual(['internal-api', 'https://internal.example.com/api']);
  });

  it('should collapse audience and resource when they name the same target', () => {
    expect(
      resolveExchangeTarget({
        audience: 'https://internal.example.com/api',
        resource: 'https://internal.example.com/api',
        allowedTargets: ['https://internal.example.com/api'],
      }),
    ).toEqual(['https://internal.example.com/api']);
  });

  it('should ignore the subject audience when a target is requested explicitly', () => {
    expect(
      resolveExchangeTarget({
        audience: 'internal-api',
        allowedTargets: ['internal-api'],
        subjectAudience: ['https://op.example.com/userinfo'],
      }),
    ).toEqual(['internal-api']);
  });

  describe('Disallowed targets', () => {
    // error_description は allowedTargets の内容を露出しない固定文言。
    it('should reject an audience outside allowedTargets with invalid_target', () => {
      expect(() =>
        resolveExchangeTarget({ audience: 'other-api', allowedTargets: ['internal-api'] }),
      ).toThrow(
        new TokenExchangeError(
          'invalid_target',
          'The requested target is not allowed for token exchange',
        ),
      );
    });

    it('should reject a resource outside allowedTargets with invalid_target', () => {
      expect(() =>
        resolveExchangeTarget({
          resource: 'https://other.example.com/api',
          allowedTargets: ['https://internal.example.com/api'],
        }),
      ).toThrow(
        new TokenExchangeError(
          'invalid_target',
          'The requested target is not allowed for token exchange',
        ),
      );
    });

    // 安全側デフォルト: allowedTargets が空なら対象指定付き交換はすべて拒否される。
    it('should reject any requested audience when allowedTargets is empty', () => {
      expect(() => resolveExchangeTarget({ audience: 'internal-api', allowedTargets: [] })).toThrow(
        new TokenExchangeError(
          'invalid_target',
          'The requested target is not allowed for token exchange',
        ),
      );
    });

    it('should reject a target that only partially matches an allowed entry', () => {
      expect(() =>
        resolveExchangeTarget({ audience: 'internal', allowedTargets: ['internal-api'] }),
      ).toThrow(
        new TokenExchangeError(
          'invalid_target',
          'The requested target is not allowed for token exchange',
        ),
      );
    });
  });
});

describe('computeExchangedTokenLifetime', () => {
  it('should use the configured lifetime when it is shorter than the remaining lifetime', () => {
    expect(
      computeExchangedTokenLifetime({
        subjectExpiresAt: NOW_SECONDS + 3600,
        configuredExpiresIn: 300,
        now: NOW,
      }),
    ).toBe(300);
  });

  // トークン寿命の洗浄の防止: 交換で寿命は延びない。
  it('should cap the lifetime to the remaining lifetime of the subject token', () => {
    expect(
      computeExchangedTokenLifetime({
        subjectExpiresAt: NOW_SECONDS + 300,
        configuredExpiresIn: 3600,
        now: NOW,
      }),
    ).toBe(300);
  });

  it('should return the shared value when both lifetimes are equal', () => {
    expect(
      computeExchangedTokenLifetime({
        subjectExpiresAt: NOW_SECONDS + 3600,
        configuredExpiresIn: 3600,
        now: NOW,
      }),
    ).toBe(3600);
  });

  // 丸め規則の固定検証（仕様書バリデーション 9）: 残存 1 秒でも expires_in は 0 にならない。
  it('should return 1 when only one second of the subject lifetime remains', () => {
    expect(
      computeExchangedTokenLifetime({
        subjectExpiresAt: NOW_SECONDS + 1,
        configuredExpiresIn: 3600,
        now: NOW,
      }),
    ).toBe(1);
  });

  it('should floor a sub-second current time when computing the remaining lifetime', () => {
    expect(
      computeExchangedTokenLifetime({
        subjectExpiresAt: NOW_SECONDS + 10,
        configuredExpiresIn: 3600,
        now: new Date(NOW.getTime() + 900),
      }),
    ).toBe(10);
  });

  it('should reject an already expired subject token with the fixed invalid_request description', () => {
    expect(() =>
      computeExchangedTokenLifetime({
        subjectExpiresAt: NOW_SECONDS,
        configuredExpiresIn: 3600,
        now: NOW,
      }),
    ).toThrow(new TokenExchangeError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION));
  });

  it('should reject a non-positive configured lifetime with a RangeError', () => {
    expect(() =>
      computeExchangedTokenLifetime({
        subjectExpiresAt: NOW_SECONDS + 300,
        configuredExpiresIn: 0,
        now: NOW,
      }),
    ).toThrow(RangeError);
  });

  it('should reject a fractional configured lifetime with a RangeError', () => {
    expect(() =>
      computeExchangedTokenLifetime({
        subjectExpiresAt: NOW_SECONDS + 300,
        configuredExpiresIn: 1.5,
        now: NOW,
      }),
    ).toThrow(RangeError);
  });
});

describe('buildTokenExchangeResponse', () => {
  // RFC 8693 §2.2.1
  it('should build the full response body with every required member', () => {
    expect(
      buildTokenExchangeResponse({
        accessToken: 'exchanged-token',
        expiresIn: 300,
        scope: ['api:read'],
      }),
    ).toEqual({
      access_token: 'exchanged-token',
      issued_token_type: TOKEN_TYPE_ACCESS_TOKEN,
      token_type: 'Bearer',
      expires_in: 300,
      scope: 'api:read',
    });
  });

  it('should join multiple scope values with a single space', () => {
    expect(
      buildTokenExchangeResponse({
        accessToken: 'exchanged-token',
        expiresIn: 60,
        scope: ['openid', 'api:read'],
      }).scope,
    ).toBe('openid api:read');
  });

  // 発行トークンがアクセストークンである以上 token_type は常に Bearer（N_A は使わない）。
  it('should always report Bearer as the token_type', () => {
    expect(
      buildTokenExchangeResponse({ accessToken: 't', expiresIn: 1, scope: [] }).token_type,
    ).toBe('Bearer');
  });

  it('should not include a refresh_token member', () => {
    expect(
      Object.keys(buildTokenExchangeResponse({ accessToken: 't', expiresIn: 1, scope: [] })).sort(),
    ).toEqual(['access_token', 'expires_in', 'issued_token_type', 'scope', 'token_type']);
  });
});

describe('processTokenExchangeRequest', () => {
  describe('Successful exchanges', () => {
    it('should derive the full grant material for a scope-narrowing exchange', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams({ scope: 'api:read' }),
        client: confidentialClient(),
        accessTokenResolver: resolverFor(subjectTokenInfo()),
        allowedTargets: [],
        configuredExpiresIn: 3600,
        now: NOW,
      });
      expect(grant).toEqual({
        subject: 'user-1',
        clientId: 'exchange-client',
        scope: ['api:read'],
        requestedAudience: ['https://op.example.com/userinfo'],
        expiresIn: 300,
        grantId: 'grant-1',
      });
    });

    // impersonation: sub は subject_token のものを継承する。
    it('should keep the subject of the subject_token', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams(),
        client: confidentialClient(),
        accessTokenResolver: resolverFor(subjectTokenInfo({ sub: 'user-42' })),
        allowedTargets: [],
        configuredExpiresIn: 60,
        now: NOW,
      });
      expect(grant.subject).toBe('user-42');
    });

    // 交換後トークンの client_id は「交換を要求したクライアント」。
    it('should set the client id to the requesting client, not the subject token client', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams(),
        client: confidentialClient({ clientId: 'gateway' }),
        accessTokenResolver: resolverFor(subjectTokenInfo({ clientId: 'front-api' })),
        allowedTargets: [],
        configuredExpiresIn: 60,
        now: NOW,
      });
      expect(grant.clientId).toBe('gateway');
    });

    it('should inherit the subject scope when scope is omitted', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams(),
        client: confidentialClient(),
        accessTokenResolver: resolverFor(subjectTokenInfo()),
        allowedTargets: [],
        configuredExpiresIn: 60,
        now: NOW,
      });
      expect(grant.scope).toEqual(['openid', 'profile', 'api:read']);
    });

    it('should return the allowed audience as the requested audience', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams({ audience: 'internal-api' }),
        client: confidentialClient(),
        accessTokenResolver: resolverFor(subjectTokenInfo()),
        allowedTargets: ['internal-api'],
        configuredExpiresIn: 60,
        now: NOW,
      });
      expect(grant.requestedAudience).toEqual(['internal-api']);
    });

    // 失効連動: 交換後トークンは subject の grant に連なる。
    it('should inherit the grant id of the subject token', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams(),
        client: confidentialClient(),
        accessTokenResolver: resolverFor(subjectTokenInfo({ grantId: 'grant-99' })),
        allowedTargets: [],
        configuredExpiresIn: 60,
        now: NOW,
      });
      expect(grant.grantId).toBe('grant-99');
    });

    it('should leave the grant id undefined when the subject token has none', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams(),
        client: confidentialClient(),
        accessTokenResolver: resolverFor(subjectTokenInfo({ grantId: undefined })),
        allowedTargets: [],
        configuredExpiresIn: 60,
        now: NOW,
      });
      expect(grant.grantId).toBeUndefined();
    });

    it('should default the current time to now when it is not injected', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams(),
        client: confidentialClient(),
        accessTokenResolver: resolverFor(
          subjectTokenInfo({ expiresAt: Math.floor(Date.now() / 1000) + 120 }),
        ),
        allowedTargets: [],
        configuredExpiresIn: 3600,
      });
      expect(grant.expiresIn).toBe(120);
    });
  });

  describe('Rejected exchanges', () => {
    it('should reject an unauthorized client before reading the subject token', async () => {
      let resolverCalls = 0;
      const resolver: AccessTokenResolver = {
        findAccessToken: async () => {
          resolverCalls += 1;
          return subjectTokenInfo();
        },
      };
      await processTokenExchangeRequest({
        params: validParams(),
        client: confidentialClient({ grantTypes: ['authorization_code'] }),
        accessTokenResolver: resolver,
        allowedTargets: [],
        configuredExpiresIn: 60,
        now: NOW,
      }).catch(() => undefined);
      expect(resolverCalls).toBe(0);
    });

    it('should reject a public client with unauthorized_client', async () => {
      await expect(
        processTokenExchangeRequest({
          params: validParams(),
          client: confidentialClient({ tokenEndpointAuthMethod: 'none', clientSecret: undefined }),
          accessTokenResolver: resolverFor(subjectTokenInfo()),
          allowedTargets: [],
          configuredExpiresIn: 60,
          now: NOW,
        }),
      ).rejects.toThrow(
        new TokenExchangeError(
          'unauthorized_client',
          'Public clients are not allowed to use the token-exchange grant type',
        ),
      );
    });

    it('should reject an exchange whose scope exceeds the subject scope with invalid_scope', async () => {
      await expect(
        processTokenExchangeRequest({
          params: validParams({ scope: 'admin' }),
          client: confidentialClient(),
          accessTokenResolver: resolverFor(subjectTokenInfo()),
          allowedTargets: [],
          configuredExpiresIn: 60,
          now: NOW,
        }),
      ).rejects.toThrow(
        new TokenExchangeError(
          'invalid_scope',
          'The requested scope exceeds the scope of the subject_token',
        ),
      );
    });

    it('should reject an exchange to a disallowed audience with invalid_target', async () => {
      await expect(
        processTokenExchangeRequest({
          params: validParams({ audience: 'other-api' }),
          client: confidentialClient(),
          accessTokenResolver: resolverFor(subjectTokenInfo()),
          allowedTargets: ['internal-api'],
          configuredExpiresIn: 60,
          now: NOW,
        }),
      ).rejects.toThrow(
        new TokenExchangeError(
          'invalid_target',
          'The requested target is not allowed for token exchange',
        ),
      );
    });

    it('should reject an expired subject token with invalid_request', async () => {
      await expect(
        processTokenExchangeRequest({
          params: validParams(),
          client: confidentialClient(),
          accessTokenResolver: resolverFor(subjectTokenInfo({ expiresAt: NOW_SECONDS - 1 })),
          allowedTargets: [],
          configuredExpiresIn: 60,
          now: NOW,
        }),
      ).rejects.toThrow(
        new TokenExchangeError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION),
      );
    });

    it('should reject an unknown actor_token with invalid_request', async () => {
      await expect(
        processTokenExchangeRequest({
          params: validParams({
            actor_token: 'unknown-actor-token',
            actor_token_type: TOKEN_TYPE_ACCESS_TOKEN,
          }),
          client: confidentialClient(),
          accessTokenResolver: resolverByToken({
            'subject-access-token': subjectTokenInfo(),
          }),
          allowedTargets: [],
          configuredExpiresIn: 60,
          now: NOW,
        }),
      ).rejects.toThrow(
        new TokenExchangeError('invalid_request', ACTOR_TOKEN_INVALID_DESCRIPTION),
      );
    });

    it('should reject an expired actor_token with invalid_request', async () => {
      await expect(
        processTokenExchangeRequest({
          params: validParams({
            actor_token: 'actor-access-token',
            actor_token_type: TOKEN_TYPE_ACCESS_TOKEN,
          }),
          client: confidentialClient(),
          accessTokenResolver: resolverByToken({
            'subject-access-token': subjectTokenInfo(),
            'actor-access-token': subjectTokenInfo({
              sub: 'service-a',
              expiresAt: NOW_SECONDS - 1,
            }),
          }),
          allowedTargets: [],
          configuredExpiresIn: 60,
          now: NOW,
        }),
      ).rejects.toThrow(
        new TokenExchangeError('invalid_request', ACTOR_TOKEN_INVALID_DESCRIPTION),
      );
    });
  });

  describe('Delegation exchanges (RFC 8693 §1.1 / §4.1)', () => {
    it('should record the actor of a delegation exchange in the grant material', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams({
          scope: 'api:read',
          actor_token: 'actor-access-token',
          actor_token_type: TOKEN_TYPE_ACCESS_TOKEN,
        }),
        client: confidentialClient(),
        accessTokenResolver: resolverByToken({
          'subject-access-token': subjectTokenInfo(),
          'actor-access-token': subjectTokenInfo({ sub: 'service-a', clientId: 'gateway' }),
        }),
        allowedTargets: [],
        configuredExpiresIn: 3600,
        now: NOW,
      });
      expect(grant).toEqual({
        subject: 'user-1',
        clientId: 'exchange-client',
        scope: ['api:read'],
        requestedAudience: ['https://op.example.com/userinfo'],
        expiresIn: 300,
        grantId: 'grant-1',
        actor: { sub: 'service-a' },
      });
    });

    // delegation でも sub は subject_token のもの。actor は act にのみ現れる。
    it('should keep the subject unchanged in a delegation exchange', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams({
          actor_token: 'actor-access-token',
          actor_token_type: TOKEN_TYPE_ACCESS_TOKEN,
        }),
        client: confidentialClient(),
        accessTokenResolver: resolverByToken({
          'subject-access-token': subjectTokenInfo({ sub: 'user-42' }),
          'actor-access-token': subjectTokenInfo({ sub: 'service-a' }),
        }),
        allowedTargets: [],
        configuredExpiresIn: 60,
        now: NOW,
      });
      expect(grant).toMatchObject({
        subject: 'user-42',
        actor: { sub: 'service-a' },
      });
    });

    it('should leave the actor undefined for an impersonation exchange', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams(),
        client: confidentialClient(),
        accessTokenResolver: resolverFor(subjectTokenInfo()),
        allowedTargets: [],
        configuredExpiresIn: 60,
        now: NOW,
      });
      expect(grant.actor).toBeUndefined();
    });

    // RFC 8693 §4.1: subject_token が既に act を持つ（＝それ自体が委譲で発行された）
    // 場合、過去の actor はネストへ押し下がり、最外は今回の actor になる。
    it('should chain the prior actor when the subject token already carries an act claim', async () => {
      const delegatedSubject: ExchangedAccessTokenInfo = {
        ...subjectTokenInfo(),
        act: { sub: 'service-a' },
      };
      const grant = await processTokenExchangeRequest({
        params: validParams({
          actor_token: 'actor-access-token',
          actor_token_type: TOKEN_TYPE_ACCESS_TOKEN,
        }),
        client: confidentialClient(),
        accessTokenResolver: resolverByToken({
          'subject-access-token': delegatedSubject,
          'actor-access-token': subjectTokenInfo({ sub: 'service-b' }),
        }),
        allowedTargets: [],
        configuredExpiresIn: 60,
        now: NOW,
      });
      expect(grant.actor).toEqual({ sub: 'service-b', act: { sub: 'service-a' } });
    });

    // 設計判断: 有効期間の cap は subject_token の残存期間だけで決まる。actor_token は
    // 交換時点の本人性確認に使うのであって、発行後トークンの寿命は actor に連動しない。
    it('should not cap the lifetime by the actor token expiry', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams({
          actor_token: 'actor-access-token',
          actor_token_type: TOKEN_TYPE_ACCESS_TOKEN,
        }),
        client: confidentialClient(),
        accessTokenResolver: resolverByToken({
          'subject-access-token': subjectTokenInfo({ expiresAt: NOW_SECONDS + 300 }),
          'actor-access-token': subjectTokenInfo({
            sub: 'service-a',
            expiresAt: NOW_SECONDS + 30,
          }),
        }),
        allowedTargets: [],
        configuredExpiresIn: 3600,
        now: NOW,
      });
      expect(grant.expiresIn).toBe(300);
    });

    // grantId は subject 側を継承する。actor の grant には連ならない。
    it('should inherit the grant id from the subject token, not the actor token', async () => {
      const grant = await processTokenExchangeRequest({
        params: validParams({
          actor_token: 'actor-access-token',
          actor_token_type: TOKEN_TYPE_ACCESS_TOKEN,
        }),
        client: confidentialClient(),
        accessTokenResolver: resolverByToken({
          'subject-access-token': subjectTokenInfo({ grantId: 'grant-subject' }),
          'actor-access-token': subjectTokenInfo({ sub: 'service-a', grantId: 'grant-actor' }),
        }),
        allowedTargets: [],
        configuredExpiresIn: 60,
        now: NOW,
      });
      expect(grant.grantId).toBe('grant-subject');
    });
  });
});
