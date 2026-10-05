/**
 * トークンレスポンス生成ステップの振る舞いテスト。
 *
 * CLI 生成のトークンルートは、次のステップを順に呼び出してトークンレスポンスを組み立てる。
 *   buildAccessTokenPayload → AccessTokenIssuer.issue → computeAtHash → resolveAcrAmr
 *   → buildIdTokenPayload → generateIdToken
 * 本ファイルは各振る舞いを、それを担うステップ関数に対して検証する。ステップをまたぐ性質
 * （ID Token の at_hash と実際に発行したアクセストークンの結合など）は、必要なステップだけを
 * テスト内で呼び出して検証する。レスポンス body の組み立てを含むエンドツーエンドの振る舞いは、
 * CLI が生成する conformance テストが担保する。
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  buildIdTokenAudience,
  buildIdTokenPayload,
  computeAtHash,
  resolveAcrAmr,
} from './token-response.js';
import type { AccessTokenPayloadInput, IdTokenPayloadInput } from './token-response.js';
import { createJwtAccessTokenIssuer } from './access-token-issuer.js';
import { generateIdToken } from './id-token.js';
import type { UserClaims } from './userinfo.js';
import { base64UrlToArrayBuffer, arrayBufferToBase64Url, stringToArrayBuffer } from './crypto-utils.js';

type KeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };

/** ペイロード組み立てだけを検証するテストの固定時刻（Unix epoch 秒） */
const NOW = 1_700_000_000;

// --- Helper: RSA鍵ペアの生成 ---
let rsaKeyPair: KeyPair;
let secondaryKeyPair: KeyPair;

async function generateRsaKey(hash: 'SHA-256' | 'SHA-384' | 'SHA-512'): Promise<KeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash,
    },
    true,
    ['sign', 'verify'],
  );
}

async function generateEcKey(namedCurve: 'P-256' | 'P-384' | 'P-521'): Promise<KeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, ['sign', 'verify']);
}

beforeAll(async () => {
  rsaKeyPair = await generateRsaKey('SHA-256');
  secondaryKeyPair = await generateRsaKey('SHA-256');
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * generateAccessToken / generateIdToken は exp が過去のペイロードを拒否するため、
 * 署名まで行うテストは固定時刻 NOW ではなく現在時刻を issuedAt に使う。
 */
function currentTime(): number {
  return Math.floor(Date.now() / 1000);
}

function accessTokenInput(overrides?: Partial<AccessTokenPayloadInput>): AccessTokenPayloadInput {
  return {
    issuer: 'https://op.example.com',
    subject: 'user-123',
    clientId: 'client-456',
    scope: ['openid', 'profile'],
    expiresIn: 3600,
    issuedAt: NOW,
    ...overrides,
  };
}

function idTokenInput(overrides?: Partial<IdTokenPayloadInput>): IdTokenPayloadInput {
  return {
    issuer: 'https://op.example.com',
    subject: 'user-123',
    clientId: 'client-456',
    scope: ['openid', 'profile'],
    expiresIn: 3600,
    issuedAt: NOW,
    ...overrides,
  };
}

/**
 * JWTをデコードするヘルパー
 */
function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const parts = token.split('.');
  const header = JSON.parse(new TextDecoder().decode(base64UrlToArrayBuffer(parts[0]!)));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToArrayBuffer(parts[1]!)));
  return { header, payload };
}

/**
 * RS256（RSASSA-PKCS1-v1_5 / SHA-256）の JWS 署名を公開鍵で検証するヘルパー
 */
async function verifyRs256Signature(jwt: string, publicKey: CryptoKey): Promise<boolean> {
  const [headerB64, payloadB64, signatureB64] = jwt.split('.');
  return crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    publicKey,
    base64UrlToArrayBuffer(signatureB64!),
    stringToArrayBuffer(`${headerB64}.${payloadB64}`),
  );
}

/**
 * OIDC Core 1.0 §3.1.3.6 の定義どおりに at_hash の期待値を求めるヘルパー。
 * access_token をハッシュし、左半分を base64url エンコードする。
 */
async function expectedHash(
  accessToken: string,
  hashName: 'SHA-256' | 'SHA-384' | 'SHA-512',
): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(hashName, stringToArrayBuffer(accessToken));
  const leftHalf = hashBuffer.slice(0, hashBuffer.byteLength / 2);
  return arrayBufferToBase64Url(leftHalf);
}

