import { describe, expect, it } from 'vitest';
import { createProviderConfig } from '../../config';
import { discoveryOf, responseModesOf, responseTypesOf, tokenGrantsOf } from '../../feature';
import { implicitFlow } from './feature';
import { fragmentResponseModeHandler } from './response-mode';

describe('implicitFlow', () => {
  // OIDC Discovery 1.0 §3: response_modes_supported and grant_types_supported.
  it('should advertise the fragment response mode and the implicit grant type next to those the provider advertises', () => {
    const issuer = 'https://op.example.com';
    const metadata = discoveryOf(
      [implicitFlow],
      { response_modes_supported: ['query'], grant_types_supported: ['authorization_code'] },
      issuer,
      createProviderConfig({ issuer }),
    );

    expect(metadata).toEqual({
      response_modes_supported: ['query', 'fragment'],
      grant_types_supported: ['authorization_code', 'implicit'],
    });
  });

  // OIDC Core 1.0 §3.2.2.1: the response types the authorization endpoint accepts.
  it('should answer response_type=id_token and id_token token', () => {
    expect(responseTypesOf([implicitFlow])).toEqual(['id_token', 'id_token token']);
  });

  // The consent decision answers in the fragment the transaction stored.
  it('should answer in the fragment response mode at the consent decision', () => {
    expect(responseModesOf([implicitFlow])).toEqual([fragmentResponseModeHandler]);
  });

  // The implicit grant is answered at the authorization endpoint: the token
  // endpoint must not accept grant_type=implicit.
  it('should answer no grant at the token endpoint', () => {
    expect(tokenGrantsOf([implicitFlow])).toEqual([]);
  });
});
