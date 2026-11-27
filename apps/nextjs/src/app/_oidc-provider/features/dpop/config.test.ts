import { describe, expect, it } from 'vitest';

import { dpopConfigDefaults, dpopSigningAlgsOf } from './config';

describe('dpopConfigDefaults', () => {
  // RFC 9449 §5.1: by default every alg the checks of jwk.ts verify.
  it('should accept every alg this implementation verifies by default', () => {
    expect(dpopConfigDefaults).toEqual({
      dpopSigningAlgValuesSupported: ['ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'RS256', 'RS384', 'RS512', 'EdDSA'],
    });
  });
});

describe('dpopSigningAlgsOf', () => {
  it('should return the default algs', () => {
    expect(dpopSigningAlgsOf(dpopConfigDefaults)).toEqual([
      'ES256',
      'ES384',
      'ES512',
      'PS256',
      'PS384',
      'PS512',
      'RS256',
      'RS384',
      'RS512',
      'EdDSA',
    ]);
  });

  it('should return the configured algs in the configured order', () => {
    expect(dpopSigningAlgsOf({ dpopSigningAlgValuesSupported: ['EdDSA', 'ES256'] })).toEqual(['EdDSA', 'ES256']);
  });

  // RFC 9449 §4.3 / §11.6: an alg that is none, a MAC or not verified here
  // must not be accepted, so it is not returned.
  it('should leave out the configured algs this implementation does not verify', () => {
    expect(dpopSigningAlgsOf({ dpopSigningAlgValuesSupported: ['none', 'ES256', 'HS256', 'ES256K', 'PS512', 'es256'] })).toEqual([
      'ES256',
      'PS512',
    ]);
  });

  it('should return no alg when every configured alg is one this implementation does not verify', () => {
    expect(dpopSigningAlgsOf({ dpopSigningAlgValuesSupported: ['HS256'] })).toEqual([]);
  });
});
