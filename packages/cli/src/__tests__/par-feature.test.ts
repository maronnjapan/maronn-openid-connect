import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, EXPERIMENTAL_FEATURES, resolveFeatures } from '../features.js';

describe('EXPERIMENTAL_FEATURES', () => {
  it('should list par among the experimental features', () => {
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

describe('resolveFeatures with experimental features', () => {
  it('should disable par by default', () => {
    expect(DEFAULT_FEATURES.par).toBe(false);
  });

  it('should leave par disabled when no experimental feature is requested', () => {
    expect(resolveFeatures({})).toEqual({
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
      googleLogin: false,
    });
  });

  it('should enable par only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['par'] })).toEqual({
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
      googleLogin: false,
    });
  });

  it('should keep par disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['par'] }).par).toBe(false);
  });

  it('should reject par listed in both enable and disable', () => {
    expect(() => resolveFeatures({ enable: ['par'], disable: ['par'] })).toThrow(
      'Feature "par" cannot be both enabled and disabled',
    );
  });

  it('should keep stable features untouched when par is enabled alongside a disable', () => {
    expect(resolveFeatures({ enable: ['par'], disable: ['revocation'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: false,
      requestObject: true,
      par: true,
      tokenExchange: false,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
    });
  });

  it('should name the experimental features in the unknown-feature error', () => {
    expect(() => resolveFeatures({ enable: ['dpop'] })).toThrow(
      'Unknown feature: "dpop". Available features: pkce, refresh-token, introspection, revocation, request-object. Experimental features (disabled by default): par, token-exchange, jarm, device-authorization-grant, id-jag, ciba',
    );
  });
});
