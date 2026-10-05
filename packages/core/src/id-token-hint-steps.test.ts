/**
 * id_token_hint 検証の部品関数のテスト。
 *
 * validateIdTokenHint は以下の部品関数をこの順に呼ぶ。合成した振る舞いは
 * id-token.test.ts が担保し、本ファイルは各部品関数をリテラルの引数で検証する。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decodeIdTokenHint,
  validateIdTokenHintHeader,
  selectIdTokenHintKeys,
  verifyIdTokenHintSignature,
  validateIdTokenHintIssuer,
  validateIdTokenHintAudience,
  validateIdTokenHintExpiration,
  validateIdTokenHintIssuedAt,
  requireIdTokenHintSubject,
} from './id-token.js';
import { encodeJwtSigningInput, signJwt } from './jwt.js';
import type { Jwk } from './jwks.js';

describe('decodeIdTokenHint', () => {
  it('should return the unverified header, payload and signing input', () => {
    expect(decodeIdTokenHint('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.sig')).toEqual({
      header: { alg: 'RS256' },
      payload: { sub: 'alice' },
      signingInput: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9',
      signature: 'sig',
    });
  });

  it('should reject a value without three segments', () => {
    expect(() => decodeIdTokenHint('a.b')).toThrow(
      'id_token_hint is not a valid JWS compact serialization',
    );
  });

  it('should reject segments that are not base64url JSON', () => {
    expect(() => decodeIdTokenHint('!.!.!')).toThrow(
      'id_token_hint header or payload is not valid base64url JSON',
    );
  });
});

describe('validateIdTokenHintHeader', () => {
  it('should return the algorithm and key id', () => {
    expect(validateIdTokenHintHeader({ alg: 'RS256', kid: 'key-1' })).toEqual({
      algorithm: 'RS256',
      keyId: 'key-1',
    });
  });

  it('should reject alg none', () => {
    expect(() => validateIdTokenHintHeader({ alg: 'none' })).toThrow(
      'id_token_hint alg is missing or "none"',
    );
  });

  // RFC 8725 §3.1: headers that fetch keys from outside are rejected
  it('should reject a jku header', () => {
    expect(() =>
      validateIdTokenHintHeader({ alg: 'RS256', jku: 'https://untrusted.example/keys' }),
    ).toThrow('id_token_hint JOSE header contains unsupported field: jku');
  });
});

describe('selectIdTokenHintKeys', () => {
  it('should select keys by kid when the header has one', () => {
    expect(
      selectIdTokenHintKeys(
        [
          { alg: 'RS256', kid: 'key-1' },
          { alg: 'ES256', kid: 'key-2' },
        ],
        'RS256',
        'key-2',
      ),
    ).toEqual([{ alg: 'ES256', kid: 'key-2' }]);
  });

  it('should select keys by alg when the header has no kid', () => {
    expect(
      selectIdTokenHintKeys(
        [
          { alg: 'RS256', kid: 'key-1' },
          { alg: 'ES256', kid: 'key-2' },
        ],
        'RS256',
      ),
    ).toEqual([{ alg: 'RS256', kid: 'key-1' }]);
  });

  it('should reject when no key matches', () => {
    expect(() =>
      selectIdTokenHintKeys([{ alg: 'RS256', kid: 'key-1' }], 'RS256', 'missing'),
    ).toThrow('No JWK matched the id_token_hint header');
  });
});

describe('verifyIdTokenHintSignature', () => {
  let publicJwk: Jwk;
  let signingInput: string;
  let signature: string;

  beforeAll(async () => {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    publicJwk = {
      ...((await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as Jwk),
      alg: 'RS256',
      kid: 'key-1',
    };
    const token = await signJwt({ alg: 'RS256', kid: 'key-1' }, { sub: 'alice' }, keyPair.privateKey);
    const segments = token.split('.');
    signingInput = `${segments[0]}.${segments[1]}`;
    signature = segments[2] as string;
  });

  it('should accept a signature made by the candidate key', async () => {
    await expect(
      verifyIdTokenHintSignature(signingInput, signature, [publicJwk], 'RS256'),
    ).resolves.toBeUndefined();
  });

  it('should reject a signature over different bytes', async () => {
    await expect(
      verifyIdTokenHintSignature(
        encodeJwtSigningInput({ alg: 'RS256', kid: 'key-1' }, { sub: 'mallory' }),
        signature,
        [publicJwk],
        'RS256',
      ),
    ).rejects.toThrow('id_token_hint signature verification failed');
  });

  // RFC 7515 §4.1.1: the key's alg pins the algorithm
  it('should reject a key registered for another algorithm', async () => {
    await expect(
      verifyIdTokenHintSignature(signingInput, signature, [publicJwk], 'RS384'),
    ).rejects.toThrow('id_token_hint signature verification failed');
  });
});

describe('validateIdTokenHintIssuer', () => {
  it('should accept the expected issuer', () => {
    expect(validateIdTokenHintIssuer('https://op.example', 'https://op.example')).toBeUndefined();
  });

  it('should reject another issuer', () => {
    expect(() =>
      validateIdTokenHintIssuer('https://other.example', 'https://op.example'),
    ).toThrow('id_token_hint iss does not match expected issuer');
  });
});

describe('validateIdTokenHintAudience', () => {
  it('should accept a matching string audience', () => {
    expect(validateIdTokenHintAudience('client-1', 'client-1')).toBeUndefined();
  });

  // OIDC Core 1.0 §2: aud may be an array
  it('should accept an array containing the audience', () => {
    expect(validateIdTokenHintAudience(['client-1', 'client-2'], 'client-1')).toBeUndefined();
  });

  it('should reject a missing audience', () => {
    expect(() => validateIdTokenHintAudience(undefined, 'client-1')).toThrow(
      'id_token_hint aud does not match expected audience',
    );
  });
});

describe('validateIdTokenHintExpiration', () => {
  it('should accept exp plus leeway equal to now', () => {
    expect(validateIdTokenHintExpiration(1_700_000_000, 1_700_000_060, 60)).toBeUndefined();
  });

  it('should reject exp plus leeway before now', () => {
    expect(() => validateIdTokenHintExpiration(1_700_000_000, 1_700_000_061, 60)).toThrow(
      'id_token_hint has expired',
    );
  });

  it('should reject a non-numeric exp', () => {
    expect(() => validateIdTokenHintExpiration('1700000000', 1_700_000_000, 60)).toThrow(
      'id_token_hint is missing exp claim',
    );
  });
});

describe('validateIdTokenHintIssuedAt', () => {
  it('should accept iat equal to now plus leeway', () => {
    expect(validateIdTokenHintIssuedAt(1_700_000_060, 1_700_000_000, 60)).toBeUndefined();
  });

  // RFC 8725 §3.8: iat implausibly far in the future is rejected
  it('should reject iat after now plus leeway', () => {
    expect(() => validateIdTokenHintIssuedAt(1_700_000_061, 1_700_000_000, 60)).toThrow(
      'id_token_hint iat is in the future',
    );
  });

  it('should reject a missing iat', () => {
    expect(() => validateIdTokenHintIssuedAt(undefined, 1_700_000_000, 60)).toThrow(
      'id_token_hint is missing iat claim',
    );
  });
});

describe('requireIdTokenHintSubject', () => {
  it('should return a non-empty subject', () => {
    expect(requireIdTokenHintSubject('alice')).toBe('alice');
  });

  it('should reject an empty subject', () => {
    expect(() => requireIdTokenHintSubject('')).toThrow('id_token_hint is missing sub claim');
  });

  it('should reject a non-string subject', () => {
    expect(() => requireIdTokenHintSubject(123)).toThrow('id_token_hint is missing sub claim');
  });
});
