import { beforeAll, describe, expect, it } from 'vitest';

import { GoogleLoginErrorCode } from './errors.js';
import {
  decodeBase64UrlJsonObject,
  decodeBase64UrlStrict,
  parseCompactJws,
  timingSafeEqual,
  verifyRs256Signature,
} from './jws.js';
import {
  base64UrlEncodeJson,
  captureThrow,
  expectGoogleLoginError,
  generateGoogleTestKey,
  signGoogleIdToken,
  type GoogleTestKey,
} from './test-helpers.js';

describe('decodeBase64UrlStrict', () => {
  it('should decode a canonical base64url string', () => {
    expect(new TextDecoder().decode(decodeBase64UrlStrict('aGVsbG8'))).toBe('hello');
  });

  it('should decode the URL-safe alphabet', () => {
    // 0xfb 0xff → "-_8" in base64url ("+/8" in standard base64)
    expect(Array.from(decodeBase64UrlStrict('-_8'))).toEqual([0xfb, 0xff]);
  });

  it('should decode an empty string to an empty byte array', () => {
    expect(Array.from(decodeBase64UrlStrict(''))).toEqual([]);
  });

  // RFC 8725 §3.11: 非正規な base64url（標準 base64 の文字・パディング・空白）は拒否する
  it('should reject standard base64 characters', () => {
    expect(() => decodeBase64UrlStrict('aGVs+G8/')).toThrow(
      'Invalid base64url: contains characters outside the base64url alphabet',
    );
  });

  it('should reject padding', () => {
    expect(() => decodeBase64UrlStrict('aGVsbG8=')).toThrow(
      'Invalid base64url: contains characters outside the base64url alphabet',
    );
  });

  it('should reject whitespace', () => {
    expect(() => decodeBase64UrlStrict('aGVs bG8')).toThrow(
      'Invalid base64url: contains characters outside the base64url alphabet',
    );
  });

  it('should reject a length that base64 cannot produce', () => {
    expect(() => decodeBase64UrlStrict('aGVsb')).toThrow('Invalid base64url: malformed length');
  });
});

describe('decodeBase64UrlJsonObject', () => {
  it('should decode a JSON object', () => {
    expect(decodeBase64UrlJsonObject(base64UrlEncodeJson({ alg: 'RS256', kid: 'k1' }))).toEqual({
      alg: 'RS256',
      kid: 'k1',
    });
  });

  it('should reject a JSON array', () => {
    expect(() => decodeBase64UrlJsonObject(base64UrlEncodeJson([1, 2]))).toThrow(
      'Decoded JSON is not an object',
    );
  });

  it('should reject JSON null', () => {
    expect(() => decodeBase64UrlJsonObject(base64UrlEncodeJson(null))).toThrow(
      'Decoded JSON is not an object',
    );
  });

  it('should reject invalid JSON', () => {
    expect(() => decodeBase64UrlJsonObject('bm90LWpzb24')).toThrow();
  });
});

describe('parseCompactJws', () => {
  let key: GoogleTestKey;

  beforeAll(async () => {
    key = await generateGoogleTestKey();
  });

  it('should split the token into header, payload, signing input and signature', async () => {
    const token = await signGoogleIdToken({ key, payload: { sub: 'user' } });
    const [headerSegment, payloadSegment] = token.split('.');

    const jws = parseCompactJws(token);

    expect(jws.header).toEqual({ alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' });
    expect(jws.payload).toEqual({ sub: 'user' });
    expect(jws.signingInput).toBe(`${headerSegment}.${payloadSegment}`);
    expect(jws.signature.byteLength).toBe(256);
  });

  it('should reject a token with two segments', () => {
    const error = captureThrow(() => parseCompactJws('a.b'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.MalformedIdToken, 401);
  });

  it('should reject a token with four segments', () => {
    const error = captureThrow(() => parseCompactJws('a.b.c.d'));

    expectGoogleLoginError(error, GoogleLoginErrorCode.MalformedIdToken, 401);
  });

  it('should reject a header that is not a JSON object', () => {
    const token = `${base64UrlEncodeJson('text')}.${base64UrlEncodeJson({})}.c2ln`;

    const error = captureThrow(() => parseCompactJws(token));

    expectGoogleLoginError(error, GoogleLoginErrorCode.MalformedIdToken, 401);
  });

  it('should reject a signature segment that is not base64url', () => {
    const token = `${base64UrlEncodeJson({ alg: 'RS256' })}.${base64UrlEncodeJson({})}.sig=`;

    const error = captureThrow(() => parseCompactJws(token));

    expectGoogleLoginError(error, GoogleLoginErrorCode.MalformedIdToken, 401);
  });
});

describe('verifyRs256Signature', () => {
  let key: GoogleTestKey;
  let otherKey: GoogleTestKey;

  beforeAll(async () => {
    key = await generateGoogleTestKey('k1');
    otherKey = await generateGoogleTestKey('k2');
  });

  function rsaJwk(testKey: GoogleTestKey): { kty: string; n: string; e: string } {
    return { kty: testKey.jwk.kty, n: testKey.jwk.n!, e: testKey.jwk.e! };
  }

  it('should return true for a signature made with the matching private key', async () => {
    const token = await signGoogleIdToken({ key, payload: { sub: 'user' } });
    const jws = parseCompactJws(token);

    expect(await verifyRs256Signature(jws.signingInput, jws.signature, rsaJwk(key))).toBe(true);
  });

  it('should return false when the signing input was altered', async () => {
    const token = await signGoogleIdToken({ key, payload: { sub: 'user' } });
    const jws = parseCompactJws(token);
    const altered = `${jws.signingInput.split('.')[0]}.${base64UrlEncodeJson({ sub: 'attacker' })}`;

    expect(await verifyRs256Signature(altered, jws.signature, rsaJwk(key))).toBe(false);
  });

  it('should return false for a different public key', async () => {
    const token = await signGoogleIdToken({ key, payload: { sub: 'user' } });
    const jws = parseCompactJws(token);

    expect(await verifyRs256Signature(jws.signingInput, jws.signature, rsaJwk(otherKey))).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('should return true for equal strings', async () => {
    expect(await timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('should return false for strings that differ in one character', async () => {
    expect(await timingSafeEqual('abc123', 'abc124')).toBe(false);
  });

  it('should return false for strings of different length', async () => {
    expect(await timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
