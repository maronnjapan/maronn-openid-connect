import { describe, expect, it } from 'vitest';

import { dpopConfigDefaults, dpopSigningAlgsOf } from './config';

describe('dpopConfigDefaults', () => {
  // RFC 9449 §5.1: by default every alg the checks of jwk.ts verify.
  // RFC 9449 §11.1: a proof is accepted for a short time around its iat.
  // RFC 9449 §8: a nonce of the OP is accepted for a short time after it was issued.
  it('should accept every alg this implementation verifies, a proof up to 60 seconds old with 60 seconds of clock skew, and a nonce up to 120 seconds old, by default', () => {
    expect(dpopConfigDefaults).toEqual({
      dpopSigningAlgValuesSupported: ['ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'RS256', 'RS384', 'RS512', 'EdDSA'],
      dpopProofMaxAgeSeconds: 60,
      dpopProofLeewaySeconds: 60,
      dpopNonceLifetimeSeconds: 120,
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

  // RFC 9449 §5.1: dpop_signing_alg_values_supported lists each alg once.
  it('should return an alg configured twice once, at its first position', () => {
    expect(dpopSigningAlgsOf({ dpopSigningAlgValuesSupported: ['ES256', 'EdDSA', 'ES256', 'EdDSA'] })).toEqual(['ES256', 'EdDSA']);
  });

  it('should return no alg when every configured alg is one this implementation does not verify', () => {
    expect(dpopSigningAlgsOf({ dpopSigningAlgValuesSupported: ['HS256'] })).toEqual([]);
  });
});