// RFC 9068 §3: a JWT access token's aud must be non-empty and identify the
// resource(s) the token is intended for. This helper centralises the audience
// composition policy so every framework template (and direct core callers)
// build the aud the same way: the OP's own UserInfo endpoint is a permanent
// member, requested resource indicators are appended, duplicates are removed,
// and an empty result falls back to the issuer.
describe('buildAccessTokenAudience', () => {
  it('should fall back to issuer when neither userInfoEndpoint nor requested is provided', () => {
    expect(buildAccessTokenAudience({ issuer: 'https://op.example.com' })).toEqual([
      'https://op.example.com',
    ]);
  });

  it('should fall back to issuer when requested is an empty array and no userInfoEndpoint', () => {
    expect(buildAccessTokenAudience({ requested: [], issuer: 'https://op.example.com' })).toEqual([
      'https://op.example.com',
    ]);
  });

  it('should include only the userInfoEndpoint when no resource is requested', () => {
    expect(
      buildAccessTokenAudience({
        userInfoEndpoint: 'https://op.example.com/userinfo',
        issuer: 'https://op.example.com',
      }),
    ).toEqual(['https://op.example.com/userinfo']);
  });

  it('should use requested resources as-is when no userInfoEndpoint is provided', () => {
    expect(
      buildAccessTokenAudience({
        requested: ['https://api.example.com'],
        issuer: 'https://op.example.com',
      }),
    ).toEqual(['https://api.example.com']);
  });

  it('should keep the userInfoEndpoint as the first member and append requested resources', () => {
    expect(
      buildAccessTokenAudience({
        userInfoEndpoint: 'https://op.example.com/userinfo',
        requested: ['https://api.example.com'],
        issuer: 'https://op.example.com',
      }),
    ).toEqual(['https://op.example.com/userinfo', 'https://api.example.com']);
  });

  it('should never remove the userInfoEndpoint when multiple resources are requested', () => {
    const aud = buildAccessTokenAudience({
      userInfoEndpoint: 'https://op.example.com/userinfo',
      requested: ['https://api1.example.com', 'https://api2.example.com'],
      issuer: 'https://op.example.com',
    });
    expect(aud).toEqual([
      'https://op.example.com/userinfo',
      'https://api1.example.com',
      'https://api2.example.com',
    ]);
  });

  it('should deduplicate when requested already contains the userInfoEndpoint', () => {
    expect(
      buildAccessTokenAudience({
        userInfoEndpoint: 'https://op.example.com/userinfo',
        requested: ['https://op.example.com/userinfo', 'https://api.example.com'],
        issuer: 'https://op.example.com',
      }),
    ).toEqual(['https://op.example.com/userinfo', 'https://api.example.com']);
  });

  it('should deduplicate repeated requested resources', () => {
    expect(
      buildAccessTokenAudience({
        requested: ['https://api.example.com', 'https://api.example.com'],
        issuer: 'https://op.example.com',
      }),
    ).toEqual(['https://api.example.com']);
  });

  it('should be idempotent when re-applied to an already composed audience (refresh case)', () => {
    const first = buildAccessTokenAudience({
      userInfoEndpoint: 'https://op.example.com/userinfo',
      requested: ['https://api.example.com'],
      issuer: 'https://op.example.com',
    });
    // On refresh the stored (already composed) audience is fed back in as requested.
    const second = buildAccessTokenAudience({
      userInfoEndpoint: 'https://op.example.com/userinfo',
      requested: first,
      issuer: 'https://op.example.com',
    });
    expect(second).toEqual(first);
  });
});

