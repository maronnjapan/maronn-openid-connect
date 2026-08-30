import { describe, it, expect } from 'vitest';
import {
  AVAILABLE_FEATURES,
  DEFAULT_FEATURES,
  OPTIONAL_FEATURES,
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

// Stable, spec-optional hardening: implemented in core (not the experimental
// package) but off by default, because it is not required by OIDC Core / OAuth 2.1
// and the default generation output is meant to be the spec and nothing more.
describe('OPTIONAL_FEATURES', () => {
  it('should list the opt-in stable features in a stable order', () => {
    expect(OPTIONAL_FEATURES).toEqual(['transaction-binding']);
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
      transactionBinding: false,
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
        transactionBinding: false,
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
        transactionBinding: false,
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
        transactionBinding: false,
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
        tokenExchange: false,
        jarm: false,
        deviceAuthorizationGrant: false,
        idJag: false,
        transactionBinding: false,
      });
    });
  });

  describe('validation errors', () => {
    it('should reject an unknown feature name in disable', () => {
      expect(() => resolveFeatures({ disable: ['dpop'] })).toThrow(
        'Unknown feature: "dpop". Available features: pkce, refresh-token, introspection, revocation, request-object. Optional features (disabled by default): transaction-binding. Experimental features (disabled by default): par',
      );
    });

    it('should reject an unknown feature name in enable', () => {
      expect(() => resolveFeatures({ enable: ['implicit'] })).toThrow(
        'Unknown feature: "implicit". Available features: pkce, refresh-token, introspection, revocation, request-object. Optional features (disabled by default): transaction-binding. Experimental features (disabled by default): par',
      );
    });

    it('should reject a feature listed in both enable and disable', () => {
      expect(() =>
        resolveFeatures({ enable: ['pkce'], disable: ['pkce'] }),
      ).toThrow('Feature "pkce" cannot be both enabled and disabled');
    });
  });

  describe('optional features', () => {
    it('should leave transaction-binding disabled by default', () => {
      expect(resolveFeatures({}).transactionBinding).toBe(false);
    });

    it('should enable transaction-binding when requested', () => {
      expect(resolveFeatures({ enable: ['transaction-binding'] })).toEqual({
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
        transactionBinding: true,
      });
    });

    it('should treat disabling an already-off optional feature as a no-op', () => {
      expect(resolveFeatures({ disable: ['transaction-binding'] }).transactionBinding).toBe(false);
    });
  });
});
