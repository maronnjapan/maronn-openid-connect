import { describe, expect, it } from 'vitest';

import { decodeBase64Url, encodeBase64Url } from './base64url';
import { DpopError, isDpopError } from './errors';
import { normalizeDpopHtu } from './htu';

describe('normalizeDpopHtu', () => {
  it.each([
    ['https://op.example.com/token', 'https://op.example.com/token'],
    ['HTTPS://OP.EXAMPLE.COM/token', 'https://op.example.com/token'],
    ['https://op.example.com:443/token', 'https://op.example.com/token'],
    ['http://localhost:80/token', 'http://localhost/token'],
    ['https://op.example.com:8443/token', 'https://op.example.com:8443/token'],
    ['https://op.example.com', 'https://op.example.com/'],
    ['https://op.example.com/a/../token', 'https://op.example.com/token'],
    ['https://op.example.com/%74%6Fken', 'https://op.example.com/token'],
    ['https://op.example.com/a%2fb', 'https://op.example.com/a%2Fb'],
    ['https://op.example.com/token?x=1#y', 'https://op.example.com/token'],
  ])('should normalize %s to %s', (uri, normalized) => {
    expect(normalizeDpopHtu(uri)).toBe(normalized);
  });

  it.each(['token', 'urn:ietf:params:oauth:token', 'ftp://op.example.com/token'])('should not normalize %s', (uri) => {
    expect(normalizeDpopHtu(uri)).toBeUndefined();
  });
});

describe('base64url', () => {
  it('should encode without padding and decode back', () => {
    const bytes = new Uint8Array([251, 255, 0, 1]);

    expect(encodeBase64Url(bytes)).toBe('-_8AAQ');
    expect(decodeBase64Url('-_8AAQ')).toEqual(bytes);
  });

  it.each(['-_8AAQ==', 'a+b', 'abcde'])('should not decode %s', (value) => {
    expect(decodeBase64Url(value)).toBeUndefined();
  });
});

describe('isDpopError', () => {
  it('should recognize a DpopError and an error of the same shape from another copy of the package', () => {
    const copy = Object.assign(new Error('x'), { name: 'DpopError', error: 'invalid_token', errorDescription: 'x' });

    expect([
      isDpopError(new DpopError('invalid_dpop_proof', 'x')),
      isDpopError(copy),
      isDpopError(new Error('x')),
      isDpopError('DpopError'),
    ]).toEqual([true, true, false, false]);
  });
});
