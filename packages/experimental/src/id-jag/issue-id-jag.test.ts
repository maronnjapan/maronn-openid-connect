import { beforeAll, describe, expect, it } from 'vitest';
import { generateIdToken, type TokenClientInfo } from '@maronn-openid-connect/core';
import { IdJagError, SUBJECT_TOKEN_INVALID_DESCRIPTION } from './errors.js';
import {
  ID_JAG_GRANT_PROFILE,
  ID_JAG_JWT_TYP,
  ID_JAG_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ID_TOKEN,
  authorizeIdJagIssuanceClient,
  buildIdJagClaims,
  buildIdJagIssuanceResponse,
  createIdJagJwt,
  matchesIdJagIssuanceRequest,
  parseIdJagIssuanceParams,
  processIdJagIssuanceRequest,
  resolveIdJagSubject,
  validateIdJagAudience,
  validateIdJagScope,
  type IdJagIssuanceContext,
} from './issue-id-jag.js';
import {
  decodeJwt,
  generateTestRs256Key,
  signTestJwt,
  type TestRs256Key,
} from './test-helpers.js';

/** IdP（自 OP）の issuer。subject_token の期待 iss であり ID-JAG の iss になる。 */
const ISSUER = 'https://idp.example.com';
/** ID-JAG の宛先（リソース AS の issuer）。 */
const AUDIENCE = 'https://rs-as.example.net';
const CLIENT_ID = 'xaa-client';

/** 2026-01-01T00:00:00Z。Unix epoch 秒で 1767225600。クレーム組み立ての固定時刻。 */
const NOW = new Date('2026-01-01T00:00:00Z');
const NOW_SECONDS = 1767225600;

let idpKey: TestRs256Key;
/** 現在時刻基準で有効な、CLIENT_ID 宛ての ID トークン。 */
let validIdToken: string;

beforeAll(async () => {
  idpKey = await generateTestRs256Key('idp-rs256-key');
  validIdToken = await mintIdToken({});
});

/**
 * core の generateIdToken で ID トークンを作る。exp / iat は実時刻基準
 * （resolveIdJagSubject が委譲する core の検証は実時刻で判定するため）。
 */
async function mintIdToken(overrides: Record<string, unknown>): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return generateIdToken({
    payload: {
      iss: ISSUER,
      sub: 'user-1',
      aud: CLIENT_ID,
      exp: nowSeconds + 3600,
      iat: nowSeconds,
      auth_time: nowSeconds - 10,
      acr: 'urn:mace:incommon:iap:silver',
      amr: ['pwd', 'mfa'],
      ...overrides,
    },
    privateKey: idpKey.signingKey.privateKey,
    keyId: idpKey.signingKey.keyId,
  });
}

function confidentialClient(overrides: Partial<TokenClientInfo> = {}): TokenClientInfo {
  return {
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    grantTypes: ['authorization_code', TOKEN_EXCHANGE_GRANT_TYPE],
    tokenEndpointAuthMethod: 'client_secret_basic',
    ...overrides,
  };
}

function validParams(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    requested_token_type: ID_JAG_TOKEN_TYPE,
    subject_token: validIdToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    audience: AUDIENCE,
    scope: 'openid profile',
    ...overrides,
  };
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) params[key] = value;
  }
  return params;
}

function issuanceContext(overrides: Partial<IdJagIssuanceContext> = {}): IdJagIssuanceContext {
  return {
    params: validParams(),
    client: confidentialClient(),
    issuer: ISSUER,
    jwks: idpKey.jwks,
    signingKey: idpKey.signingKey,
    allowedAudiences: [AUDIENCE],
    lifetimeSeconds: 300,
    now: NOW,
    ...overrides,
  };
}

