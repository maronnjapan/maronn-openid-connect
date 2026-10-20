import { describe, expect, it } from 'vitest';
import { createProviderConfig } from '../../config';
import { discoveryOf, responseModesOf, responseTypesOf, tokenGrantsOf } from '../../feature';
import { hybridFlow } from './feature';

describe('hybridFlow', () => {
  // OIDC Discovery 1.0 §3: grant_types_supported (OIDC Dynamic Client
  // Registration 1.0 §2 pairs the hybrid response types with implicit) and
  // claims_supported (OIDC Core 1.0 §3.3.2.11: c_hash).
  it('should advertise the implicit grant type and the c_hash claim next to those the provider advertises', () => {
    const issuer = 'https://op.example.com';
    const metadata = discoveryOf(
      [hybridFlow],
      { grant_types_supported: ['authorization_code'], claims_supported: ['sub', 'at_hash'] },
      issuer,
      createProviderConfig({ issuer }),
    );

    expect(metadata).toEqual({
      grant_types_supported: ['authorization_code', 'implicit'],
      claims_supported: ['sub', 'at_hash', 'c_hash'],
    });
  });

  // OIDC Core 1.0 §3.3.1.1: the response types the authorization endpoint accepts.
  it('should answer response_type=code id_token, code token and code id_token token', () => {
    expect(responseTypesOf([hybridFlow])).toEqual(['code id_token', 'code token', 'code id_token token']);
  });

  // The fragment response mode is the implicit-flow feature's, which this one requires.
  it('should restore no response mode of its own', () => {
    expect(responseModesOf([hybridFlow])).toEqual([]);
  });

  // The code of the Hybrid Flow is exchanged with the authorization_code
  // grant every provider answers.
  it('should answer no grant at the token endpoint', () => {
    expect(tokenGrantsOf([hybridFlow])).toEqual([]);
  });
});