describe('buildAccessTokenPayload', () => {
  // RFC 9068 §2.2: iss / sub / aud / exp / iat / jti / scope / client_id
  describe('JWT access token claims (RFC 9068 §2.2)', () => {
    it('should have iss claim matching issuer', () => {
      const payload = buildAccessTokenPayload(accessTokenInput({ issuer: 'https://op.example.com' }));
      expect(payload.iss).toBe('https://op.example.com');
    });

    it('should have sub claim matching subject', () => {
      const payload = buildAccessTokenPayload(accessTokenInput({ subject: 'user-abc' }));
      expect(payload.sub).toBe('user-abc');
    });

    it('should have client_id claim', () => {
      const payload = buildAccessTokenPayload(accessTokenInput({ clientId: 'client-xyz' }));
      expect(payload.client_id).toBe('client-xyz');
    });

    it('should have scope claim as space-separated string', () => {
      const payload = buildAccessTokenPayload(
        accessTokenInput({ scope: ['openid', 'profile', 'email'] }),
      );
      expect(payload.scope).toBe('openid profile email');
    });

    it('should have scope claim without trailing space for a single scope', () => {
      const payload = buildAccessTokenPayload(accessTokenInput({ scope: ['openid'] }));
      expect(payload.scope).toBe('openid');
    });

    it('should set exp claim to issuedAt plus expiresIn', () => {
      const payload = buildAccessTokenPayload(accessTokenInput({ issuedAt: NOW, expiresIn: 3600 }));
      expect(payload.exp).toBe(NOW + 3600);
    });

    it('should set iat claim to the current time when issuedAt is omitted', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000 + 999);
      const payload = buildAccessTokenPayload(accessTokenInput({ issuedAt: undefined }));
      // RFC 7519 §2: NumericDate は秒単位のため、ミリ秒は切り捨てる。
      expect(payload.iat).toBe(NOW);
    });

    // RFC 9068 §2.2: jti is REQUIRED. RFC 7519 §4.1.7 requires a negligible
    // collision probability, which also keeps two same-second issuances distinct
    // (RS256 is a deterministic signature scheme, RFC 8017 §8.2).
    it('should have a 128-bit base64url jti claim', () => {
      const payload = buildAccessTokenPayload(accessTokenInput());
      expect(typeof payload.jti).toBe('string');
      expect(payload.jti).toHaveLength(22);
      expect(payload.jti).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('aud claim (RFC 9068 §3)', () => {
    it('should use provided audience for aud claim', () => {
      const payload = buildAccessTokenPayload(
        accessTokenInput({ audience: ['https://api.example.com', 'https://other.example.com'] }),
      );
      expect(payload.aud).toEqual(['https://api.example.com', 'https://other.example.com']);
    });

    // RFC 9068 Section 3: a JWT access token MUST carry a non-empty aud.
    // When no audience is supplied, the issuer (the OP itself) is used as the
    // default audience so the token is never issued with an empty aud.
    it('should default aud to issuer when audience is not provided', () => {
      const payload = buildAccessTokenPayload(accessTokenInput({ issuer: 'https://op.default-aud.com' }));
      expect(payload.aud).toEqual(['https://op.default-aud.com']);
    });

    it('should default aud to issuer when audience is an empty array', () => {
      const payload = buildAccessTokenPayload(
        accessTokenInput({ issuer: 'https://op.empty-aud.com', audience: [] }),
      );
      expect(payload.aud).toEqual(['https://op.empty-aud.com']);
    });

    // OIDC Core 1.0 Section 12 / RFC 9068: refresh_token grant must preserve the
    // original aud. The caller passes the stored audience back into the request,
    // so an explicitly-supplied audience is retained across rotations.
    it('should retain the same aud when audience is passed again (refresh case)', () => {
      const audience = ['https://api.example.com'];
      const first = buildAccessTokenPayload(accessTokenInput({ audience }));
      const second = buildAccessTokenPayload(accessTokenInput({ audience }));
      expect(first.aud).toEqual(['https://api.example.com']);
      expect(second.aud).toEqual(['https://api.example.com']);
    });

    it('should retain the default issuer aud across successive builds (refresh case)', () => {
      const input = accessTokenInput({ issuer: 'https://op.refresh-default.com' });
      const first = buildAccessTokenPayload(input);
      const second = buildAccessTokenPayload(input);
      expect(first.aud).toEqual(['https://op.refresh-default.com']);
      expect(second.aud).toEqual(['https://op.refresh-default.com']);
    });
  });
});

describe('createJwtAccessTokenIssuer', () => {
  it('should be a valid JWT with three parts', async () => {
    const accessToken = await createJwtAccessTokenIssuer().issue({
      payload: buildAccessTokenPayload(accessTokenInput({ issuedAt: currentTime() })),
      privateKey: rsaKeyPair.privateKey,
    });
    expect(accessToken.split('.')).toHaveLength(3);
  });

  // RFC 9068 §2.2: buildAccessTokenPayload が組み立てたクレームは、署名後の JWT にそのまま載る。
  // 呼び出し側はこの payload の jti をストアへ保存してイントロスペクション（RFC 7662 §2.2）で
  // 返すため、トークン内の jti はその値と一致していなければならない。
  // nbf は issuer が iat と同じ値で補う（RFC 7519 §4.1.5）。
  it('should embed the built payload unchanged and add nbf equal to iat', async () => {
    const payload = buildAccessTokenPayload(accessTokenInput({ issuedAt: currentTime() }));
    const accessToken = await createJwtAccessTokenIssuer().issue({
      payload,
      privateKey: rsaKeyPair.privateKey,
    });
    expect(decodeJwt(accessToken).payload).toEqual({ ...payload, nbf: payload.iat });
  });

  // RFC 9068 §2.1: JWT access token の typ は at+jwt。alg は署名鍵から決まる。
  it('should include kid in the JOSE header when keyId is provided', async () => {
    const accessToken = await createJwtAccessTokenIssuer().issue({
      payload: buildAccessTokenPayload(accessTokenInput({ issuedAt: currentTime() })),
      privateKey: rsaKeyPair.privateKey,
      keyId: 'my-key-1',
    });
    expect(decodeJwt(accessToken).header).toEqual({ alg: 'RS256', typ: 'at+jwt', kid: 'my-key-1' });
  });

  // OIDC Core 1.0 allows id_token_signed_response_alg to be configured per client,
  // so the access token and the ID Token MAY be signed with different keys.
  // The access token is signed with the key passed to issue(), never another one.
  it('should sign with the given privateKey so that only its public key verifies the signature', async () => {
    const accessToken = await createJwtAccessTokenIssuer().issue({
      payload: buildAccessTokenPayload(accessTokenInput({ issuedAt: currentTime() })),
      privateKey: rsaKeyPair.privateKey,
    });
    expect(await verifyRs256Signature(accessToken, rsaKeyPair.publicKey)).toBe(true);
    expect(await verifyRs256Signature(accessToken, secondaryKeyPair.publicKey)).toBe(false);
  });

  // RFC 9068 §2.2 / RFC 8017 §8.2: RS256 は決定的な署名方式のため、同一入力・同一秒の
  // 2 回の発行を別トークンにするのは buildAccessTokenPayload が発行ごとに生成する jti である。
  it('should issue a different access token for two identical requests in the same second', async () => {
    const input = accessTokenInput({ issuedAt: currentTime() });
    const issuer = createJwtAccessTokenIssuer();
    const first = await issuer.issue({
      payload: buildAccessTokenPayload(input),
      privateKey: rsaKeyPair.privateKey,
    });
    const second = await issuer.issue({
      payload: buildAccessTokenPayload(input),
      privateKey: rsaKeyPair.privateKey,
    });
    expect(first === second).toBe(false);
  });

  // RFC 9068 Section 3: a JWT access token MUST carry a non-empty aud.
  // buildAccessTokenPayload は空の audience を issuer にフォールバックするが、呼び出し側が
  // 署名前に payload の aud を空にした場合も、issuer は空 aud のトークンを発行しない。
  it('should never issue a JWT access token with an empty aud', async () => {
    const payload = {
      ...buildAccessTokenPayload(accessTokenInput({ issuedAt: currentTime() })),
      aud: [],
    };
    await expect(
      createJwtAccessTokenIssuer().issue({ payload, privateKey: rsaKeyPair.privateKey }),
    ).rejects.toThrow('Invalid aud claim: must be a non-empty array');
  });
});

// OIDC Core 1.0 §3.1.3.6: "the hash algorithm used is the hash algorithm used
// in the `alg` Header Parameter of the ID Token's JOSE Header." When the ID Token
// is signed with a non-SHA-256 alg, at_hash must follow that alg's hash function.
describe('computeAtHash', () => {
  describe('at_hash hash algorithm agility', () => {
    // at_hash の対象は JWT issuer が実際に発行した（RS256 署名の）アクセストークン。
    let accessToken: string;

    beforeAll(async () => {
      accessToken = await createJwtAccessTokenIssuer().issue({
        payload: buildAccessTokenPayload(accessTokenInput({ issuedAt: currentTime() })),
        privateKey: rsaKeyPair.privateKey,
      });
    });

    it('should compute at_hash with SHA-256 left half (16 bytes) for RS256 id_token', async () => {
      const key = await generateRsaKey('SHA-256');
      const atHash = await computeAtHash(accessToken, key.privateKey);

      expect(atHash).toBe(await expectedHash(accessToken, 'SHA-256'));
      // SHA-256 (32 bytes) -> left half 16 bytes -> base64url length 22
      expect(atHash).toHaveLength(22);
    });

    it('should compute at_hash with SHA-256 left half for ES256 id_token', async () => {
      const key = await generateEcKey('P-256');
      const atHash = await computeAtHash(accessToken, key.privateKey);

      expect(atHash).toBe(await expectedHash(accessToken, 'SHA-256'));
    });

    it('should compute at_hash with SHA-384 left half (24 bytes) for RS384 id_token', async () => {
      const key = await generateRsaKey('SHA-384');
      const atHash = await computeAtHash(accessToken, key.privateKey);

      expect(atHash).toBe(await expectedHash(accessToken, 'SHA-384'));
      // SHA-384 (48 bytes) -> left half 24 bytes -> base64url length 32
      expect(atHash).toHaveLength(32);
    });

    it('should compute at_hash with SHA-384 left half for ES384 id_token', async () => {
      const key = await generateEcKey('P-384');
      const atHash = await computeAtHash(accessToken, key.privateKey);

      expect(atHash).toBe(await expectedHash(accessToken, 'SHA-384'));
    });

    it('should compute at_hash with SHA-512 left half (32 bytes) for RS512 id_token', async () => {
      const key = await generateRsaKey('SHA-512');
      const atHash = await computeAtHash(accessToken, key.privateKey);

      expect(atHash).toBe(await expectedHash(accessToken, 'SHA-512'));
      // SHA-512 (64 bytes) -> left half 32 bytes -> base64url length 43
      expect(atHash).toHaveLength(43);
    });

    it('should compute at_hash with SHA-512 left half for ES512 id_token', async () => {
      const key = await generateEcKey('P-521');
      const atHash = await computeAtHash(accessToken, key.privateKey);

      expect(atHash).toBe(await expectedHash(accessToken, 'SHA-512'));
    });
  });

  // at_hash は ID Token を同じレスポンスのアクセストークンに結び付ける。トークンルートと同じ順で
  // 必要なステップだけを呼び出し、署名済み ID Token の at_hash が実際に発行したアクセストークンと
  // 一致することを確かめる。
  describe('binding the ID Token to the issued access token', () => {
    it('should compute at_hash as left half of SHA-256 hash of the issued access_token', async () => {
      const issuedAt = currentTime();
      const accessToken = await createJwtAccessTokenIssuer().issue({
        payload: buildAccessTokenPayload(accessTokenInput({ issuedAt })),
        privateKey: rsaKeyPair.privateKey,
      });
      const atHash = await computeAtHash(accessToken, rsaKeyPair.privateKey);
      const idToken = await generateIdToken({
        payload: buildIdTokenPayload(idTokenInput({ issuedAt, atHash })),
        privateKey: rsaKeyPair.privateKey,
      });

      // SHA-256 of access_token, take left 128 bits, base64url encode
      const { header, payload } = decodeJwt(idToken);
      expect(header.alg).toBe('RS256');
      expect(payload.at_hash).toBe(await expectedHash(accessToken, 'SHA-256'));
    });

    it('should base at_hash on the id_token signing alg, not the access_token signing alg', async () => {
      // access_token signed with RS256 (SHA-256), id_token signed with RS512 (SHA-512).
      const idTokenKey = await generateRsaKey('SHA-512');
      const issuedAt = currentTime();
      const accessToken = await createJwtAccessTokenIssuer().issue({
        payload: buildAccessTokenPayload(accessTokenInput({ issuedAt })),
        privateKey: rsaKeyPair.privateKey,
      });
      const atHash = await computeAtHash(accessToken, idTokenKey.privateKey);
      const idToken = await generateIdToken({
        payload: buildIdTokenPayload(idTokenInput({ issuedAt, atHash })),
        privateKey: idTokenKey.privateKey,
      });

      const { header: accessTokenHeader } = decodeJwt(accessToken);
      const { header: idTokenHeader, payload } = decodeJwt(idToken);
      expect(accessTokenHeader.alg).toBe('RS256');
      expect(idTokenHeader.alg).toBe('RS512');
      expect(payload.at_hash).toBe(await expectedHash(accessToken, 'SHA-512'));
      expect(payload.at_hash).not.toBe(await expectedHash(accessToken, 'SHA-256'));
    });
  });
});

// OIDC Core 1.0 §2 / §12.1: acr / amr conveyance in the ID Token.
// The OP cannot decide acr / amr policy on its own — it must be injected by the
// hosting application. T-015 introduces an AcrResolver that the application can
// implement; without one, acr / amr are left out of the ID Token.
describe('resolveAcrAmr', () => {
  describe('acr / amr resolver injection (T-015)', () => {
    it('should include acr and amr in the ID Token when the resolver returns values', async () => {
      const resolved = await resolveAcrAmr({
        subject: 'user-123',
        clientId: 'client-456',
        acrResolver: async () => ({ acr: 'urn:mace:incommon:iap:silver', amr: ['pwd', 'mfa'] }),
      });
      const payload = buildIdTokenPayload(idTokenInput({ acr: resolved.acr, amr: resolved.amr }));

      // 解決値は呼び出し側が refresh token へ永続化する（OIDC Core 1.0 §12.1）ため、戻り値も固定する。
      expect(resolved).toEqual({ acr: 'urn:mace:incommon:iap:silver', amr: ['pwd', 'mfa'] });
      expect(payload.acr).toBe('urn:mace:incommon:iap:silver');
      expect(payload.amr).toEqual(['pwd', 'mfa']);
    });

    it('should pass userId, clientId and requestedAcrValues to the resolver', async () => {
      const calls: Array<{ userId: string; clientId: string; requestedAcrValues?: string }> = [];
      await resolveAcrAmr({
        subject: 'user-acr',
        clientId: 'client-acr',
        requestedAcrValues: '0 1',
        acrResolver: async (ctx) => {
          calls.push(ctx);
          return { acr: '1', amr: ['pwd'] };
        },
      });
      expect(calls).toEqual([
        {
          userId: 'user-acr',
          clientId: 'client-acr',
          requestedAcrValues: '0 1',
        },
      ]);
    });

    it('should omit acr and amr from ID Token when the resolver returns undefined', async () => {
      const resolved = await resolveAcrAmr({
        subject: 'user-123',
        clientId: 'client-456',
        acrResolver: async () => undefined,
      });
      const payload = buildIdTokenPayload(idTokenInput({ acr: resolved.acr, amr: resolved.amr }));

      expect(resolved).toEqual({ acr: undefined, amr: undefined });
      expect(Object.prototype.hasOwnProperty.call(payload, 'acr')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(payload, 'amr')).toBe(false);
    });

    it('should omit acr and amr from ID Token when no resolver is provided', async () => {
      const resolved = await resolveAcrAmr({ subject: 'user-123', clientId: 'client-456' });
      const payload = buildIdTokenPayload(idTokenInput({ acr: resolved.acr, amr: resolved.amr }));

      expect(resolved).toEqual({ acr: undefined, amr: undefined });
      expect(Object.prototype.hasOwnProperty.call(payload, 'acr')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(payload, 'amr')).toBe(false);
    });
  });

  describe('refresh_token grant (OIDC Core §12.1)', () => {
    // OIDC Core 1.0 §12.1 SHOULD: refresh で発行する ID Token は初回認証時の
    // acr / amr を保持する。caller は格納済みの値を直接渡し、resolver は呼び出さない。
    it('should use directly-passed acr/amr (refresh case) and skip resolver', async () => {
      let resolverCalled = false;
      const resolved = await resolveAcrAmr({
        subject: 'user-123',
        clientId: 'client-456',
        acr: 'urn:initial',
        amr: ['pwd'],
        acrResolver: async () => {
          resolverCalled = true;
          return { acr: 'should-not-be-used', amr: ['x'] };
        },
      });
      const payload = buildIdTokenPayload(idTokenInput({ acr: resolved.acr, amr: resolved.amr }));

      expect(resolved).toEqual({ acr: 'urn:initial', amr: ['pwd'] });
      expect(payload.acr).toBe('urn:initial');
      expect(payload.amr).toEqual(['pwd']);
      expect(resolverCalled).toBe(false);
    });
  });

  // OIDC Core 1.0 §5.5.1.1: claims.id_token.acr.values drives requested acr_values.
  describe('claims.id_token.acr.values (OIDC Core §5.5.1.1)', () => {
    it('should pass claims.id_token.acr.values to the resolver as requestedAcrValues', async () => {
      let receivedAcrValues: string | undefined;
      const resolved = await resolveAcrAmr({
        subject: 'user-123',
        clientId: 'client-456',
        claims: {
          id_token: { acr: { essential: true, values: ['urn:a', 'urn:b'] } },
        },
        acrResolver: async (ctx) => {
          receivedAcrValues = ctx.requestedAcrValues;
          return { acr: 'urn:a', amr: ['pwd'] };
        },
      });
      expect(receivedAcrValues).toBe('urn:a urn:b');
      expect(resolved).toEqual({ acr: 'urn:a', amr: ['pwd'] });
    });

    it('should let acr_values request param take precedence over claims.id_token.acr.values', async () => {
      let receivedAcrValues: string | undefined;
      await resolveAcrAmr({
        subject: 'user-123',
        clientId: 'client-456',
        requestedAcrValues: 'urn:from-acr-values',
        claims: {
          id_token: { acr: { values: ['urn:from-claims'] } },
        },
        acrResolver: async (ctx) => {
          receivedAcrValues = ctx.requestedAcrValues;
          return { acr: 'urn:from-acr-values', amr: ['pwd'] };
        },
      });
      expect(receivedAcrValues).toBe('urn:from-acr-values');
    });

    it('should ignore unknown id_token claim members without throwing', async () => {
      let receivedAcrValues: string | undefined;
      const resolved = await resolveAcrAmr({
        subject: 'user-123',
        clientId: 'client-456',
        claims: {
          id_token: { custom_unknown_claim: { essential: true } },
        },
        acrResolver: async (ctx) => {
          receivedAcrValues = ctx.requestedAcrValues;
          return { acr: 'urn:resolved', amr: ['pwd'] };
        },
      });
      expect(receivedAcrValues).toBeUndefined();
      expect(resolved).toEqual({ acr: 'urn:resolved', amr: ['pwd'] });
    });
  });
});

// Direct unit tests for the aud/azp policy helper (OIDC Core 1.0 §2 / §3.1.3.7 (4-5)).
describe('buildIdTokenAudience', () => {
  it('should return aud as a single string and no azp for the client alone', () => {
    expect(buildIdTokenAudience({ clientId: 'c1' })).toEqual({ aud: 'c1' });
  });

  it('should return aud as an array with azp = clientId for multiple audiences', () => {
    expect(
      buildIdTokenAudience({ clientId: 'c1', additional: ['https://api.example/rp'] }),
    ).toEqual({ aud: ['c1', 'https://api.example/rp'], azp: 'c1' });
  });

  it('should place clientId first and dedupe repeated audiences preserving order', () => {
    expect(
      buildIdTokenAudience({ clientId: 'c1', additional: ['a', 'c1', 'a', 'b'] }),
    ).toEqual({ aud: ['c1', 'a', 'b'], azp: 'c1' });
  });

  it('should treat additional audiences equal to clientId only as a single audience', () => {
    expect(buildIdTokenAudience({ clientId: 'c1', additional: ['c1'] })).toEqual({ aud: 'c1' });
  });
});

describe('buildIdTokenPayload', () => {
  // OIDC Core 1.0 Section 2: iss / sub / aud / exp / iat are REQUIRED.
  describe('Required Claims', () => {
    it('should have iss claim matching issuer', () => {
      const payload = buildIdTokenPayload(idTokenInput({ issuer: 'https://op.example.com' }));
      expect(payload.iss).toBe('https://op.example.com');
    });

    it('should have sub claim matching subject', () => {
      const payload = buildIdTokenPayload(idTokenInput({ subject: 'user-def' }));
      expect(payload.sub).toBe('user-def');
    });

    it('should have aud claim matching clientId', () => {
      const payload = buildIdTokenPayload(idTokenInput({ clientId: 'client-aud' }));
      expect(payload.aud).toBe('client-aud');
    });

    it('should set exp claim to issuedAt plus expiresIn', () => {
      const payload = buildIdTokenPayload(idTokenInput({ issuedAt: NOW, expiresIn: 1800 }));
      expect(payload.exp).toBe(NOW + 1800);
    });

    it('should set iat claim to the current time when issuedAt is omitted', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000 + 999);
      const payload = buildIdTokenPayload(idTokenInput({ issuedAt: undefined }));
      // RFC 7519 §2: NumericDate は秒単位のため、ミリ秒は切り捨てる。
      expect(payload.iat).toBe(NOW);
    });
  });

  describe('Conditional Claims', () => {
    it('should include nonce when provided', () => {
      const payload = buildIdTokenPayload(idTokenInput({ nonce: 'test-nonce-123' }));
      expect(payload.nonce).toBe('test-nonce-123');
    });

    it('should not include nonce when not provided', () => {
      const payload = buildIdTokenPayload(idTokenInput());
      expect(Object.prototype.hasOwnProperty.call(payload, 'nonce')).toBe(false);
    });

    // OIDC Core 1.0 Section 3.1.3.6: at_hash
    it('should include at_hash claim when atHash is provided', () => {
      const payload = buildIdTokenPayload(idTokenInput({ atHash: '77QmUPtjPfzWtF2AnpK9RQ' }));
      expect(payload.at_hash).toBe('77QmUPtjPfzWtF2AnpK9RQ');
    });

    it('should include auth_time when provided', () => {
      const payload = buildIdTokenPayload(idTokenInput({ authTime: NOW - 300 }));
      expect(payload.auth_time).toBe(NOW - 300);
    });
  });

  // OIDC Core 1.0 §2 / §3.1.3.7 (4-5): the ID Token aud is a single string (clientId) when
  // the client is the sole audience, with azp omitted. When additional audiences are supplied
  // aud becomes an array and azp = clientId is REQUIRED. These freeze both shapes so a change
  // cannot silently drop the required azp or wrongly widen aud.
  describe('ID Token aud/azp shape', () => {
    it('should issue aud as a single string equal to clientId by default', () => {
      const payload = buildIdTokenPayload(idTokenInput({ clientId: 'client-single-aud' }));
      expect(payload.aud).toBe('client-single-aud');
    });

    it('should not issue aud as an array when no additional audiences are given', () => {
      const payload = buildIdTokenPayload(idTokenInput());
      expect(Array.isArray(payload.aud)).toBe(false);
    });

    it('should not include an azp claim for a single audience', () => {
      const payload = buildIdTokenPayload(idTokenInput());
      expect(Object.prototype.hasOwnProperty.call(payload, 'azp')).toBe(false);
    });

    it('should issue aud as an array [clientId, ...additional] when idTokenAudiences is given', () => {
      const payload = buildIdTokenPayload(
        idTokenInput({
          clientId: 'client-primary',
          idTokenAudiences: ['https://other.example/rp', 'https://third.example/rp'],
        }),
      );
      expect(payload.aud).toEqual([
        'client-primary',
        'https://other.example/rp',
        'https://third.example/rp',
      ]);
    });

    it('should set azp to clientId when aud contains multiple values', () => {
      const payload = buildIdTokenPayload(
        idTokenInput({
          clientId: 'client-primary',
          idTokenAudiences: ['https://other.example/rp'],
        }),
      );
      expect(payload.azp).toBe('client-primary');
    });

    it('should keep aud a single string and omit azp when additional audiences dedupe to clientId only', () => {
      const payload = buildIdTokenPayload(
        idTokenInput({
          clientId: 'client-primary',
          idTokenAudiences: ['client-primary'],
        }),
      );
      expect(payload.aud).toBe('client-primary');
      expect(Object.prototype.hasOwnProperty.call(payload, 'azp')).toBe(false);
    });
  });

  // OIDC Core 1.0 §12 / §5.4: refresh で発行される ID Token のクレームセットは
  // 削減後の scope に従う。userClaims を渡した場合、payload は scope に応じて
  // フィルタされたクレームを含む。
  describe('ID Token claims filtered by scope (T-020)', () => {
    const userClaims: UserClaims = {
      sub: 'user-claims',
      name: 'Alice',
      family_name: 'Doe',
      email: 'alice@example.com',
      email_verified: true,
      phone_number: '+81-90-0000-0000',
    };

    it('should omit profile claims when scope is reduced to openid email', () => {
      const payload = buildIdTokenPayload(idTokenInput({ scope: ['openid', 'email'], userClaims }));
      expect(payload).toStrictEqual({
        iss: 'https://op.example.com',
        sub: 'user-123',
        aud: 'client-456',
        exp: NOW + 3600,
        iat: NOW,
        email: 'alice@example.com',
        email_verified: true,
      });
    });

    it('should include all matching claims when scope is openid profile email', () => {
      const payload = buildIdTokenPayload(
        idTokenInput({ scope: ['openid', 'profile', 'email'], userClaims }),
      );
      expect(payload).toStrictEqual({
        iss: 'https://op.example.com',
        sub: 'user-123',
        aud: 'client-456',
        exp: NOW + 3600,
        iat: NOW,
        name: 'Alice',
        family_name: 'Doe',
        email: 'alice@example.com',
        email_verified: true,
      });
    });

    it('should always include required claims (sub/iss/aud/exp/iat) regardless of scope reduction', () => {
      const payload = buildIdTokenPayload(idTokenInput({ scope: ['openid'], userClaims }));
      // openid scope alone should not pull in profile/email/phone claims.
      expect(payload).toStrictEqual({
        iss: 'https://op.example.com',
        sub: 'user-123',
        aud: 'client-456',
        exp: NOW + 3600,
        iat: NOW,
      });
    });

    it('should include no user claims when userClaims is not provided', () => {
      const payload = buildIdTokenPayload(idTokenInput({ scope: ['openid', 'profile'] }));
      expect(payload).toStrictEqual({
        iss: 'https://op.example.com',
        sub: 'user-123',
        aud: 'client-456',
        exp: NOW + 3600,
        iat: NOW,
      });
    });

    it('should not let user claims override required ID Token claims', () => {
      const payload = buildIdTokenPayload(
        idTokenInput({
          subject: 'user-required',
          scope: ['openid', 'profile'],
          userClaims: { sub: 'spoofed-sub', name: 'Alice' },
        }),
      );
      expect(payload).toStrictEqual({
        iss: 'https://op.example.com',
        sub: 'user-required',
        aud: 'client-456',
        exp: NOW + 3600,
        iat: NOW,
        name: 'Alice',
      });
    });
  });
});