describe('id-jag issuance constants', () => {
  // draft §4.3 / RFC 8693 §3
  it('should expose the ID-JAG token type URN', () => {
    expect(ID_JAG_TOKEN_TYPE).toBe('urn:ietf:params:oauth:token-type:id-jag');
  });

  it('should expose the id_token subject token type URN', () => {
    expect(TOKEN_TYPE_ID_TOKEN).toBe('urn:ietf:params:oauth:token-type:id_token');
  });

  // draft §3.1: JWT header typ (RFC 8725 §3.11 explicit typing)
  it('should expose the oauth-id-jag+jwt typ value', () => {
    expect(ID_JAG_JWT_TYP).toBe('oauth-id-jag+jwt');
  });

  // draft §7.2 / §8
  it('should expose the grant profile identifier', () => {
    expect(ID_JAG_GRANT_PROFILE).toBe('urn:ietf:params:oauth:grant-profile:id-jag');
  });
});

describe('matchesIdJagIssuanceRequest', () => {
  it('should match a token-exchange request that asks for an ID-JAG', () => {
    expect(matchesIdJagIssuanceRequest(validParams())).toBe(true);
  });

  it('should not match a token-exchange request without requested_token_type', () => {
    expect(matchesIdJagIssuanceRequest(validParams({ requested_token_type: undefined }))).toBe(
      false,
    );
  });

  it('should not match a token-exchange request for an access token', () => {
    expect(
      matchesIdJagIssuanceRequest(
        validParams({ requested_token_type: 'urn:ietf:params:oauth:token-type:access_token' }),
      ),
    ).toBe(false);
  });

  it('should not match other grant types', () => {
    expect(matchesIdJagIssuanceRequest(validParams({ grant_type: 'authorization_code' }))).toBe(
      false,
    );
  });
});

describe('authorizeIdJagIssuanceClient', () => {
  it('should accept a confidential client registered for the token-exchange grant', () => {
    expect(() => authorizeIdJagIssuanceClient(confidentialClient())).not.toThrow();
  });

  // RFC 7591 §2: grantTypes 未指定は ['authorization_code'] 扱い
  it('should reject a client without registered grantTypes with unauthorized_client', () => {
    const client = confidentialClient();
    delete (client as { grantTypes?: string[] }).grantTypes;
    expect(() => authorizeIdJagIssuanceClient(client)).toThrow(
      new IdJagError(
        'unauthorized_client',
        'The client is not authorized to use the token-exchange grant type',
      ),
    );
  });

  it('should reject a client not registered for the token-exchange grant', () => {
    const client = confidentialClient({ grantTypes: ['authorization_code'] });
    expect(() => authorizeIdJagIssuanceClient(client)).toThrow(
      new IdJagError(
        'unauthorized_client',
        'The client is not authorized to use the token-exchange grant type',
      ),
    );
  });

  // draft §9.1: confidential client 限定
  it('should reject a public client with unauthorized_client', () => {
    const client = confidentialClient({
      tokenEndpointAuthMethod: 'none',
      clientSecret: undefined,
    });
    expect(() => authorizeIdJagIssuanceClient(client)).toThrow(
      new IdJagError('unauthorized_client', 'Public clients are not allowed to request an ID-JAG'),
    );
  });
});

