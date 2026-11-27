import { describe, expect, it } from 'vitest';
import { requestTo } from '../../../../test-support/context';
import { GET as discovery } from '../../../.well-known/openid-configuration/route';
import { createProviderConfig } from '../../config';
import { configOf, corsHeadersOf, discoveryOf } from '../../feature';
import { dpop } from './feature';

const ISSUER = 'https://op.example.com';

describe('dpop', () => {
  // RFC 9449 §5.1: the algorithms of DPoP proofs the OP accepts.
  it('should advertise dpop_signing_alg_values_supported from the settings', () => {
    const metadata = discoveryOf([dpop], {}, ISSUER, createProviderConfig({ issuer: ISSUER, dpopSigningAlgValuesSupported: ['ES256', 'PS256'] }));

    expect(metadata).toEqual({ dpop_signing_alg_values_supported: ['ES256', 'PS256'] });
  });

  // RFC 9449 §5.1 / §11.6: an alg the proof checks cannot verify is not advertised.
  it('should leave out of dpop_signing_alg_values_supported the configured algs the proof checks do not verify', () => {
    const config = createProviderConfig({ issuer: ISSUER, dpopSigningAlgValuesSupported: ['none', 'ES256', 'HS256', 'ES256K', 'EdDSA'] });

    const metadata = discoveryOf([dpop], {}, ISSUER, config);

    expect(metadata).toEqual({ dpop_signing_alg_values_supported: ['ES256', 'EdDSA'] });
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

  // RFC 9449 §5.1 / OIDC Discovery 1.0 §3: the discovery document of this provider, where the feature is enabled.
  it('should advertise dpop_signing_alg_values_supported in the discovery document of the provider', async () => {
    const response = await discovery(requestTo('/.well-known/openid-configuration'));

    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>).dpop_signing_alg_values_supported).toEqual([
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
});
