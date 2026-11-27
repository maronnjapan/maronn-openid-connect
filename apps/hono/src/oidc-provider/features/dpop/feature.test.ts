import { describe, expect, it } from 'vitest';
import { createProviderConfig } from '../../config.js';
import { configOf, corsHeadersOf, discoveryOf } from '../feature.js';
import { dpop } from './feature.js';

const ISSUER = 'https://op.example.com';

describe('dpop', () => {
  // RFC 9449 §5.1: dpop_signing_alg_values_supported signals support for DPoP,
  // which no endpoint has while none checks a DPoP proof.
  it('should add no member to the discovery document', () => {
    const metadata = discoveryOf([dpop], {}, ISSUER, createProviderConfig({ issuer: ISSUER }));

    expect(metadata).toEqual({});
  });

  it('should default to every asymmetric alg its checks verify, a proof window of 60 seconds and 60 seconds of skew', () => {
    expect(configOf([dpop])).toEqual({
      dpopSigningAlgValuesSupported: ['ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'RS256', 'RS384', 'RS512', 'EdDSA'],
      dpopProofMaxAgeSeconds: 60,
      dpopProofLeewaySeconds: 60,
    });
  });

  // RFC 9449 §4.1 / §7.1: a browser sends the DPoP header and reads the challenges of a failure.
  it('should let browsers send the DPoP header and read WWW-Authenticate', () => {
    expect(corsHeadersOf([dpop])).toEqual({ allowHeaders: ['DPoP'], exposeHeaders: ['WWW-Authenticate'] });
  });
});