describe('parseIdJagIssuanceParams', () => {
  it('should return the typed parameters', () => {
    expect(parseIdJagIssuanceParams(validParams({ resource: 'https://api.example.net/files' }))).toEqual({
      subjectToken: validIdToken,
      audience: AUDIENCE,
      scope: 'openid profile',
      resource: 'https://api.example.net/files',
    });
  });

  it('should treat omitted scope and resource as undefined', () => {
    expect(parseIdJagIssuanceParams(validParams({ scope: undefined }))).toEqual({
      subjectToken: validIdToken,
      audience: AUDIENCE,
      scope: undefined,
      resource: undefined,
    });
  });

  it('should reject a missing subject_token with invalid_request', () => {
    expect(() => parseIdJagIssuanceParams(validParams({ subject_token: undefined }))).toThrow(
      new IdJagError('invalid_request', 'subject_token is required'),
    );
  });

  it('should reject a missing subject_token_type with invalid_request', () => {
    expect(() => parseIdJagIssuanceParams(validParams({ subject_token_type: undefined }))).toThrow(
      new IdJagError('invalid_request', 'subject_token_type is required'),
    );
  });

  // 非目標: saml2 / refresh_token / access_token の subject は受けない
  it('should reject a saml2 subject_token_type with invalid_request', () => {
    expect(() =>
      parseIdJagIssuanceParams(
        validParams({ subject_token_type: 'urn:ietf:params:oauth:token-type:saml2' }),
      ),
    ).toThrow(
      new IdJagError(
        'invalid_request',
        `Unsupported subject_token_type for ID-JAG issuance. Only ${TOKEN_TYPE_ID_TOKEN} is supported.`,
      ),
    );
  });

  it('should reject a refresh_token subject_token_type with invalid_request', () => {
    expect(() =>
      parseIdJagIssuanceParams(
        validParams({ subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token' }),
      ),
    ).toThrow(IdJagError);
  });

  // draft §4.3: audience は REQUIRED
  it('should reject a missing audience with invalid_request', () => {
    expect(() => parseIdJagIssuanceParams(validParams({ audience: undefined }))).toThrow(
      new IdJagError('invalid_request', 'audience is required'),
    );
  });

  it('should treat a whitespace-only audience as missing', () => {
    expect(() => parseIdJagIssuanceParams(validParams({ audience: '   ' }))).toThrow(
      new IdJagError('invalid_request', 'audience is required'),
    );
  });

  // RFC 8707 §2: resource は絶対 URI・fragment 禁止
  it('should reject a relative resource with invalid_request', () => {
    expect(() => parseIdJagIssuanceParams(validParams({ resource: '/files' }))).toThrow(
      new IdJagError(
        'invalid_request',
        'resource must be an absolute URI without a fragment component',
      ),
    );
  });

  it('should reject a resource with a fragment with invalid_request', () => {
    expect(() =>
      parseIdJagIssuanceParams(validParams({ resource: 'https://api.example.net/#top' })),
    ).toThrow(IdJagError);
  });

  // draft §9.7: actor_token の処理規則は未定義なので fail-safe に拒否する
  it('should reject an actor_token with invalid_request', () => {
    expect(() => parseIdJagIssuanceParams(validParams({ actor_token: 'some-token' }))).toThrow(
      new IdJagError('invalid_request', 'actor_token is not supported for ID-JAG issuance'),
    );
  });

  it('should reject an actor_token_type with invalid_request', () => {
    expect(() =>
      parseIdJagIssuanceParams(
        validParams({ actor_token_type: 'urn:ietf:params:oauth:token-type:access_token' }),
      ),
    ).toThrow(IdJagError);
  });

  // 非目標: RAR
  it('should reject authorization_details with invalid_request', () => {
    expect(() =>
      parseIdJagIssuanceParams(validParams({ authorization_details: '[{"type":"x"}]' })),
    ).toThrow(
      new IdJagError('invalid_request', 'authorization_details is not supported for ID-JAG issuance'),
    );
  });
});

describe('resolveIdJagSubject', () => {
  it('should return the subject material from a valid ID Token', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const idToken = await mintIdToken({ auth_time: nowSeconds - 20 });
    await expect(
      resolveIdJagSubject({
        subjectToken: idToken,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        jwks: idpKey.jwks,
      }),
    ).resolves.toEqual({
      sub: 'user-1',
      authTime: nowSeconds - 20,
      acr: 'urn:mace:incommon:iap:silver',
      amr: ['pwd', 'mfa'],
    });
  });

  it('should omit auth context fields the ID Token does not carry', async () => {
    const idToken = await mintIdToken({ auth_time: undefined, acr: undefined, amr: undefined });
    await expect(
      resolveIdJagSubject({
        subjectToken: idToken,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        jwks: idpKey.jwks,
      }),
    ).resolves.toEqual({ sub: 'user-1' });
  });

  // draft §4.3.3: assertion の audience はクライアント認証の client_id と一致しなければならない
  it('should reject an ID Token issued to another client with the fixed description', async () => {
    const idToken = await mintIdToken({ aud: 'another-client' });
    await expect(
      resolveIdJagSubject({
        subjectToken: idToken,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        jwks: idpKey.jwks,
      }),
    ).rejects.toThrow(new IdJagError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION));
  });

  // オラクル排除: 失敗種別によらず同じ応答になる
  it('should reject a tampered ID Token with the same fixed description', async () => {
    const [headerB64 = '', payloadB64 = ''] = validIdToken.split('.');
    await expect(
      resolveIdJagSubject({
        subjectToken: `${headerB64}.${payloadB64}.AAAA`,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        jwks: idpKey.jwks,
      }),
    ).rejects.toThrow(new IdJagError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION));
  });

  it('should reject an expired ID Token with the same fixed description', async () => {
    // core の generateIdToken は期限切れ payload の生成自体を拒否するため、
    // 期限切れトークンはテスト用の JWS 手組みで作る（署名は正当なまま）。
    const nowSeconds = Math.floor(Date.now() / 1000);
    const idToken = await signTestJwt({
      header: { alg: 'RS256', typ: 'JWT', kid: idpKey.signingKey.keyId },
      payload: {
        iss: ISSUER,
        sub: 'user-1',
        aud: CLIENT_ID,
        exp: nowSeconds - 3600,
        iat: nowSeconds - 7200,
      },
      privateKey: idpKey.signingKey.privateKey,
    });
    await expect(
      resolveIdJagSubject({
        subjectToken: idToken,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        jwks: idpKey.jwks,
      }),
    ).rejects.toThrow(new IdJagError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION));
  });

  it('should reject an ID Token from another issuer with the same fixed description', async () => {
    const idToken = await mintIdToken({ iss: 'https://other-idp.example.com' });
    await expect(
      resolveIdJagSubject({
        subjectToken: idToken,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        jwks: idpKey.jwks,
      }),
    ).rejects.toThrow(new IdJagError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION));
  });
});

