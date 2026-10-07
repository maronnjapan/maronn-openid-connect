import { describe, it, expect } from 'vitest';
import {
  AVAILABLE_FEATURES,
  DEFAULT_FEATURES,
  EXPERIMENTAL_FEATURES,
  EXTENSION_FEATURES,
  resolveFeatures,
} from '../features.js';

describe('AVAILABLE_FEATURES', () => {
  it('should list the toggleable features in a stable order', () => {
    expect(AVAILABLE_FEATURES).toEqual([
      'pkce',
      'refresh-token',
      'introspection',
      'revocation',
      'request-object',
    ]);
  });
});

describe('EXPERIMENTAL_FEATURES', () => {
  it('should list the experimental features in a stable order', () => {
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

describe('EXTENSION_FEATURES', () => {
  it('should list the extension features in a stable order', () => {
    expect(EXTENSION_FEATURES).toEqual(['google-login']);
  });
});

describe('DEFAULT_FEATURES', () => {
  it('should enable every stable feature and disable every experimental feature by default', () => {
    expect(DEFAULT_FEATURES).toEqual({
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
});

describe('resolveFeatures', () => {
  describe('defaults', () => {
    it('should return the default feature set when no options are given', () => {
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
  });

  describe('disable', () => {
    it('should disable a single feature', () => {
      expect(resolveFeatures({ disable: ['refresh-token'] })).toEqual({
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
        ciba: false,
        jwtIntrospectionResponse: false,
        rpInitiatedLogout: false,
        googleLogin: false,
      });
    });

    it('should disable multiple features', () => {
      expect(
        resolveFeatures({ disable: ['pkce', 'introspection', 'revocation'] }),
      ).toEqual({
        pkce: false,
        refreshToken: true,
        introspection: false,
        revocation: false,
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

    it('should keep an experimental feature disabled when it is listed in disable', () => {
      expect(resolveFeatures({ disable: ['par'] }).par).toBe(false);
    });
  });

  describe('enable', () => {
    it('should keep an explicitly enabled feature enabled', () => {
      expect(resolveFeatures({ enable: ['request-object'] })).toEqual({
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

    it('should enable an experimental feature only when it is named in enable', () => {
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

    it('should enable every experimental and extension feature named in enable', () => {
      expect(
        resolveFeatures({
          enable: [
            'par',
            'token-exchange',
            'jarm',
            'device-authorization-grant',
            'id-jag',
            'ciba',
            'jwt-introspection-response',
            'rp-initiated-logout',
            'google-login',
          ],
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
        jwtIntrospectionResponse: true,
        rpInitiatedLogout: true,
        googleLogin: true,
      });
    });

    it('should keep stable features untouched when an experimental feature is enabled alongside a disable', () => {
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
  });

  describe('validation errors', () => {
    it('should reject an unknown feature name in disable', () => {
      expect(() => resolveFeatures({ disable: ['dpop'] })).toThrow(
        'Unknown feature: "dpop". Available features: pkce, refresh-token, introspection, revocation, request-object. Experimental features (disabled by default): par',
      );
    });

    it('should reject an unknown feature name in enable', () => {
      expect(() => resolveFeatures({ enable: ['implicit'] })).toThrow(
        'Unknown feature: "implicit". Available features: pkce, refresh-token, introspection, revocation, request-object. Experimental features (disabled by default): par',
      );
    });

    it('should reject a feature listed in both enable and disable', () => {
      expect(() =>
        resolveFeatures({ enable: ['pkce'], disable: ['pkce'] }),
      ).toThrow('Feature "pkce" cannot be both enabled and disabled');
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
  });

  // The transaction cookie is how every generated OP finds its authorization
  // transaction, so the opt-in that used to add it on top is gone.
  it('should reject the removed transaction-binding feature', () => {
    expect(() => resolveFeatures({ enable: ['transaction-binding'] })).toThrow(
      'Unknown feature: "transaction-binding".',
    );
  });
});
