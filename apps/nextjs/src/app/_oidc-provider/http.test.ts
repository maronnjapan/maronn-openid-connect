import { describe, expect, it } from 'vitest';
import { readBearerToken } from './http';

describe('readBearerToken', () => {
  // RFC 6750 §2.1
  it('should read the token of the Bearer scheme', () => {
    expect(readBearerToken('Bearer token-1')).toBe('token-1');
  });

  // RFC 7235 §2.1: the authentication scheme is case-insensitive; the token is kept verbatim.
  it('should match the scheme case-insensitively and keep the token as it is', () => {
    expect(readBearerToken('bEaReR Token-ABC')).toBe('Token-ABC');
  });

  // RFC 6750 §2.1: credentials = "Bearer" 1*SP b64token — one or more spaces follow the scheme.
  it('should read the token after several spaces following the scheme', () => {
    expect(readBearerToken('Bearer   token-1')).toBe('token-1');
  });

  it('should read no token from another scheme, a scheme without a token, or an empty header', () => {
    expect(['Basic dXNlcjpwYXNz', 'Bearer', 'Bearertoken-1', ''].map(readBearerToken)).toEqual(['', '', '', '']);
  });
});