describe('validateIdJagAudience', () => {
  it('should accept an allow-listed audience', () => {
    expect(() =>
      validateIdJagAudience({
        audience: AUDIENCE,
        issuer: ISSUER,
        allowedAudiences: [AUDIENCE],
      }),
    ).not.toThrow();
  });

  it('should reject an audience outside the allow list with invalid_target', () => {
    expect(() =>
      validateIdJagAudience({
        audience: 'https://unknown.example.org',
        issuer: ISSUER,
        allowedAudiences: [AUDIENCE],
      }),
    ).toThrow(
      new IdJagError('invalid_target', 'The requested audience is not allowed for ID-JAG issuance'),
    );
  });

  it('should reject every audience when the allow list is empty', () => {
    expect(() =>
      validateIdJagAudience({ audience: AUDIENCE, issuer: ISSUER, allowedAudiences: [] }),
    ).toThrow(IdJagError);
  });

  // draft §9.3: クロスドメイン限定。自分宛ての発行は許可リストに関係なく拒否する
  it('should reject the issuer itself as audience even when allow-listed', () => {
    expect(() =>
      validateIdJagAudience({ audience: ISSUER, issuer: ISSUER, allowedAudiences: [ISSUER] }),
    ).toThrow(
      new IdJagError(
        'invalid_target',
        'The requested audience must belong to a different trust domain than this authorization server',
      ),
    );
  });
});

describe('validateIdJagScope', () => {
  it('should pass the requested scope through when no allow list is configured', () => {
    expect(validateIdJagScope('openid profile', undefined)).toEqual(['openid', 'profile']);
  });

  it('should return an empty scope when nothing is requested', () => {
    expect(validateIdJagScope(undefined, undefined)).toEqual([]);
  });

  it('should deduplicate repeated scope values', () => {
    expect(validateIdJagScope('openid openid profile', undefined)).toEqual(['openid', 'profile']);
  });

  it('should accept a subset of the configured allow list', () => {
    expect(validateIdJagScope('openid', ['openid', 'profile'])).toEqual(['openid']);
  });

  it('should reject a scope outside the allow list with invalid_scope', () => {
    expect(() => validateIdJagScope('openid admin', ['openid', 'profile'])).toThrow(
      new IdJagError(
        'invalid_scope',
        'The requested scope exceeds the scopes allowed for ID-JAG issuance',
      ),
    );
  });
});

