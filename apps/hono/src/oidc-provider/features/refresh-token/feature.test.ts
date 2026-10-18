import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { discoveryOf, tokenGrantsOf } from '../feature.js';
import { refreshToken } from './feature.js';

describe('refreshToken', () => {
  // OAuth 2.1 §4.3 / RFC 6749 §6: the feature answers the refresh_token grant at the token endpoint.
  it('should add the refresh_token grant to the grants the token endpoint answers', () => {
    expect(tokenGrantsOf([refreshToken])).toEqual(['refresh_token']);
  });

  // OIDC Core 1.0 §11 / OIDC Discovery 1.0 §3: offline_access is advertised in scopes_supported.
  it('should add offline_access to the scopes_supported the provider advertises', () => {
    const metadata = { issuer: TEST_ISSUER, scopes_supported: ['openid', 'profile'] };

    expect(discoveryOf([refreshToken], metadata, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual({
      issuer: TEST_ISSUER,
      scopes_supported: ['openid', 'profile', 'offline_access'],
    });
  });
});
