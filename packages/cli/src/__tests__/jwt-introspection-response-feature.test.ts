import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';

describe('resolveFeatures with jwt-introspection-response', () => {
  it('should disable jwt-introspection-response by default', () => {
    expect(DEFAULT_FEATURES.jwtIntrospectionResponse).toBe(false);
  });

  it('should enable jwt-introspection-response only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['jwt-introspection-response'] })).toEqual({
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
      jwtIntrospectionResponse: true,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep jwt-introspection-response disabled when it is listed in disable', () => {
    expect(
      resolveFeatures({ disable: ['jwt-introspection-response'] }).jwtIntrospectionResponse,
    ).toBe(false);
  });

  it('should reject jwt-introspection-response listed in both enable and disable', () => {
    expect(() =>
      resolveFeatures({
        enable: ['jwt-introspection-response'],
        disable: ['jwt-introspection-response'],
      }),
    ).toThrow('Feature "jwt-introspection-response" cannot be both enabled and disabled');
  });

  // RFC 9701 rides on the RFC 7662 endpoint: without introspection there is
  // nowhere to answer with the JWT, so the combination is rejected up front.
  it('should reject jwt-introspection-response combined with a disabled introspection feature', () => {
    expect(() =>
      resolveFeatures({ enable: ['jwt-introspection-response'], disable: ['introspection'] }),
    ).toThrow(
      'Feature "jwt-introspection-response" requires the introspection feature: ' +
        'the RFC 9701 JWT response is returned by the RFC 7662 introspection endpoint, ' +
        'which is not generated when introspection is disabled',
    );
  });

  it('should combine jwt-introspection-response with the other experimental features', () => {
    expect(resolveFeatures({ enable: ['jarm', 'jwt-introspection-response'] })).toEqual({
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
      jwtIntrospectionResponse: true,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });
});
