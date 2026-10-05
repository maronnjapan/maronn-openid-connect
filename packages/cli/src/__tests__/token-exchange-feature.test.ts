import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, resolveFeatures } from '../features.js';

describe('resolveFeatures with token-exchange', () => {
  it('should disable tokenExchange by default', () => {
    expect(DEFAULT_FEATURES.tokenExchange).toBe(false);
  });

  it('should enable tokenExchange only when it is named in enable', () => {
    expect(resolveFeatures({ enable: ['token-exchange'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: true,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should enable both experimental features when both are named', () => {
    expect(resolveFeatures({ enable: ['par', 'token-exchange'] })).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: true,
      tokenExchange: true,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });

  it('should keep tokenExchange disabled when it is listed in disable', () => {
    expect(resolveFeatures({ disable: ['token-exchange'] }).tokenExchange).toBe(false);
  });

  it('should reject token-exchange listed in both enable and disable', () => {
    expect(() =>
      resolveFeatures({ enable: ['token-exchange'], disable: ['token-exchange'] }),
    ).toThrow('Feature "token-exchange" cannot be both enabled and disabled');
  });

  it('should keep stable features untouched when token-exchange is enabled alongside a disable', () => {
    expect(resolveFeatures({ enable: ['token-exchange'], disable: ['refresh-token'] })).toEqual({
      pkce: true,
      refreshToken: false,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
      tokenExchange: true,
      jarm: false,
      deviceAuthorizationGrant: false,
      idJag: false,
      ciba: false,
      jwtIntrospectionResponse: false,
      rpInitiatedLogout: false,
      googleLogin: false,
      transactionBinding: false,
    });
  });
});
