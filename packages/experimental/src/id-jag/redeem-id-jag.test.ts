import { beforeAll, describe, expect, it } from 'vitest';
import type { TokenClientInfo } from '@maronn-openid-connect/core';
import { ASSERTION_UNTRUSTED_DESCRIPTION, IdJagError } from './errors.js';
import { ID_JAG_JWT_TYP } from './issue-id-jag.js';
import {
  DEFAULT_ASSERTION_CLOCK_SKEW_SEC,
  JWT_BEARER_GRANT_TYPE,
  authorizeIdJagRedemptionClient,
  parseIdJagRedemptionParams,
  processIdJagRedemptionRequest,
  resolveIdJagGrantScope,
  verifyIdJagAssertion,
  type IdJagRedemptionContext,
  type IdJagTrustedIdentityProvider,
} from './redeem-id-jag.js';
import {
  generateTestRs256Key,
  signTestJwt,
  tamperSignature,
  type TestRs256Key,
} from './test-helpers.js';

/** 自 OP（リソース AS）の issuer。assertion の期待 aud。 */
const ISSUER = 'https://rs-as.example.net';
/** 信頼する IdP の issuer。assertion の iss。 */
const IDP_ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'xaa-client';

/** 2026-01-01T00:00:00Z。Unix epoch 秒で 1767225600。 */
const NOW = new Date('2026-01-01T00:00:00Z');
const NOW_SECONDS = 1767225600;

let idpKey: TestRs256Key;
let otherKey: TestRs256Key;
let identityProviders: IdJagTrustedIdentityProvider[];

beforeAll(async () => {
  idpKey = await generateTestRs256Key('trusted-idp-key');
  otherKey = await generateTestRs256Key('untrusted-key');
  identityProviders = [{ issuer: IDP_ISSUER, jwks: idpKey.jwks }];
});

function idJagClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: IDP_ISSUER,
    sub: 'user-1',
    aud: ISSUER,
    client_id: CLIENT_ID,
    jti: 'jag-1',
    exp: NOW_SECONDS + 300,
    iat: NOW_SECONDS,
    scope: 'openid profile offline_access',
    ...overrides,
  };
}

function idJagHeader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { alg: 'RS256', typ: ID_JAG_JWT_TYP, kid: 'trusted-idp-key', ...overrides };
}

async function mintIdJag(options: {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  key?: TestRs256Key;
} = {}): Promise<string> {
  const key = options.key ?? idpKey;
  return signTestJwt({
    header: idJagHeader(options.header),
    payload: idJagClaims(options.claims),
    privateKey: key.signingKey.privateKey,
  });
}

function confidentialClient(overrides: Partial<TokenClientInfo> = {}): TokenClientInfo {
  return {
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    grantTypes: ['authorization_code', JWT_BEARER_GRANT_TYPE],
    tokenEndpointAuthMethod: 'client_secret_basic',
    ...overrides,
  };
}

function redemptionContext(
  assertion: string,
  overrides: Partial<IdJagRedemptionContext> = {},
): IdJagRedemptionContext {
  return {
    params: { grant_type: JWT_BEARER_GRANT_TYPE, assertion },
    client: confidentialClient(),
    issuer: ISSUER,
    identityProviders,
    configuredExpiresIn: 3600,
    now: NOW,
    ...overrides,
  };
}

async function expectAssertionRejection(
  assertion: string,
  description: string,
): Promise<void> {
  await expect(
    verifyIdJagAssertion({
      assertion,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      identityProviders,
      now: NOW,
    }),
  ).rejects.toThrow(new IdJagError('invalid_grant', description));
}

