import { describe, expect, it } from 'vitest';

import { DpopError } from './errors';
import {
  dpopChallengeOf,
  namesBearerAndDpopSchemes,
  readDpopAuthorization,
  validateDpopAccessTokenBinding,
  validateDpopCredentials,
} from './resource';

const JKT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';
const OTHER_JKT = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I';
/** The DPoP-bound access token of RFC 9449 Figure 13. */
const FIGURE_13_ACCESS_TOKEN = 'Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU';

function errorOf(run: () => unknown): DpopError | undefined {
  try {
    run();
  } catch (error) {
    return error as DpopError;
  }
  return undefined;
}

describe('readDpopAuthorization', () => {
  // RFC 9110 §11.1: the scheme is case-insensitive; RFC 9449 Figure 12: "DPoP" 1*SP token68.
  it('should read the credentials of the DPoP scheme in any letter case, after any number of spaces', () => {
    expect([
      readDpopAuthorization(`DPoP ${FIGURE_13_ACCESS_TOKEN}`),
      readDpopAuthorization('dpop   token-1'),
      readDpopAuthorization('DPOP token-1, Bearer token-1'),
    ]).toEqual([FIGURE_13_ACCESS_TOKEN, 'token-1', 'token-1, Bearer token-1']);
  });

  it('should read the DPoP scheme without credentials as empty credentials', () => {
    expect([readDpopAuthorization('DPoP'), readDpopAuthorization('DPoP   ')]).toEqual(['', '']);
  });

  it.each([null, undefined, '', 'Bearer token-1', 'DPoPtoken-1', 'Basic dXNlcjpwYXNz'])(
    'should return undefined for %j, which is not the DPoP scheme',
    (value) => {
      expect(readDpopAuthorization(value)).toBeUndefined();
    },
  );
});

describe('namesBearerAndDpopSchemes', () => {
  // RFC 9449 Figure 19 / RFC 9110 §5.3: two Authorization fields arrive as one value joined with ", ".
  it.each([
    `Bearer ${FIGURE_13_ACCESS_TOKEN}, DPoP ${FIGURE_13_ACCESS_TOKEN}`,
    'DPoP token-1, Bearer token-1',
    'dpop token-1,bearer token-1',
    'Bearer, DPoP token-1',
  ])('should tell that %j names both the Bearer and the DPoP scheme', (value) => {
    expect(namesBearerAndDpopSchemes(value)).toBe(true);
  });

  it.each([
    null,
    undefined,
    '',
    'Bearer token-1',
    'DPoP token-1',
    'DPoP token-1, DPoP token-2',
    'Bearer token-1, Bearer token-2',
    'Basic dXNlcjpwYXNz, DPoP token-1',
    'DPoP token-1, Bearer=token-1',
    'DPoPBearer token-1',
  ])('should tell that %j does not name both the Bearer and the DPoP scheme', (value) => {
    expect(namesBearerAndDpopSchemes(value)).toBe(false);
  });
});

describe('validateDpopCredentials', () => {
  // RFC 9449 Figure 12 / RFC 9110 §11.2: token68 = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"="
  it('should return the access token of token68 credentials', () => {
    expect([
      validateDpopCredentials(FIGURE_13_ACCESS_TOKEN),
      validateDpopCredentials('eyJhbGciOiJSUzI1NiJ9.e30.c2ln'),
      validateDpopCredentials('YWJj+/de=='),
    ]).toEqual([FIGURE_13_ACCESS_TOKEN, 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln', 'YWJj+/de==']);
  });

  it('should reject empty credentials with invalid_request', () => {
    const error = errorOf(() => validateDpopCredentials(''));

    expect(error).toBeInstanceOf(DpopError);
    expect([error?.error, error?.errorDescription]).toEqual([
      'invalid_request',
      'The DPoP authorization header has no access token',
    ]);
  });

  it.each([
    ['two schemes in one Authorization value', 'token-1, Bearer token-1'],
    ['a space in the token', 'token 1'],
    ['a padding character inside the token', 'abc=def'],
    ['a character outside token68', 'token"1'],
  ])('should reject credentials with %s as not token68', (_name, credentials) => {
    const error = errorOf(() => validateDpopCredentials(credentials));

    expect([error?.error, error?.errorDescription]).toEqual([
      'invalid_request',
      'The access token of the DPoP authorization header is not a token68 value',
    ]);
  });
});

describe('validateDpopAccessTokenBinding', () => {
  it('should accept a bound token with a proof of its key, and an unbound token as a Bearer token', () => {
    expect(() => {
      validateDpopAccessTokenBinding(JKT, JKT);
      validateDpopAccessTokenBinding(undefined, undefined);
    }).not.toThrow();
  });

  // RFC 9449 §7.1 (the key of the proof is the key of the token) and §7.2 (a bound token is not a Bearer token).
  it.each([
    ['a bound token presented as a Bearer token', JKT, undefined, 'A DPoP-bound access token must be presented with the DPoP scheme'],
    ['an unbound token presented with DPoP', undefined, JKT, 'The access token is not bound to a DPoP key'],
    ['a token bound to another key', OTHER_JKT, JKT, 'The access token is bound to a different DPoP key'],
  ])('should reject %s with invalid_token', (_name, boundJkt, proofJkt, description) => {
    const error = errorOf(() => validateDpopAccessTokenBinding(boundJkt, proofJkt));

    expect(error).toBeInstanceOf(DpopError);
    expect([error?.error, error?.errorDescription]).toEqual(['invalid_token', description]);
  });
});

describe('dpopChallengeOf', () => {
  // RFC 9449 §7.1: algs SHOULD list the algs acceptable for the DPoP proof, space-delimited.
  it('should list the algs in the algs parameter of the DPoP challenge', () => {
    expect(dpopChallengeOf(['ES256', 'PS256'])).toEqual({ scheme: 'DPoP', parameters: ['algs="ES256 PS256"'] });
  });

  it('should leave the algs parameter out when no alg is accepted', () => {
    expect(dpopChallengeOf([])).toEqual({ scheme: 'DPoP', parameters: [] });
  });
});
