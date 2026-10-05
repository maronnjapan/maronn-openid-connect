import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, EXPERIMENTAL_FEATURES, resolveFeatures } from '../features.js';

describe('EXPERIMENTAL_FEATURES', () => {
  it('should list ciba among the experimental features', () => {
    expect(EXPERIMENTAL_FEATURES).toEqual([
      'par',
      'token-exchange',
      'jarm',
      'device-authorization-grant',
      'id-jag',
      'ciba',
      'jwt-introspection-response',
      'rp-initiated-logout',
    ]);
  });
});

describe('resolveFeatures with ciba', () => {
  it('should disable ciba by default', () => {
    expect(DEFAULT_FEATURES.ciba).toBe(false);
  });

  it('should enable ciba only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['ciba'] })).toEqual({
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
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep it disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['ciba'] }).ciba).toBe(false);
  });

  it('should reject it being listed in both enable and disable', () => {
    expect(() =>
      resolveFeatures({ enable: ['ciba'], disable: ['ciba'] }),
    ).toThrow('Feature "ciba" cannot be both enabled and disabled');
  });

  it('should combine it with every other experimental feature', () => {
    expect(
      resolveFeatures({
        enable: ['par', 'token-exchange', 'jarm', 'device-authorization-grant', 'id-jag', 'ciba'],
      }),
    ).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: true,
      tokenExchange: true,
      jarm: true,
      deviceAuthorizationGrant: true,
      idJag: true,
      ciba: true,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep stable features untouched when it is enabled alongside a disable', () => {
    expect(
      resolveFeatures({ enable: ['ciba'], disable: ['refresh-token'] }),
    ).toEqual({
      pkce: true,
      refreshToken: false,
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
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });
});