describe('id-jag redemption constants', () => {
  // RFC 7523 §2.1
  it('should expose the jwt-bearer grant type URN', () => {
    expect(JWT_BEARER_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
  });

  // RFC 8725 §3.8: leeway は数分以内。core の ID トークン検証と同じ 60 秒
  it('should default the clock skew tolerance to 60 seconds', () => {
    expect(DEFAULT_ASSERTION_CLOCK_SKEW_SEC).toBe(60);
  });
});

describe('authorizeIdJagRedemptionClient', () => {
  it('should accept a confidential client registered for the jwt-bearer grant', () => {
    expect(() => authorizeIdJagRedemptionClient(confidentialClient())).not.toThrow();
  });

  it('should reject a client not registered for the jwt-bearer grant with unauthorized_client', () => {
    const client = confidentialClient({ grantTypes: ['authorization_code'] });
    expect(() => authorizeIdJagRedemptionClient(client)).toThrow(
      new IdJagError(
        'unauthorized_client',
        'The client is not authorized to use the jwt-bearer grant type',
      ),
    );
  });

  // draft §9.1: confidential client 限定
  it('should reject a public client with unauthorized_client', () => {
    const client = confidentialClient({
      tokenEndpointAuthMethod: 'none',
      clientSecret: undefined,
    });
    expect(() => authorizeIdJagRedemptionClient(client)).toThrow(
      new IdJagError(
        'unauthorized_client',
        'Public clients are not allowed to use the jwt-bearer grant type',
      ),
    );
  });
});

describe('parseIdJagRedemptionParams', () => {
  it('should return the typed parameters', () => {
    expect(
      parseIdJagRedemptionParams({
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion: 'a.b.c',
        scope: 'openid',
      }),
    ).toEqual({ assertion: 'a.b.c', scope: 'openid' });
  });

  it('should reject a missing assertion with invalid_request', () => {
    expect(() => parseIdJagRedemptionParams({ grant_type: JWT_BEARER_GRANT_TYPE })).toThrow(
      new IdJagError('invalid_request', 'assertion is required'),
    );
  });

  // 非目標: RAR
  it('should reject authorization_details with invalid_request', () => {
    expect(() =>
      parseIdJagRedemptionParams({
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion: 'a.b.c',
        authorization_details: '[{"type":"x"}]',
      }),
    ).toThrow(
      new IdJagError(
        'invalid_request',
        'authorization_details is not supported for the jwt-bearer grant',
      ),
    );
  });
});

describe('verifyIdJagAssertion', () => {
  describe('acceptance', () => {
    it('should return the payload of a valid ID-JAG', async () => {
      const assertion = await mintIdJag({
        claims: {
          resource: 'https://api.example.net/files',
          auth_time: NOW_SECONDS - 60,
          acr: 'silver',
          amr: ['pwd'],
        },
      });
      await expect(
        verifyIdJagAssertion({
          assertion,
          issuer: ISSUER,
          clientId: CLIENT_ID,
          identityProviders,
          now: NOW,
        }),
      ).resolves.toEqual({
        iss: IDP_ISSUER,
        sub: 'user-1',
        aud: ISSUER,
        client_id: CLIENT_ID,
        jti: 'jag-1',
        exp: NOW_SECONDS + 300,
        iat: NOW_SECONDS,
        scope: 'openid profile offline_access',
        resource: 'https://api.example.net/files',
        auth_time: NOW_SECONDS - 60,
        acr: 'silver',
        amr: ['pwd'],
      });
    });

    // draft §4.4.1: aud は要素数 1 の配列でもよい
    it('should accept an aud claim that is a single-element array', async () => {
      const assertion = await mintIdJag({ claims: { aud: [ISSUER] } });
      await expect(
        verifyIdJagAssertion({
          assertion,
          issuer: ISSUER,
          clientId: CLIENT_ID,
          identityProviders,
          now: NOW,
        }),
      ).resolves.toMatchObject({ aud: [ISSUER] });
    });

    // RFC 7515 §4.1.9: typ は application/ 前置と大文字小文字の差を許容する
    it('should accept an application/-prefixed typ header', async () => {
      const assertion = await mintIdJag({ header: { typ: `application/${ID_JAG_JWT_TYP}` } });
      await expect(
        verifyIdJagAssertion({
          assertion,
          issuer: ISSUER,
          clientId: CLIENT_ID,
          identityProviders,
          now: NOW,
        }),
      ).resolves.toMatchObject({ jti: 'jag-1' });
    });

    // kid が無くても alg 一致の鍵で検証できる
    it('should verify with an alg-matched key when the header has no kid', async () => {
      const assertion = await mintIdJag({ header: { kid: undefined } });
      await expect(
        verifyIdJagAssertion({
          assertion,
          issuer: ISSUER,
          clientId: CLIENT_ID,
          identityProviders,
          now: NOW,
        }),
      ).resolves.toMatchObject({ sub: 'user-1' });
    });

    it('should pick the trusted IdP by the iss claim when several are configured', async () => {
      const assertion = await mintIdJag();
      await expect(
        verifyIdJagAssertion({
          assertion,
          issuer: ISSUER,
          clientId: CLIENT_ID,
          identityProviders: [
            { issuer: 'https://another-idp.example.org', jwks: otherKey.jwks },
            { issuer: IDP_ISSUER, jwks: idpKey.jwks },
          ],
          now: NOW,
        }),
      ).resolves.toMatchObject({ iss: IDP_ISSUER });
    });

    // RFC 8725 §3.8: exp は leeway 内なら許容
    it('should accept an assertion that expired within the clock skew tolerance', async () => {
      const assertion = await mintIdJag({ claims: { exp: NOW_SECONDS - 30 } });
      await expect(
        verifyIdJagAssertion({
          assertion,
          issuer: ISSUER,
          clientId: CLIENT_ID,
          identityProviders,
          now: NOW,
        }),
      ).resolves.toMatchObject({ exp: NOW_SECONDS - 30 });
    });
  });

  describe('structural rejection', () => {
    it('should reject a value that is not a compact JWS', async () => {
      await expectAssertionRejection(
        'not-a-jwt',
        'The provided assertion is not a valid JWS compact serialization',
      );
    });

    it('should reject a JWS whose segments are not base64url JSON', async () => {
      await expectAssertionRejection(
        '!!!.???.___',
        'The provided assertion is not a valid JWS compact serialization',
      );
    });

    // draft §4.4.1 / RFC 8725 §3.11: typ の検証で token confusion を拒否する
    it('should reject a JWT typ other than oauth-id-jag+jwt', async () => {
      const assertion = await mintIdJag({ header: { typ: 'JWT' } });
      await expectAssertionRejection(assertion, `The assertion typ must be ${ID_JAG_JWT_TYP}`);
    });

    it('should reject a missing typ header', async () => {
      const assertion = await mintIdJag({ header: { typ: undefined } });
      await expectAssertionRejection(assertion, `The assertion typ must be ${ID_JAG_JWT_TYP}`);
    });

    it('should reject alg none', async () => {
      const assertion = await mintIdJag({ header: { alg: 'none' } });
      await expectAssertionRejection(assertion, 'The assertion alg is missing or "none"');
    });

    // RFC 8725 §3.1: 外部鍵取得ヘッダは SSRF と鍵差し替えの経路になるため拒否する
    it('should reject a jku header', async () => {
      const assertion = await mintIdJag({ header: { jku: 'https://evil.example.com/jwks' } });
      await expectAssertionRejection(
        assertion,
        'The assertion JOSE header contains unsupported field: jku',
      );
    });

    it('should reject an embedded jwk header', async () => {
      const assertion = await mintIdJag({ header: { jwk: { kty: 'RSA' } } });
      await expectAssertionRejection(
        assertion,
        'The assertion JOSE header contains unsupported field: jwk',
      );
    });
  });

  describe('issuer and signature rejection', () => {
    // オラクル排除: iss 非信頼と署名不正は同一文言
    it('should reject an untrusted issuer with the fixed description', async () => {
      const assertion = await mintIdJag({ claims: { iss: 'https://unknown-idp.example.org' } });
      await expectAssertionRejection(assertion, ASSERTION_UNTRUSTED_DESCRIPTION);
    });

    it('should reject a tampered signature with the same fixed description', async () => {
      const assertion = tamperSignature(await mintIdJag());
      await expectAssertionRejection(assertion, ASSERTION_UNTRUSTED_DESCRIPTION);
    });

    it('should reject a signature by an untrusted key with the same fixed description', async () => {
      const assertion = await mintIdJag({ key: otherKey, header: { kid: 'untrusted-key' } });
      await expectAssertionRejection(assertion, ASSERTION_UNTRUSTED_DESCRIPTION);
    });

    // draft §9.3: 自分が発行した ID-JAG は同一ドメイン内で引き換えない
    it('should reject an assertion issued by this authorization server itself', async () => {
      const assertion = await mintIdJag({ claims: { iss: ISSUER } });
      await expectAssertionRejection(
        assertion,
        'An assertion issued by this authorization server cannot be redeemed here',
      );
    });

    it('should reject the self-issued assertion even when the own issuer is trust-listed', async () => {
      const assertion = await mintIdJag({ claims: { iss: ISSUER } });
      await expect(
        verifyIdJagAssertion({
          assertion,
          issuer: ISSUER,
          clientId: CLIENT_ID,
          identityProviders: [{ issuer: ISSUER, jwks: idpKey.jwks }],
          now: NOW,
        }),
      ).rejects.toThrow(
        new IdJagError(
          'invalid_grant',
          'An assertion issued by this authorization server cannot be redeemed here',
        ),
      );
    });
  });

  describe('claim rejection', () => {
    // draft §4.4.1: aud 不一致は audience injection として拒否
    it('should reject an aud claim for another authorization server', async () => {
      const assertion = await mintIdJag({ claims: { aud: 'https://other-as.example.org' } });
      await expectAssertionRejection(
        assertion,
        'The assertion audience does not match this authorization server',
      );
    });

    // draft §4.4.1: 配列 aud は要素数 1 のみ
    it('should reject an aud array with more than one element', async () => {
      const assertion = await mintIdJag({
        claims: { aud: [ISSUER, 'https://other-as.example.org'] },
      });
      await expectAssertionRejection(
        assertion,
        'The assertion audience does not match this authorization server',
      );
    });

    it('should reject an expired assertion', async () => {
      const assertion = await mintIdJag({ claims: { exp: NOW_SECONDS - 120 } });
      await expectAssertionRejection(assertion, 'The assertion has expired');
    });

    it('should reject a missing exp claim', async () => {
      const assertion = await mintIdJag({ claims: { exp: undefined } });
      await expectAssertionRejection(assertion, 'The assertion is missing an exp claim');
    });

    it('should reject an iat claim in the future', async () => {
      const assertion = await mintIdJag({ claims: { iat: NOW_SECONDS + 120 } });
      await expectAssertionRejection(assertion, 'The assertion iat is in the future');
    });

    it('should reject a missing iat claim', async () => {
      const assertion = await mintIdJag({ claims: { iat: undefined } });
      await expectAssertionRejection(assertion, 'The assertion is missing an iat claim');
    });

    it('should reject an nbf claim that has not arrived yet', async () => {
      const assertion = await mintIdJag({ claims: { nbf: NOW_SECONDS + 120 } });
      await expectAssertionRejection(assertion, 'The assertion is not yet valid');
    });

    // draft §3.1: jti は REQUIRED
    it('should reject a missing jti claim', async () => {
      const assertion = await mintIdJag({ claims: { jti: undefined } });
      await expectAssertionRejection(assertion, 'The assertion is missing a jti claim');
    });

    it('should reject a missing sub claim', async () => {
      const assertion = await mintIdJag({ claims: { sub: undefined } });
      await expectAssertionRejection(assertion, 'The assertion is missing a sub claim');
    });

    it('should reject a missing client_id claim', async () => {
      const assertion = await mintIdJag({ claims: { client_id: undefined } });
      await expectAssertionRejection(assertion, 'The assertion is missing a client_id claim');
    });

    // draft §4.4.1: client_id はリクエストを認証したクライアントと一致しなければならない
    it('should reject a client_id claim bound to another client', async () => {
      const assertion = await mintIdJag({ claims: { client_id: 'another-client' } });
      await expectAssertionRejection(
        assertion,
        'The assertion client_id does not match the authenticated client',
      );
    });

    it('should reject a non-string scope claim', async () => {
      const assertion = await mintIdJag({ claims: { scope: ['openid'] } });
      await expectAssertionRejection(assertion, 'The assertion scope claim must be a string');
    });

    it('should reject a resource claim that is neither a string nor a string array', async () => {
      const assertion = await mintIdJag({ claims: { resource: 42 } });
      await expectAssertionRejection(
        assertion,
        'The assertion resource claim must be a string or an array of strings',
      );
    });
  });
});

describe('resolveIdJagGrantScope', () => {
  it('should inherit the assertion scope when no scope is requested', () => {
    expect(resolveIdJagGrantScope(undefined, 'openid profile')).toEqual(['openid', 'profile']);
  });

  // draft §4.4.3 SHOULD NOT: refresh token を発行しないため offline_access は常に落とす
  it('should always drop offline_access from the assertion scope', () => {
    expect(resolveIdJagGrantScope(undefined, 'openid offline_access profile')).toEqual([
      'openid',
      'profile',
    ]);
  });

  it('should narrow to the requested subset', () => {
    expect(resolveIdJagGrantScope('openid', 'openid profile')).toEqual(['openid']);
  });

  it('should return an empty scope when the assertion carries none', () => {
    expect(resolveIdJagGrantScope(undefined, undefined)).toEqual([]);
  });

  it('should reject a requested scope beyond the assertion scope with invalid_scope', () => {
    expect(() => resolveIdJagGrantScope('openid email', 'openid profile')).toThrow(
      new IdJagError('invalid_scope', 'The requested scope exceeds the scope of the assertion'),
    );
  });

  // offline_access は除去済みの集合が上限になるため、要求しても超過扱いになる
  it('should reject a requested offline_access with invalid_scope', () => {
    expect(() => resolveIdJagGrantScope('offline_access', 'openid offline_access')).toThrow(
      new IdJagError('invalid_scope', 'The requested scope exceeds the scope of the assertion'),
    );
  });
});

describe('processIdJagRedemptionRequest', () => {
  it('should derive the grant material from a valid assertion', async () => {
    const assertion = await mintIdJag({
      claims: { resource: 'https://api.example.net/files', auth_time: NOW_SECONDS - 60 },
    });
    await expect(processIdJagRedemptionRequest(redemptionContext(assertion))).resolves.toEqual({
      subject: 'user-1',
      clientId: CLIENT_ID,
      scope: ['openid', 'profile'],
      requestedResources: ['https://api.example.net/files'],
      expiresIn: 3600,
      idpIssuer: IDP_ISSUER,
      jti: 'jag-1',
      authTime: NOW_SECONDS - 60,
    });
  });

  it('should narrow the scope to the requested subset', async () => {
    const assertion = await mintIdJag();
    await expect(
      processIdJagRedemptionRequest(
        redemptionContext(assertion, {
          params: { grant_type: JWT_BEARER_GRANT_TYPE, assertion, scope: 'openid' },
        }),
      ),
    ).resolves.toMatchObject({ scope: ['openid'] });
  });

  it('should reject an unauthorized client before validating the assertion', async () => {
    await expect(
      processIdJagRedemptionRequest(
        redemptionContext('never-validated', {
          client: confidentialClient({ grantTypes: ['authorization_code'] }),
        }),
      ),
    ).rejects.toThrow(
      new IdJagError(
        'unauthorized_client',
        'The client is not authorized to use the jwt-bearer grant type',
      ),
    );
  });

  it('should reject an assertion bound to another client with invalid_grant', async () => {
    const assertion = await mintIdJag({ claims: { client_id: 'another-client' } });
    await expect(processIdJagRedemptionRequest(redemptionContext(assertion))).rejects.toThrow(
      new IdJagError(
        'invalid_grant',
        'The assertion client_id does not match the authenticated client',
      ),
    );
  });

  it('should reject every assertion when no identity provider is trusted', async () => {
    const assertion = await mintIdJag();
    await expect(
      processIdJagRedemptionRequest(redemptionContext(assertion, { identityProviders: [] })),
    ).rejects.toThrow(new IdJagError('invalid_grant', ASSERTION_UNTRUSTED_DESCRIPTION));
  });

  it('should reject a non-positive configuredExpiresIn with a RangeError', async () => {
    const assertion = await mintIdJag();
    await expect(
      processIdJagRedemptionRequest(redemptionContext(assertion, { configuredExpiresIn: 0 })),
    ).rejects.toThrow(RangeError);
  });

  // draft §4.4.3: 同じ ID-JAG は有効期間内なら再提示できる（リプレイ拒否ストアを持たない）
  it('should accept the same assertion presented twice', async () => {
    const assertion = await mintIdJag();
    const first = await processIdJagRedemptionRequest(redemptionContext(assertion));
    const second = await processIdJagRedemptionRequest(redemptionContext(assertion));
    expect(first).toEqual(second);
  });
});

describe('verifyIdJagAssertion with an act claim', () => {
  // draft §3.1 OPTIONAL / RFC 8693 §4.1: act は検証して素通しする（黙って落とさない）
  it('should return the act claim of an actor-bearing ID-JAG', async () => {
    const assertion = await mintIdJag({ claims: { act: { sub: 'actor-1' } } });
    await expect(
      verifyIdJagAssertion({
        assertion,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        identityProviders,
        now: NOW,
      }),
    ).resolves.toMatchObject({ act: { sub: 'actor-1' } });
  });

  // RFC 8693 §4.1: ネストした act はより古い actor のチェーンを表す
  it('should accept a nested act chain', async () => {
    const assertion = await mintIdJag({
      claims: { act: { sub: 'actor-1', act: { sub: 'actor-0' } } },
    });
    await expect(
      verifyIdJagAssertion({
        assertion,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        identityProviders,
        now: NOW,
      }),
    ).resolves.toMatchObject({ act: { sub: 'actor-1', act: { sub: 'actor-0' } } });
  });

  it('should reject a non-object act claim', async () => {
    const assertion = await mintIdJag({ claims: { act: 'actor-1' } });
    await expectAssertionRejection(assertion, 'The assertion act claim is malformed');
  });

  it('should reject an act claim without a sub', async () => {
    const assertion = await mintIdJag({ claims: { act: { role: 'admin' } } });
    await expectAssertionRejection(assertion, 'The assertion act claim is malformed');
  });

  it('should reject an act claim with a malformed nested chain', async () => {
    const assertion = await mintIdJag({ claims: { act: { sub: 'actor-1', act: { sub: 42 } } } });
    await expectAssertionRejection(assertion, 'The assertion act claim is malformed');
  });
});

describe('processIdJagRedemptionRequest with an act claim', () => {
  // 生成コードが act をアクセストークンへ引き継げるよう、grant 素材に含める
  it('should propagate the act claim into the grant material', async () => {
    const assertion = await mintIdJag({ claims: { act: { sub: 'actor-1' } } });
    await expect(processIdJagRedemptionRequest(redemptionContext(assertion))).resolves.toMatchObject(
      {
        subject: 'user-1',
        actor: { sub: 'actor-1' },
      },
    );
  });

  it('should leave the actor undefined for an act-less ID-JAG', async () => {
    const assertion = await mintIdJag();
    const grant = await processIdJagRedemptionRequest(redemptionContext(assertion));
    expect('actor' in grant).toBe(false);
  });
});
