import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';

describe('resolveFeatures with jarm', () => {
  it('should disable jarm by default', () => {
    expect(DEFAULT_FEATURES.jarm).toBe(false);
  });

  it('should enable jarm only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['jarm'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: true,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
    });
  });

  it('should keep jarm disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['jarm'] }).jarm).toBe(false);
  });

  it('should reject jarm listed in both enable and disable', () => {
    expect(() => resolveFeatures({ enable: ['jarm'], disable: ['jarm'] })).toThrow(
      'Feature "jarm" cannot be both enabled and disabled',
    );
  });

  it('should combine jarm with the other experimental features', () => {
    expect(resolveFeatures({ enable: ['par', 'token-exchange', 'jarm'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: true,
      tokenExchange: true,
      jarm: true,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
    });
  });

  it('should keep stable features untouched when jarm is enabled alongside a disable', () => {
    expect(resolveFeatures({ enable: ['jarm'], disable: ['revocation'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: false,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: true,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
    });
  });
});
