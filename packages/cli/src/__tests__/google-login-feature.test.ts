import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, EXTENSION_FEATURES, resolveFeatures } from '../features.js';

describe('EXTENSION_FEATURES', () => {
  it('should list the extension features in a stable order', () => {
    expect(EXTENSION_FEATURES).toEqual(['google-login']);
  });
});

describe('resolveFeatures with google-login', () => {
  it('should disable google-login by default', () => {
    expect(DEFAULT_FEATURES.googleLogin).toBe(false);
  });

  it('should enable googleLogin only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['google-login'] })).toEqual({
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
      rpInitiatedLogout: false,
      googleLogin: true,
    });
  });

  it('should keep google-login disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['google-login'] }).googleLogin).toBe(false);
  });

  it('should reject google-login listed in both enable and disable', () => {
    expect(() =>
      resolveFeatures({ enable: ['google-login'], disable: ['google-login'] }),
    ).toThrow('Feature "google-login" cannot be both enabled and disabled');
  });

  it('should combine google-login with experimental features', () => {
    expect(
      resolveFeatures({ enable: ['google-login', 'par'] }),
    ).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: true,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: true,
    });
  });
});
