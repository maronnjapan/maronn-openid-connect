/**
 * JWT の組み立てと署名の部品関数のテスト。
 */
import { describe, expect, it } from 'vitest';
import { buildJoseHeader, encodeJwtSigningInput } from './jwt.js';

describe('buildJoseHeader', () => {
  it('should include kid when a key id is given', () => {
    expect(buildJoseHeader('RS256', 'at+jwt', 'key-1')).toEqual({
      alg: 'RS256',
      typ: 'at+jwt',
      kid: 'key-1',
    });
  });

  it('should omit kid when no key id is given', () => {
    expect(buildJoseHeader('ES256', 'JWT')).toEqual({ alg: 'ES256', typ: 'JWT' });
  });
});

describe('encodeJwtSigningInput', () => {
  // RFC 7515 §5.1: BASE64URL(header) || '.' || BASE64URL(payload)
  it('should join the base64url-encoded header and payload', () => {
    expect(encodeJwtSigningInput({ alg: 'RS256' }, { sub: 'alice' })).toBe(
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9',
    );
  });
});
