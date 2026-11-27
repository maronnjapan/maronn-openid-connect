import { describe, expect, it } from 'vitest';

import { decodeBase64Url, encodeBase64Url } from './base64url.js';

/** The base64 test vectors of RFC 4648 §10, written without padding (§5 alphabet; they use no '-' or '_'). */
const RFC4648_VECTORS: readonly (readonly [string, string])[] = [
  ['', ''],
  ['f', 'Zg'],
  ['fo', 'Zm8'],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg'],
  ['fooba', 'Zm9vYmE'],
  ['foobar', 'Zm9vYmFy'],
];

describe('encodeBase64Url', () => {
  // RFC 4648 §10 / RFC 7515 §2: without the trailing '='.
  it.each(RFC4648_VECTORS)('should encode "%s" as "%s"', (text, encoded) => {
    expect(encodeBase64Url(new TextEncoder().encode(text))).toBe(encoded);
  });

  // RFC 4648 §5: '-' and '_' in place of '+' and '/'.
  it('should use the URL and filename safe alphabet', () => {
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_');
  });

  it('should encode the bytes of an ArrayBuffer', () => {
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xef]).buffer)).toBe('--8');
  });
});

describe('decodeBase64Url', () => {
  it.each(RFC4648_VECTORS)('should decode "%s" from "%s"', (text, encoded) => {
    expect(decodeBase64Url(encoded)).toEqual(new TextEncoder().encode(text));
  });

  it('should decode the URL and filename safe alphabet', () => {
    expect(decodeBase64Url('-_-_')).toEqual(new Uint8Array([0xfb, 0xff, 0xbf]));
  });

  it.each([
    ['padding', 'Zm8='],
    ['the + of base64', 'Zm+v'],
    ['the / of base64', 'Zm/v'],
    ['a space', 'Zm9v Yg'],
    ['a length that leaves one character over', 'Zm9vY'],
  ])('should reject a value with %s', (_name, value) => {
    expect(decodeBase64Url(value)).toBeUndefined();
  });

  // RFC 4648 §3.5: the pad bits of the last character must be zero, so that
  // every byte string has one encoding ('Zg' is the canonical form of 'f').
  it.each([
    ['one byte', 'Zh'],
    ['two bytes', 'Zm9'],
    ['the 32 bytes of an EC coordinate', 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFt'],
  ])('should reject %s encoded with non-zero pad bits', (_name, value) => {
    expect(decodeBase64Url(value)).toBeUndefined();
  });
});
