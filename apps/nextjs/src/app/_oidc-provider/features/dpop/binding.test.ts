import { describe, expect, it } from 'vitest';

import {
  buildDpopConfirmation,
  parseDpopJkt,
  readDpopJkt,
  requireDpopProofForClient,
  resolvePushedDpopJkt,
  selectDpopRefreshTokenJkt,
  validateDpopBoundGrant,
} from './binding';
import { DpopError } from './errors';

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
    ['undefined', undefined],
  ])('should return undefined for %s', (_name, record) => {
    expect(readDpopJkt(record)).toBeUndefined();
  });
});

describe('parseDpopJkt', () => {
  it('should return the thumbprint the client sent, or undefined when it sent none', () => {
    expect([parseDpopJkt(JKT), parseDpopJkt(undefined)]).toEqual([JKT, undefined]);
  });

  it.each(['', 'short', `${JKT}A`, JKT.replace('-', '+'), 42])('should reject %j', (value) => {
    const error = errorOf(() => parseDpopJkt(value));

    expect(error?.error).toBe('invalid_request');
    expect(error?.errorDescription).toBe('dpop_jkt must be a base64url SHA-256 JWK Thumbprint');
  });
});

describe('resolvePushedDpopJkt', () => {
  it('should bind to the key of the DPoP proof, to dpop_jkt, or to nothing', () => {
    expect([
      resolvePushedDpopJkt(undefined, JKT),
      resolvePushedDpopJkt(JKT, undefined),
      resolvePushedDpopJkt(JKT, JKT),
      resolvePushedDpopJkt(undefined, undefined),
    ]).toEqual([JKT, JKT, JKT, undefined]);
  });

  it('should reject a dpop_jkt of another key than the DPoP proof', () => {
    const error = errorOf(() => resolvePushedDpopJkt(JKT, OTHER_JKT));

    expect(error?.error).toBe('invalid_dpop_proof');
    expect(error?.errorDescription).toBe('dpop_jkt does not match the key of the DPoP proof');
  });
});

describe('requireDpopProofForClient', () => {
  it('should let any client send a DPoP proof, and a client that did not register dpop_bound_access_tokens send none', () => {
    expect(() => {
      requireDpopProofForClient(true, JKT);
      requireDpopProofForClient(false, undefined);
      requireDpopProofForClient(undefined, undefined);
    }).not.toThrow();
  });

  it('should reject a request without a DPoP proof from a client that registered dpop_bound_access_tokens', () => {
    const error = errorOf(() => requireDpopProofForClient(true, undefined));

    expect(error?.error).toBe('invalid_dpop_proof');
    expect(error?.errorDescription).toBe('This client must send a DPoP proof with every token request');
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
  ])('should reject a bound grant %s', (_name, proofJkt, description) => {
    const error = errorOf(() => validateDpopBoundGrant(JKT, proofJkt));

    expect(error?.error).toBe('invalid_grant');
    expect(error?.errorDescription).toBe(description);
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
