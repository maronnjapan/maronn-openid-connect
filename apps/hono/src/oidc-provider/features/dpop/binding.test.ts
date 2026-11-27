import { describe, expect, it } from 'vitest';

import { buildDpopConfirmation, parseDpopJkt, readDpopJkt, selectDpopRefreshTokenJkt, validateDpopBoundGrant } from './binding.js';
import { DpopError } from './errors.js';

/** The JWK Thumbprint of RFC 9449 Figure 25 (dpop_jkt). */
const JKT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';
/** The JWK Thumbprint of RFC 9449 Figure 9 (cnf.jkt). */
const OTHER_JKT = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I';

function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('buildDpopConfirmation', () => {
  it('should put the thumbprint under jkt', () => {
    expect(buildDpopConfirmation(JKT)).toEqual({ jkt: JKT });
  });
});

describe('readDpopJkt', () => {
  it('should read cnf.jkt of a record', () => {
    expect(readDpopJkt({ sub: 'user-1', cnf: { jkt: JKT } })).toBe(JKT);
  });

  it.each([
    ['a record without cnf', { sub: 'user-1' }],
    ['a record bound with mTLS', { cnf: { 'x5t#S256': 'abc' } }],
    ['a cnf that is not an object', { cnf: 'jkt' }],
    ['a cnf that is null', { cnf: null }],
    ['a jkt that is not a string', { cnf: { jkt: 42 } }],
    ['null', null],
    ['undefined', undefined],
  ])('should return undefined for %s', (_name, record) => {
    expect(readDpopJkt(record)).toBeUndefined();
  });
});

describe('parseDpopJkt', () => {
  it('should return a JWK Thumbprint as it is', () => {
    expect([parseDpopJkt(JKT), parseDpopJkt(OTHER_JKT)]).toEqual([JKT, OTHER_JKT]);
  });

  // RFC 6749 §3.1: a parameter sent without a value is treated as omitted.
  it.each([
    ['no value', undefined],
    ['an empty value', ''],
  ])('should return undefined for %s', (_name, value) => {
    expect(parseDpopJkt(value)).toBeUndefined();
  });

  // RFC 9449 §10 / RFC 7638 §3: the base64url of a SHA-256 hash, 43 characters without padding.
  it.each([
    ['a value that is not base64url', 'not a thumbprint'],
    ['a value one character short', JKT.slice(0, 42)],
    ['a value one character long', `${JKT}A`],
    ['a value with padding', `${JKT}=`],
    ['a value of the base64 alphabet', 'NzbLsXh8uDCcd+6MNwXF4W/7noWXFZAfHkxZsRGC9Xs'],
    // The last character of 43 carries two bits beyond the 32 bytes; 't' sets one of them where the hash has 's'.
    ['a value whose last character is not the canonical one', 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xt'],
    ['a value with a space before it', ` ${JKT}`],
    ['a number', 42],
    ['null', null],
    ['an object', { jkt: JKT }],
  ])('should reject %s with invalid_request', (_name, value) => {
    const error = errorOf(() => parseDpopJkt(value));

    expect(error).toBeInstanceOf(DpopError);
    expect(error).toMatchObject({ error: 'invalid_request', errorDescription: 'dpop_jkt must be a base64url SHA-256 JWK Thumbprint' });
  });
});

describe('validateDpopBoundGrant', () => {
  it('should accept an unbound grant with or without a proof, and a bound grant with a proof of its key', () => {
    expect(() => {
      validateDpopBoundGrant(undefined, undefined);
      validateDpopBoundGrant(undefined, JKT);
      validateDpopBoundGrant(JKT, JKT);
    }).not.toThrow();
  });

  it.each([
    ['without a proof', undefined, 'The grant is bound to a DPoP key, but no DPoP proof was sent'],
    ['with a proof of another key', OTHER_JKT, 'The DPoP proof key does not match the key the grant is bound to'],
  ])('should reject a bound grant %s with invalid_grant', (_name, proofJkt, description) => {
    const error = errorOf(() => validateDpopBoundGrant(JKT, proofJkt));

    expect(error).toBeInstanceOf(DpopError);
    expect(error).toMatchObject({ error: 'invalid_grant', errorDescription: description });
  });
});

describe('selectDpopRefreshTokenJkt', () => {
  it('should bind the refresh token of a public client only', () => {
    expect([
      selectDpopRefreshTokenJkt(true, JKT),
      selectDpopRefreshTokenJkt(true, undefined),
      selectDpopRefreshTokenJkt(false, JKT),
    ]).toEqual([JKT, undefined, undefined]);
  });
});
