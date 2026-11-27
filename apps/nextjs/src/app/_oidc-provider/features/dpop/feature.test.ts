import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { requestTo } from '../../../../test-support/context';
import { GET as discovery } from '../../../.well-known/openid-configuration/route';
import { createProviderConfig } from '../../config';
import { configOf, corsHeadersOf, discoveryOf } from '../../feature';
import { dpop } from './feature';

const ISSUER = 'https://op.example.com';

describe('dpop', () => {
  // RFC 9449 §5.1: the JWS algs the OP accepts for DPoP proofs.
  it('should advertise the algs of the settings in dpop_signing_alg_values_supported', () => {
    const config = createProviderConfig({ issuer: ISSUER, dpopSigningAlgValuesSupported: ['ES256', 'PS256'] });

    expect(discoveryOf([dpop], {}, ISSUER, config)).toEqual({ dpop_signing_alg_values_supported: ['ES256', 'PS256'] });
  });

  // RFC 9449 §11.6: none, MACs and algs the checks do not verify are never accepted, so never advertised.
  it('should leave out of dpop_signing_alg_values_supported the algs the checks do not verify', () => {
    const config = createProviderConfig({ issuer: ISSUER, dpopSigningAlgValuesSupported: ['none', 'ES256', 'HS256', 'ES256K', 'EdDSA'] });

    expect(discoveryOf([dpop], {}, ISSUER, config)).toEqual({ dpop_signing_alg_values_supported: ['ES256', 'EdDSA'] });
  });

  // RFC 9449 §5.1: an empty list would signal support for DPoP with no alg a proof can use.
  it('should add no member to the discovery document when none of the algs of the settings is verifiable', () => {
    const config = createProviderConfig({ issuer: ISSUER, dpopSigningAlgValuesSupported: ['HS256'] });

    expect(discoveryOf([dpop], {}, ISSUER, config)).toEqual({});
  });

  it('should default to every asymmetric alg its checks verify, a proof window of 60 seconds and 60 seconds of skew, a nonce lifetime of 120 seconds and no nonce required at the authorization server', () => {
    expect(configOf([dpop])).toEqual({
      dpopSigningAlgValuesSupported: ['ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'RS256', 'RS384', 'RS512', 'EdDSA'],
      dpopProofMaxAgeSeconds: 60,
      dpopProofLeewaySeconds: 60,
      dpopNonceLifetimeSeconds: 120,
      dpopNonceRequiredAtAuthorizationServer: false,
    });
  });

  // RFC 9449 §8: OIDC_DPOP_NONCE_REQUIRED_AT_AUTHORIZATION_SERVER=1 makes the token and PAR endpoints require a nonce.
  it.each([
    ['1', true],
    ['true', false],
  ])('should require a nonce at the authorization server when OIDC_DPOP_NONCE_REQUIRED_AT_AUTHORIZATION_SERVER is %s: %s', async (value, required) => {
    vi.stubEnv('OIDC_DPOP_NONCE_REQUIRED_AT_AUTHORIZATION_SERVER', value);
    vi.resetModules();
    onTestFinished(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    const { dpop: loaded } = await import('./feature');

    expect(loaded.config?.dpopNonceRequiredAtAuthorizationServer).toBe(required);
  });

  // RFC 9449 §4.1 / §7.1 / §8: a browser sends the DPoP header, reads the challenges of a
  // failure and the nonce the server provides.
  it('should let browsers send the DPoP header and read WWW-Authenticate and DPoP-Nonce', () => {
    expect(corsHeadersOf([dpop])).toEqual({ allowHeaders: ['DPoP'], exposeHeaders: ['WWW-Authenticate', 'DPoP-Nonce'] });
  });

  // RFC 9449 §5.1 / OIDC Discovery 1.0 §3: the discovery document of this provider, where the feature is enabled.
  it('should advertise every alg of the checks in the discovery document of the provider', async () => {
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
