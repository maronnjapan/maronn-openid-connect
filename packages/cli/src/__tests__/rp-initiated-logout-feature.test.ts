import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';

describe('resolveFeatures with rp-initiated-logout', () => {
  it('should disable rp-initiated-logout by default', () => {
    expect(DEFAULT_FEATURES.rpInitiatedLogout).toBe(false);
  });

  it('should enable rp-initiated-logout only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['rp-initiated-logout'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: true,
      googleLogin: false,
    });
  });

  it('should keep rp-initiated-logout disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['rp-initiated-logout'] }).rpInitiatedLogout).toBe(false);
  });

  it('should reject rp-initiated-logout listed in both enable and disable', () => {
    expect(() =>
      resolveFeatures({
        enable: ['rp-initiated-logout'],
        disable: ['rp-initiated-logout'],
      }),
    ).toThrow('Feature "rp-initiated-logout" cannot be both enabled and disabled');
  });

  // The logout surface rides only on the always-generated session base (browser
  // session store, login screen, id_token_hint JWKS provider), so there is no
  // cross-feature dependency to enforce: any combination must resolve.
  it('should combine rp-initiated-logout with the other experimental features', () => {
    expect(resolveFeatures({ enable: ['ciba', 'rp-initiated-logout'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: true,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: true,
      googleLogin: false,
    });
  });

  it('should combine rp-initiated-logout with a disabled stable feature', () => {
    const features = resolveFeatures({
      enable: ['rp-initiated-logout'],
      disable: ['revocation'],
    });

    expect(features.rpInitiatedLogout).toBe(true);
    expect(features.revocation).toBe(false);
  });
});
