/**
 * トークンレスポンス生成の機能単位ステップ関数のテスト。
 *
 * generateTokenResponse はこれらのステップ関数の合成であり、CLI 生成コードは
 * 各ステップを個別に呼び出して、利用者が ID Token のクレームを足したり
 * 発行処理を差し替えたりできるようにする。合成後の網羅的な振る舞いは
 * token-response.test.ts が担保し、本ファイルは各ステップ関数の入出力契約を固定する。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildAccessTokenPayload,
  buildIdTokenPayload,
  computeAtHash,
  resolveAcrAmr,
} from './token-response.js';
import { createJwtAccessTokenIssuer } from './access-token-issuer.js';
import { TokenError, TokenErrorCode } from './token-error.js';
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

  it('should fall back to the issuer when no audience is given', () => {
    const result = buildAccessTokenPayload({
      issuer: 'https://op.example.com',
      subject: 'user-1',
      clientId: 'client-1',
      scope: ['openid'],
      expiresIn: 60,
      issuedAt: NOW,
    });

    expect(result.aud).toEqual(['https://op.example.com']);
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

    it('should generate a 128-bit base64url jti by default', () => {
      const result = buildAccessTokenPayload(buildFixedInput());

      // 16 bytes of CSPRNG output, base64url encoded without padding.
      expect(typeof result.jti).toBe('string');
      expect(result.jti).toHaveLength(22);
      expect(result.jti).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should generate a different jti on every call for identical input', () => {
      const first = buildAccessTokenPayload(buildFixedInput());
      const second = buildAccessTokenPayload(buildFixedInput());

      expect(first.jti === second.jti).toBe(false);
    });

    it('should use the caller-supplied jti instead of generating one', () => {
      const result = buildAccessTokenPayload({ ...buildFixedInput(), jti: 'caller-jti' });

      expect(result.jti).toBe('caller-jti');
    });

    it('should produce different JWT access token strings for identical input issued in the same second', async () => {
      // generateAccessToken rejects an exp that is already in the past, so this
      // case pins issuedAt to the current second rather than the fixture NOW.
      const input = { ...buildFixedInput(), issuedAt: Math.floor(Date.now() / 1000) };
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
  it('should return the directly supplied acr and amr without calling the resolver', async () => {
    let resolverCalls = 0;
    const acrResolver: AcrResolver = async () => {
      resolverCalls += 1;
      return { acr: 'from-resolver', amr: ['pwd'] };
    };

    const result = await resolveAcrAmr({
      subject: 'user-1',
      clientId: 'client-1',
      acr: 'urn:example:loa:2',
      amr: ['otp'],
      acrResolver,
    });

    expect(result).toEqual({ acr: 'urn:example:loa:2', amr: ['otp'] });
    expect(resolverCalls).toBe(0);
  });

  it('should call the resolver when neither acr nor amr is supplied', async () => {
    const acrResolver: AcrResolver = async () => ({ acr: 'urn:example:loa:3', amr: ['pwd', 'otp'] });

    const result = await resolveAcrAmr({
      subject: 'user-1',
      clientId: 'client-1',
      acrResolver,
    });

    expect(result).toEqual({ acr: 'urn:example:loa:3', amr: ['pwd', 'otp'] });
  });

  it('should pass the requested acr_values to the resolver', async () => {
    const seen: (string | undefined)[] = [];
    const acrResolver: AcrResolver = async ({ requestedAcrValues }) => {
      seen.push(requestedAcrValues);
      return undefined;
    };

    await resolveAcrAmr({
      subject: 'user-1',
      clientId: 'client-1',
      requestedAcrValues: 'urn:example:loa:2',
      acrResolver,
    });

    expect(seen).toEqual(['urn:example:loa:2']);
  });

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

  it('should return empty values when no resolver is configured', async () => {
    const result = await resolveAcrAmr({ subject: 'user-1', clientId: 'client-1' });

    expect(result).toEqual({ acr: undefined, amr: undefined });
  });

  it('should return empty values when the resolver declines to decide', async () => {
    const acrResolver: AcrResolver = async () => undefined;

    const result = await resolveAcrAmr({ subject: 'user-1', clientId: 'client-1', acrResolver });

    expect(result).toEqual({ acr: undefined, amr: undefined });
  });

  // OIDC Core 1.0 §5.5.1.1 Requesting the "acr" Claim:
  // "If the acr Claim is requested as an Essential Claim ... the Authorization Server
  //  MUST return an acr Claim Value that matches one of the requested values ...
  //  If this is an Essential Claim and the requirement cannot be met, then the
  //  Authorization Server MUST treat that outcome as a failed authentication attempt."
  describe('Essential acr claim request (OIDC Core 1.0 §5.5.1.1)', () => {
    it('should throw when an essential acr request is not satisfied by the resolver', async () => {
      const acrResolver: AcrResolver = async () => ({ acr: 'urn:example:loa:1', amr: ['pwd'] });

      await expect(
        resolveAcrAmr({
          subject: 'user-1',
          clientId: 'client-1',
          claims: { id_token: { acr: { essential: true, values: ['urn:example:loa:3'] } } },
          acrResolver,
        }),
      ).rejects.toThrow(TokenError);
    });

    // RFC 6749 §5.2: the grant cannot satisfy the requested authentication
    // requirement, so the token request fails with invalid_grant.
    it('should throw invalid_grant without reflecting the requested values', async () => {
      const acrResolver: AcrResolver = async () => ({ acr: 'urn:example:loa:1', amr: ['pwd'] });

      const error = await resolveAcrAmr({
        subject: 'user-1',
        clientId: 'client-1',
        claims: { id_token: { acr: { essential: true, values: ['urn:example:loa:3'] } } },
        acrResolver,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TokenError);
      expect(error).toMatchObject({
        error: TokenErrorCode.InvalidGrant,
        errorDescription: 'The essential acr claim request could not be satisfied',
      });
    });

    it('should throw when an essential acr request is made and the resolver returns undefined', async () => {
      const acrResolver: AcrResolver = async () => undefined;

      await expect(
        resolveAcrAmr({
          subject: 'user-1',
          clientId: 'client-1',
          claims: { id_token: { acr: { essential: true, values: ['urn:example:loa:3'] } } },
          acrResolver,
        }),
      ).rejects.toThrow(TokenError);
    });

    // No resolver means the OP has no way to produce any acr, so an essential
    // request can never be met either.
    it('should throw when an essential acr request is made and no resolver is configured', async () => {
      await expect(
        resolveAcrAmr({
          subject: 'user-1',
          clientId: 'client-1',
          claims: { id_token: { acr: { essential: true, values: ['urn:example:loa:3'] } } },
        }),
      ).rejects.toThrow(TokenError);
    });

    it('should return the resolved acr when it matches one of the essential requested values', async () => {
      const acrResolver: AcrResolver = async () => ({ acr: 'urn:example:loa:3', amr: ['pwd', 'otp'] });

      const result = await resolveAcrAmr({
        subject: 'user-1',
        clientId: 'client-1',
        claims: {
          id_token: { acr: { essential: true, values: ['urn:example:loa:2', 'urn:example:loa:3'] } },
        },
        acrResolver,
      });

      expect(result).toEqual({ acr: 'urn:example:loa:3', amr: ['pwd', 'otp'] });
    });

    // §5.5.1.1 allows the request to use the `value` member as well as `values`.
    it('should accept a single value member for an essential acr request', async () => {
      const acrResolver: AcrResolver = async () => ({ acr: 'urn:example:loa:3', amr: ['pwd', 'otp'] });

      const result = await resolveAcrAmr({
        subject: 'user-1',
        clientId: 'client-1',
        claims: { id_token: { acr: { essential: true, value: 'urn:example:loa:3' } } },
        acrResolver,
      });

      expect(result).toEqual({ acr: 'urn:example:loa:3', amr: ['pwd', 'otp'] });
    });

    it('should seed the resolver with the single value member of an essential acr request', async () => {
      const seen: (string | undefined)[] = [];
      const acrResolver: AcrResolver = async ({ requestedAcrValues }) => {
        seen.push(requestedAcrValues);
        return { acr: 'urn:example:loa:3', amr: ['pwd'] };
      };

      await resolveAcrAmr({
        subject: 'user-1',
        clientId: 'client-1',
        claims: { id_token: { acr: { essential: true, value: 'urn:example:loa:3' } } },
        acrResolver,
      });

      expect(seen).toEqual(['urn:example:loa:3']);
    });

    // §5.5.1: "the Authorization Server MUST NOT generate an error when Claims are
    // not returned, whether they are Essential or Voluntary" — the acr exception in
    // §5.5.1.1 applies only to Essential requests, so a Voluntary one stays silent.
    it('should not throw when the acr claim request is voluntary and unmatched', async () => {
      const acrResolver: AcrResolver = async () => ({ acr: 'urn:example:loa:1', amr: ['pwd'] });

      const result = await resolveAcrAmr({
        subject: 'user-1',
        clientId: 'client-1',
        claims: { id_token: { acr: { values: ['urn:example:loa:3'] } } },
        acrResolver,
      });

      expect(result).toEqual({ acr: 'urn:example:loa:1', amr: ['pwd'] });
    });

    it('should not throw when the acr claim request sets essential to false and is unmatched', async () => {
      const acrResolver: AcrResolver = async () => ({ acr: 'urn:example:loa:1', amr: ['pwd'] });

      const result = await resolveAcrAmr({
        subject: 'user-1',
        clientId: 'client-1',
        claims: { id_token: { acr: { essential: false, values: ['urn:example:loa:3'] } } },
        acrResolver,
      });

      expect(result).toEqual({ acr: 'urn:example:loa:1', amr: ['pwd'] });
    });

    // OIDC Core 1.0 §3.1.2.1 Note: acr_values requests the acr Claim as a Voluntary
    // Claim, so it never triggers the §5.5.1.1 failed-authentication requirement.
    it('should not throw when acr is requested only through the acr_values parameter', async () => {
      const acrResolver: AcrResolver = async () => ({ acr: 'urn:example:loa:1', amr: ['pwd'] });

      const result = await resolveAcrAmr({
        subject: 'user-1',
        clientId: 'client-1',
        requestedAcrValues: 'urn:example:loa:3',
        acrResolver,
      });

      expect(result).toEqual({ acr: 'urn:example:loa:1', amr: ['pwd'] });
    });

    // OIDC Core 1.0 §12.1: the refresh_token grant replays the stored acr / amr.
    // claims is not propagated to that path today, and the directly supplied values
    // must pass through untouched even if a caller does forward it.
    it('should skip the essential acr check when acr is directly provided', async () => {
      const result = await resolveAcrAmr({
        subject: 'user-1',
        clientId: 'client-1',
        acr: 'urn:example:loa:1',
        amr: ['pwd'],
        claims: { id_token: { acr: { essential: true, values: ['urn:example:loa:3'] } } },
      });

      expect(result).toEqual({ acr: 'urn:example:loa:1', amr: ['pwd'] });
    });

    // An essential entry with neither value nor values constrains nothing, so the
    // §5.5.1 general rule applies again.
    it('should not throw when an essential acr request carries no requested values', async () => {
      const acrResolver: AcrResolver = async () => undefined;

      const result = await resolveAcrAmr({
        subject: 'user-1',
        clientId: 'client-1',
        claims: { id_token: { acr: { essential: true } } },
        acrResolver,
      });

      expect(result).toEqual({ acr: undefined, amr: undefined });
    });
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

  it('should not let user claims override the required sub claim', () => {
    const result = buildIdTokenPayload({
      issuer: 'https://op.example.com',
      subject: 'user-1',
      clientId: 'client-1',
      scope: ['openid', 'profile'],
      expiresIn: 3600,
      issuedAt: NOW,
      atHash: 'at-hash-value',
      userClaims: { sub: 'attacker' },
    });

    expect(result.sub).toBe('user-1');
  });
});
