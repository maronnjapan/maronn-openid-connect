import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { configOf, corsHeadersOf, discoveryOf } from '../feature.js';
import { dpop } from './feature.js';

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

  it('should default to every asymmetric alg its checks verify, a proof window of 60 seconds and 60 seconds of skew, and a nonce lifetime of 120 seconds', () => {
    expect(configOf([dpop])).toEqual({
      dpopSigningAlgValuesSupported: ['ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'RS256', 'RS384', 'RS512', 'EdDSA'],
      dpopProofMaxAgeSeconds: 60,
      dpopProofLeewaySeconds: 60,
      dpopNonceLifetimeSeconds: 120,
    });
  });

  // The nonce check of proof.ts reads the secret of the DPoP nonces from the request context.
  it.each([
    ['the secret of the options', { dpopNonceSecret: 'dpop-nonce-secret-for-the-unit-tests-0001' }, 'dpop-nonce-secret-for-the-unit-tests-0001'],
    ['no secret when the options have none', {}, undefined],
  ])('should put into the request context %s', async (_name, options, secret) => {
    const { c } = await providerContext({ options });

    expect(c.get('dpopNonceSecret')).toBe(secret);
  });

  // RFC 9449 §4.1 / §7.1: a browser sends the DPoP header and reads the challenges of a failure.
  it('should let browsers send the DPoP header and read WWW-Authenticate', () => {
    expect(corsHeadersOf([dpop])).toEqual({ allowHeaders: ['DPoP'], exposeHeaders: ['WWW-Authenticate'] });
  });
});
