import { describe, expect, it } from 'vitest';
import { readBearerToken } from './bearer-token.js';

describe('readBearerToken', () => {
  // RFC 6750 §2.1: credentials = "Bearer" 1*SP b64token.
  it('should return the token of a Bearer header', () => {
    expect(readBearerToken('Bearer abc.DEF-ghi_jkl~mno+pqr/stu')).toBe('abc.DEF-ghi_jkl~mno+pqr/stu');
  });

  it('should keep the trailing padding of the token', () => {
    expect(readBearerToken('Bearer dG9rZW4==')).toBe('dG9rZW4==');
  });

  // RFC 9110 §11.1: the scheme name is case-insensitive.
  it('should accept the scheme name in any case', () => {
    expect(readBearerToken('bearer token-1')).toBe('token-1');
    expect(readBearerToken('BEARER token-1')).toBe('token-1');
  });

  it('should accept more than one space between the scheme and the token', () => {
    expect(readBearerToken('Bearer    token-1')).toBe('token-1');
  });

  it('should return undefined for a missing header', () => {
    expect(readBearerToken(undefined)).toBeUndefined();
    expect(readBearerToken(null)).toBeUndefined();
  });

  it('should return undefined for another authentication scheme', () => {
    expect(readBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
  });

  it('should return undefined for a Bearer header without a token', () => {
    expect(readBearerToken('Bearer')).toBeUndefined();
    expect(readBearerToken('Bearer ')).toBeUndefined();
  });

  it('should return undefined for a token outside the b64token syntax', () => {
    expect(readBearerToken('Bearer two tokens')).toBeUndefined();
    expect(readBearerToken('Bearer token!')).toBeUndefined();
    expect(readBearerToken('Bearer =token')).toBeUndefined();
  });
});
