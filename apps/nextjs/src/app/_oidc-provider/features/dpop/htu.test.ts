import { describe, expect, it } from 'vitest';

import { normalizeDpopHtu } from './htu';

describe('normalizeDpopHtu', () => {
  // RFC 9449 §4.3: syntax-based and scheme-based normalization (RFC 3986 §6.2.2 / §6.2.3).
  it.each([
    ['https://op.example.com/token', 'https://op.example.com/token'],
    ['HTTPS://OP.EXAMPLE.COM/token', 'https://op.example.com/token'],
    ['https://op.example.com:443/token', 'https://op.example.com/token'],
    ['http://localhost:80/token', 'http://localhost/token'],
    ['https://op.example.com:8443/token', 'https://op.example.com:8443/token'],
    ['https://op.example.com', 'https://op.example.com/'],
    ['https://op.example.com/a/../token', 'https://op.example.com/token'],
    ['https://op.example.com/%74%6Fken', 'https://op.example.com/token'],
    ['https://op.example.com/%7etoken', 'https://op.example.com/~token'],
    ['https://op.example.com/a%2fb', 'https://op.example.com/a%2Fb'],
    ['https://op.example.com/Token', 'https://op.example.com/Token'],
    ['https://op.example.com//token', 'https://op.example.com//token'],
    ['https://User:pw@OP.example.com/token', 'https://User:pw@op.example.com/token'],
  ])('should normalize %s to %s', (uri, normalized) => {
    expect(normalizeDpopHtu(uri)).toBe(normalized);
  });

  // RFC 9449 §4.2: htu is the URI without the query and the fragment.
  it('should leave out the query and the fragment', () => {
    expect(normalizeDpopHtu('https://op.example.com/token?x=1#y')).toBe('https://op.example.com/token');
  });

  it.each(['token', '/token', 'urn:ietf:params:oauth:token', 'ftp://op.example.com/token'])('should not normalize %s', (uri) => {
    expect(normalizeDpopHtu(uri)).toBeUndefined();
  });
});