describe('generateIdToken', () => {
  it('should be a valid JWT with three parts', async () => {
    const idToken = await generateIdToken({
      payload: buildIdTokenPayload(idTokenInput({ issuedAt: currentTime() })),
      privateKey: rsaKeyPair.privateKey,
    });
    expect(idToken.split('.')).toHaveLength(3);
  });

  // buildIdTokenPayload が組み立てたクレーム（OIDC Core 1.0 Section 2）は、
  // 署名後の ID Token にそのまま載る。
  it('should embed the built payload unchanged', async () => {
    const payload = buildIdTokenPayload(
      idTokenInput({
        issuedAt: currentTime(),
        atHash: '77QmUPtjPfzWtF2AnpK9RQ',
        nonce: 'test-nonce-123',
        authTime: currentTime() - 300,
      }),
    );
    const idToken = await generateIdToken({ payload, privateKey: rsaKeyPair.privateKey });
    expect(decodeJwt(idToken).payload).toEqual(payload);
  });

  it('should include kid in the JOSE header when keyId is provided', async () => {
    const idToken = await generateIdToken({
      payload: buildIdTokenPayload(idTokenInput({ issuedAt: currentTime() })),
      privateKey: rsaKeyPair.privateKey,
      keyId: 'id-key-1',
    });
    expect(decodeJwt(idToken).header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'id-key-1' });
  });

  // OIDC Core 1.0 allows id_token_signed_response_alg to be configured per client,
  // so the ID token MAY be signed with a different key than the access token.
  it('should sign with the given privateKey so that only its public key verifies the signature', async () => {
    const idToken = await generateIdToken({
      payload: buildIdTokenPayload(idTokenInput({ issuedAt: currentTime() })),
      privateKey: secondaryKeyPair.privateKey,
    });
    expect(await verifyRs256Signature(idToken, secondaryKeyPair.publicKey)).toBe(true);
    expect(await verifyRs256Signature(idToken, rsaKeyPair.publicKey)).toBe(false);
  });
});
