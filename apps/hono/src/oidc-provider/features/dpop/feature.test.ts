import { describe, expect, it } from 'vitest';
import { createProviderConfig } from '../../config.js';
import { configOf, corsHeadersOf, discoveryOf } from '../feature.js';
import { dpop } from './feature.js';

const ISSUER = 'https://op.example.com';

describe('dpop', () => {
  // RFC 9449 §5.1: the algorithms of DPoP proofs the OP accepts.
  it('should advertise dpop_signing_alg_values_supported from the settings', () => {
    const metadata = discoveryOf([dpop], {}, ISSUER, createProviderConfig({ issuer: ISSUER, dpopSigningAlgValuesSupported: ['ES256', 'PS256'] }));

    expect(metadata).toEqual({ dpop_signing_alg_values_supported: ['ES256', 'PS256'] });
  });

  it('should default to every asymmetric alg the package verifies, a proof window of 60 seconds and 60 seconds of skew', () => {
    expect(configOf([dpop])).toEqual({
      dpopSigningAlgValuesSupported: ['ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'RS256', 'RS384', 'RS512', 'EdDSA'],
      dpopProofMaxAgeSeconds: 60,
      dpopProofLeewaySeconds: 60,
    });
  });

  // RFC 9449 §4.1 / §7.1: a browser sends the DPoP header and reads the DPoP challenge.
  it('should let browsers send the DPoP header and read WWW-Authenticate', () => {
    expect(corsHeadersOf([dpop])).toEqual({ allowHeaders: ['DPoP'], exposeHeaders: ['WWW-Authenticate'] });
  });
});
