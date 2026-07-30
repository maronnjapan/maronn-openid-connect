import { describe, it, expect } from 'vitest';
import {
  AVAILABLE_FEATURES,
  DEFAULT_FEATURES,
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

describe('DEFAULT_FEATURES', () => {
  it('should enable every stable feature and disable every experimental feature by default', () => {
    expect(DEFAULT_FEATURES).toEqual({
      pkce: true,
      refreshToken: true,
      introspection: true,
      revocation: true,
      requestObject: true,
      par: false,
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
      });
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
  });
});
