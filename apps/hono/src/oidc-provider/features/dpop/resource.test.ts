import { describe, expect, it } from 'vitest';

import { DpopError } from './errors.js';
import { buildDpopChallenge, readDpopAuthorization, validateDpopAccessTokenBinding } from './resource.js';

const JKT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';
const OTHER_JKT = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I';

function errorOf(run: () => unknown): DpopError | undefined {
  try {
    run();
  } catch (error) {
    return error as DpopError;
  }
  return undefined;
}

describe('readDpopAuthorization', () => {
  it('should read the token of the DPoP scheme in any letter case, after any number of spaces', () => {
    expect([readDpopAuthorization('DPoP token-1'), readDpopAuthorization('dpop   token-1')]).toEqual(['token-1', 'token-1']);
  });

  it.each([null, undefined, '', 'Bearer token-1', 'DPoPtoken-1'])('should return undefined for %j', (value) => {
    expect(readDpopAuthorization(value)).toBeUndefined();
  });

  it.each(['DPoP', 'DPoP   '])('should reject the DPoP scheme without a token: %j', (value) => {
    const error = errorOf(() => readDpopAuthorization(value));

    expect(error?.error).toBe('invalid_request');
    expect(error?.errorDescription).toBe('The DPoP authorization header has no access token');
  });
});

describe('validateDpopAccessTokenBinding', () => {
  it('should accept a bound token with a proof of its key, and an unbound token as a Bearer token', () => {
    expect(() => {
      validateDpopAccessTokenBinding(JKT, JKT);
      validateDpopAccessTokenBinding(undefined, undefined);
    }).not.toThrow();
  });

  it.each([
    ['a bound token presented as a Bearer token', JKT, undefined, 'A DPoP-bound access token must be presented with the DPoP scheme'],
    ['an unbound token presented with DPoP', undefined, JKT, 'The access token is not bound to a DPoP key'],
    ['a token bound to another key', OTHER_JKT, JKT, 'The access token is bound to a different DPoP key'],
  ])('should reject %s', (_name, boundJkt, proofJkt, description) => {
    const error = errorOf(() => validateDpopAccessTokenBinding(boundJkt, proofJkt));

    expect(error?.error).toBe('invalid_token');
    expect(error?.errorDescription).toBe(description);
  });
});

describe('buildDpopChallenge', () => {
  it('should list the algs, after the error when there is one', () => {
    expect([
      buildDpopChallenge({ algs: ['ES256', 'PS256'] }),
      buildDpopChallenge({ algs: ['ES256'], error: 'invalid_token', errorDescription: 'Invalid DPoP key binding' }),
    ]).toEqual([
      'DPoP algs="ES256 PS256"',
      'DPoP error="invalid_token", error_description="Invalid DPoP key binding", algs="ES256"',
    ]);
  });
});
