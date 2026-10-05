import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';

describe('resolveFeatures with id-jag', () => {
  it('should disable idJag by default', () => {
    expect(DEFAULT_FEATURES.idJag).toBe(false);
  });

  it('should enable idJag only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['id-jag'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: true,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should enable id-jag alongside token-exchange when both are named', () => {
    expect(resolveFeatures({ enable: ['token-exchange', 'id-jag'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: true,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: true,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep idJag disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['id-jag'] }).idJag).toBe(false);
  });

  it('should reject id-jag listed in both enable and disable', () => {
    expect(() => resolveFeatures({ enable: ['id-jag'], disable: ['id-jag'] })).toThrow(
      'Feature "id-jag" cannot be both enabled and disabled',
    );
  });
});
