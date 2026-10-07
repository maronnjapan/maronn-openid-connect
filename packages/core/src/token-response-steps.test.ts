/**
 * トークンレスポンス生成の機能単位ステップ関数と部品関数のテスト。
 *
 * CLI 生成コードはこれらのステップを個別に呼び出して、利用者が ID Token の
 * クレームを足したり発行処理を差し替えたりできるようにする。ステップごとの
 * 網羅的な振る舞いは token-response.test.ts が担保し、本ファイルは
 * 部品関数をリテラルの引数で検証するほか、ステップ関数の入出力契約のうち
 * token-response.test.ts と重複しないもの（payload 全体、仕様例の at_hash など）を固定する。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildAccessTokenPayload,
  buildIdTokenPayload,
  computeAtHash,
  resolveAcrAmr,
  selectRequestedAcrValues,
} from './token-response.js';
import type { AcrResolver } from './token-response.js';

const NOW = 1_700_000_000;

let rsaKeyPair: CryptoKeyPair;

beforeAll(async () => {
  rsaKeyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
});

describe('buildAccessTokenPayload', () => {
  it('should build the RFC 9068 access token payload', () => {
    const result = buildAccessTokenPayload({
      issuer: 'https://op.example.com',
      subject: 'user-1',
      clientId: 'client-1',
      scope: ['openid', 'profile'],
      audience: ['https://op.example.com/userinfo'],
      expiresIn: 3600,
      issuedAt: NOW,
      jti: 'fixed-jti-for-assertion',
    });

    expect(result).toEqual({
      iss: 'https://op.example.com',
      sub: 'user-1',
      aud: ['https://op.example.com/userinfo'],
      exp: NOW + 3600,
      iat: NOW,
      jti: 'fixed-jti-for-assertion',
      scope: 'openid profile',
      client_id: 'client-1',
    });
  });

  // RFC 9068 §2.2: jti is REQUIRED for JWT access tokens.
  // RFC 7519 §4.1.7: the value MUST be assigned so that the probability of the
  // same value being assigned to a different token is negligible.
  // RFC 8017 §8.2: RSASSA-PKCS1-v1_5 (RS256) is deterministic, so without jti a
  // payload rebuilt from identical input in the same wall-clock second signs to
  // a byte-identical token, which silently collides in a token-keyed store.
  describe('jti claim (RFC 9068 §2.2 / RFC 7519 §4.1.7)', () => {
    function buildFixedInput() {
      return {
        issuer: 'https://op.example.com',
        subject: 'user-1',
        clientId: 'client-1',
        scope: ['openid'],
        audience: ['https://op.example.com/userinfo'],
        expiresIn: 3600,
        issuedAt: NOW,
      };
    }

    it('should generate a different jti on every call for identical input', () => {
      const first = buildAccessTokenPayload(buildFixedInput());
      const second = buildAccessTokenPayload(buildFixedInput());

      expect(first.jti === second.jti).toBe(false);
    });
  });
});

describe('computeAtHash', () => {
  it('should compute the base64url left half of the SHA-256 digest for an RS256 key', async () => {
    const result = await computeAtHash(
      'jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y',
      rsaKeyPair.privateKey,
    );

    // OIDC Core 1.0 Section 3.1.3.6 / Appendix A.3 example value for the RS256
    // access token above (SHA-256 digest, left 128 bits, base64url).
    expect(result).toBe('77QmUPtjPfzWtF2AnpK9RQ');
  });
});

describe('resolveAcrAmr', () => {
  it('should seed the resolver with claims.id_token.acr.values when acr_values is absent', async () => {
    const seen: (string | undefined)[] = [];
    const acrResolver: AcrResolver = async ({ requestedAcrValues }) => {
      seen.push(requestedAcrValues);
      return undefined;
    };

    await resolveAcrAmr({
      subject: 'user-1',
      clientId: 'client-1',
      claims: { id_token: { acr: { values: ['urn:example:loa:2', 'urn:example:loa:3'] } } },
      acrResolver,
    });

    expect(seen).toEqual(['urn:example:loa:2 urn:example:loa:3']);
  });
});

describe('buildIdTokenPayload', () => {
  it('should build the required OIDC Core 1.0 claims', () => {
    const result = buildIdTokenPayload({
      issuer: 'https://op.example.com',
      subject: 'user-1',
      clientId: 'client-1',
      scope: ['openid'],
      expiresIn: 3600,
      issuedAt: NOW,
      atHash: 'at-hash-value',
    });

    expect(result).toEqual({
      iss: 'https://op.example.com',
      sub: 'user-1',
      aud: 'client-1',
      exp: NOW + 3600,
      iat: NOW,
      at_hash: 'at-hash-value',
    });
  });

  it('should include nonce, auth_time, acr and amr when supplied', () => {
    const result = buildIdTokenPayload({
      issuer: 'https://op.example.com',
      subject: 'user-1',
      clientId: 'client-1',
      scope: ['openid'],
      expiresIn: 3600,
      issuedAt: NOW,
      atHash: 'at-hash-value',
      nonce: 'nonce-1',
      authTime: NOW - 60,
      acr: 'urn:example:loa:2',
      amr: ['pwd'],
    });

    expect(result).toEqual({
      iss: 'https://op.example.com',
      sub: 'user-1',
      aud: 'client-1',
      exp: NOW + 3600,
      iat: NOW,
      at_hash: 'at-hash-value',
      nonce: 'nonce-1',
      auth_time: NOW - 60,
      acr: 'urn:example:loa:2',
      amr: ['pwd'],
    });
  });

  it('should emit an aud array with azp when additional audiences are supplied', () => {
    const result = buildIdTokenPayload({
      issuer: 'https://op.example.com',
      subject: 'user-1',
      clientId: 'client-1',
      scope: ['openid'],
      expiresIn: 3600,
      issuedAt: NOW,
      atHash: 'at-hash-value',
      idTokenAudiences: ['https://api.example.org'],
    });

    expect(result).toMatchObject({
      aud: ['client-1', 'https://api.example.org'],
      azp: 'client-1',
    });
  });

  it('should include scope-allowed user claims', () => {
    const result = buildIdTokenPayload({
      issuer: 'https://op.example.com',
      subject: 'user-1',
      clientId: 'client-1',
      scope: ['openid', 'email'],
      expiresIn: 3600,
      issuedAt: NOW,
      atHash: 'at-hash-value',
      userClaims: { sub: 'user-1', email: 'user@example.com', name: 'Taro' },
    });

    expect(result).toEqual({
      iss: 'https://op.example.com',
      sub: 'user-1',
      aud: 'client-1',
      exp: NOW + 3600,
      iat: NOW,
      at_hash: 'at-hash-value',
      email: 'user@example.com',
    });
  });
});

describe('selectRequestedAcrValues', () => {
  it('should prefer the acr_values parameter', () => {
    expect(
      selectRequestedAcrValues('urn:loa:1', { id_token: { acr: { values: ['urn:loa:2'] } } }),
    ).toBe('urn:loa:1');
  });

  // OIDC Core 1.0 §5.5.1.1: claims.id_token.acr.values is equivalent to acr_values
  it('should join claims.id_token.acr.values when acr_values is absent', () => {
    expect(
      selectRequestedAcrValues(undefined, {
        id_token: { acr: { values: ['urn:loa:2', 'urn:loa:3'] } },
      }),
    ).toBe('urn:loa:2 urn:loa:3');
  });

  it('should return undefined when neither is present', () => {
    expect(selectRequestedAcrValues(undefined, undefined)).toBeUndefined();
  });
});