describe('buildIdJagClaims', () => {
  // draft §3.1 の REQUIRED クレーム一式
  it('should build the required claims from the subject and request', () => {
    const claims = buildIdJagClaims({
      issuer: ISSUER,
      subject: { sub: 'user-1' },
      audience: AUDIENCE,
      clientId: CLIENT_ID,
      scope: ['openid', 'profile'],
      lifetimeSeconds: 300,
      now: NOW,
    });
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: 'user-1',
      aud: AUDIENCE,
      client_id: CLIENT_ID,
      exp: NOW_SECONDS + 300,
      iat: NOW_SECONDS,
      scope: 'openid profile',
    });
    expect(typeof claims.jti).toBe('string');
    // 256bit を base64url した長さ（43 文字）
    expect(claims.jti.length).toBe(43);
  });

  it('should omit the scope claim when no scope was granted', () => {
    const claims = buildIdJagClaims({
      issuer: ISSUER,
      subject: { sub: 'user-1' },
      audience: AUDIENCE,
      clientId: CLIENT_ID,
      scope: [],
      lifetimeSeconds: 300,
      now: NOW,
    });
    expect('scope' in claims).toBe(false);
  });

  it('should carry resource and auth context claims when present', () => {
    const claims = buildIdJagClaims({
      issuer: ISSUER,
      subject: { sub: 'user-1', authTime: NOW_SECONDS - 60, acr: 'silver', amr: ['pwd'] },
      audience: AUDIENCE,
      clientId: CLIENT_ID,
      scope: [],
      resource: 'https://api.example.net/files',
      lifetimeSeconds: 300,
      now: NOW,
    });
    expect(claims).toMatchObject({
      resource: 'https://api.example.net/files',
      auth_time: NOW_SECONDS - 60,
      acr: 'silver',
      amr: ['pwd'],
    });
  });

  it('should reject a non-positive lifetime with a RangeError', () => {
    expect(() =>
      buildIdJagClaims({
        issuer: ISSUER,
        subject: { sub: 'user-1' },
        audience: AUDIENCE,
        clientId: CLIENT_ID,
        scope: [],
        lifetimeSeconds: 0,
        now: NOW,
      }),
    ).toThrow(RangeError);
  });
});

describe('createIdJagJwt', () => {
  // draft §3.1: typ は oauth-id-jag+jwt（RFC 8725 §3.11）
  it('should set alg RS256, the ID-JAG typ and the kid in the JOSE header', async () => {
    const claims = buildIdJagClaims({
      issuer: ISSUER,
      subject: { sub: 'user-1' },
      audience: AUDIENCE,
      clientId: CLIENT_ID,
      scope: ['openid'],
      lifetimeSeconds: 300,
      now: NOW,
    });
    const jwt = await createIdJagJwt({ claims, signingKey: idpKey.signingKey });
    const { header, payload } = decodeJwt(jwt);
    expect(header).toEqual({
      alg: 'RS256',
      typ: 'oauth-id-jag+jwt',
      kid: 'idp-rs256-key',
    });
    expect(payload).toEqual({ ...claims });
  });

  it('should produce a verifiable RS256 signature', async () => {
    const claims = buildIdJagClaims({
      issuer: ISSUER,
      subject: { sub: 'user-1' },
      audience: AUDIENCE,
      clientId: CLIENT_ID,
      scope: [],
      lifetimeSeconds: 300,
      now: NOW,
    });
    const jwt = await createIdJagJwt({ claims, signingKey: idpKey.signingKey });
    const [headerB64 = '', payloadB64 = '', signatureB64 = ''] = jwt.split('.');
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      idpKey.jwk as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const base64 = signatureB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const signature = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    await expect(
      crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        signature,
        new TextEncoder().encode(`${headerB64}.${payloadB64}`),
      ),
    ).resolves.toBe(true);
  });
});

