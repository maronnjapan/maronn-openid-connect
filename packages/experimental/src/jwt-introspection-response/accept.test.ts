import { describe, expect, it } from 'vitest';
import { TOKEN_INTROSPECTION_JWT_MEDIA_TYPE, acceptsIntrospectionJwt } from './accept.js';

describe('acceptsIntrospectionJwt', () => {
  describe('Explicit media type (RFC 9701 §4)', () => {
    it('should return true for the exact media type', () => {
      expect(acceptsIntrospectionJwt('application/token-introspection+jwt')).toBe(true);
    });

    it('should match the media type case-insensitively', () => {
      expect(acceptsIntrospectionJwt('Application/Token-Introspection+JWT')).toBe(true);
    });

    it('should match the media type inside a multi-element Accept header', () => {
      expect(
        acceptsIntrospectionJwt('application/json, application/token-introspection+jwt'),
      ).toBe(true);
    });

    it('should ignore media type parameters such as a q value', () => {
      expect(acceptsIntrospectionJwt('application/token-introspection+jwt;q=0.9')).toBe(true);
    });

    it('should tolerate surrounding whitespace around list elements', () => {
      expect(
        acceptsIntrospectionJwt('application/json ,  application/token-introspection+jwt '),
      ).toBe(true);
    });
  });

  describe('Requests that stay on the RFC 7662 JSON path', () => {
    it('should return false for a missing header', () => {
      expect(acceptsIntrospectionJwt(undefined)).toBe(false);
    });

    it('should return false for a null header', () => {
      expect(acceptsIntrospectionJwt(null)).toBe(false);
    });

    it('should return false for an empty header', () => {
      expect(acceptsIntrospectionJwt('')).toBe(false);
    });

    it('should return false for application/json', () => {
      expect(acceptsIntrospectionJwt('application/json')).toBe(false);
    });

    // A generic HTTP client's default Accept must not flip the response format:
    // only the explicitly named RFC 9701 media type requests the JWT.
    it('should return false for the full wildcard', () => {
      expect(acceptsIntrospectionJwt('*/*')).toBe(false);
    });

    it('should return false for the application type wildcard', () => {
      expect(acceptsIntrospectionJwt('application/*')).toBe(false);
    });

    it('should return false for an unrelated jwt-suffixed media type', () => {
      expect(acceptsIntrospectionJwt('application/jwt')).toBe(false);
    });
  });

  describe('Media type constant', () => {
    it('should expose the RFC 9701 media type verbatim', () => {
      expect(TOKEN_INTROSPECTION_JWT_MEDIA_TYPE).toBe('application/token-introspection+jwt');
    });
  });
});