describe('buildIdJagIssuanceResponse', () => {
  // draft §4.3.4: token_type は N_A、issued_token_type は ID-JAG の URN
  it('should build the RFC 8693 response with token_type N_A', () => {
    expect(
      buildIdJagIssuanceResponse({ idJag: 'jwt-value', expiresIn: 300, scope: ['openid'] }),
    ).toEqual({
      access_token: 'jwt-value',
      issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
      token_type: 'N_A',
      expires_in: 300,
      scope: 'openid',
    });
  });

  it('should return an empty scope string when no scope was granted', () => {
    expect(buildIdJagIssuanceResponse({ idJag: 'jwt-value', expiresIn: 300, scope: [] })).toEqual({
      access_token: 'jwt-value',
      issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
      token_type: 'N_A',
      expires_in: 300,
      scope: '',
    });
  });
});

describe('processIdJagIssuanceRequest', () => {
  it('should issue an ID-JAG for a valid request', async () => {
    const response = await processIdJagIssuanceRequest(issuanceContext());
    expect(response.issued_token_type).toBe('urn:ietf:params:oauth:token-type:id-jag');
    expect(response.token_type).toBe('N_A');
    expect(response.expires_in).toBe(300);
    expect(response.scope).toBe('openid profile');

    const { header, payload } = decodeJwt(response.access_token);
    expect(header['typ']).toBe('oauth-id-jag+jwt');
    expect(header['alg']).toBe('RS256');
    expect(payload).toMatchObject({
      iss: ISSUER,
      sub: 'user-1',
      aud: AUDIENCE,
      client_id: CLIENT_ID,
      exp: NOW_SECONDS + 300,
      iat: NOW_SECONDS,
      scope: 'openid profile',
    });
  });

  it('should reject an unauthorized client before validating the subject_token', async () => {
    await expect(
      processIdJagIssuanceRequest(
        issuanceContext({
          client: confidentialClient({ grantTypes: ['authorization_code'] }),
          params: validParams({ subject_token: 'never-validated' }),
        }),
      ),
    ).rejects.toThrow(
      new IdJagError(
        'unauthorized_client',
        'The client is not authorized to use the token-exchange grant type',
      ),
    );
  });

  it('should reject an ID Token issued to another client with invalid_request', async () => {
    const foreignIdToken = await mintIdToken({ aud: 'another-client' });
    await expect(
      processIdJagIssuanceRequest(
        issuanceContext({ params: validParams({ subject_token: foreignIdToken }) }),
      ),
    ).rejects.toThrow(new IdJagError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION));
  });

  it('should reject an audience outside the allow list with invalid_target', async () => {
    await expect(
      processIdJagIssuanceRequest(
        issuanceContext({ params: validParams({ audience: 'https://unknown.example.org' }) }),
      ),
    ).rejects.toThrow(
      new IdJagError('invalid_target', 'The requested audience is not allowed for ID-JAG issuance'),
    );
  });

  it('should reject the issuer itself as audience with invalid_target', async () => {
    await expect(
      processIdJagIssuanceRequest(
        issuanceContext({
          params: validParams({ audience: ISSUER }),
          allowedAudiences: [AUDIENCE, ISSUER],
        }),
      ),
    ).rejects.toThrow(
      new IdJagError(
        'invalid_target',
        'The requested audience must belong to a different trust domain than this authorization server',
      ),
    );
  });

  it('should reject a scope outside the configured allow list with invalid_scope', async () => {
    await expect(
      processIdJagIssuanceRequest(
        issuanceContext({
          allowedScopes: ['openid'],
          params: validParams({ scope: 'openid profile' }),
        }),
      ),
    ).rejects.toThrow(
      new IdJagError(
        'invalid_scope',
        'The requested scope exceeds the scopes allowed for ID-JAG issuance',
      ),
    );
  });

  it('should omit the scope claim and return an empty scope when none was requested', async () => {
    const response = await processIdJagIssuanceRequest(
      issuanceContext({ params: validParams({ scope: undefined }) }),
    );
    expect(response.scope).toBe('');
    const { payload } = decodeJwt(response.access_token);
    expect('scope' in payload).toBe(false);
  });

  it('should carry the resource parameter into the resource claim', async () => {
    const response = await processIdJagIssuanceRequest(
      issuanceContext({ params: validParams({ resource: 'https://api.example.net/files' }) }),
    );
    const { payload } = decodeJwt(response.access_token);
    expect(payload['resource']).toBe('https://api.example.net/files');
  });
});
