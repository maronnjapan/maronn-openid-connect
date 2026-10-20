import { describe, expect, it } from 'vitest';
import {
  defaultResponseModeOf,
  IMPLICIT_RESPONSE_TYPES,
  isImplicitResponseType,
  normalizeResponseType,
  responseTypeIncludes,
} from './response-type.js';

describe('IMPLICIT_RESPONSE_TYPES', () => {
  // OIDC Core 1.0 §3.2.2.1: the Implicit Flow uses id_token token or id_token.
  // token alone returns no ID Token, so OpenID Connect does not use it.
  it('should list id_token and id_token token', () => {
    expect(IMPLICIT_RESPONSE_TYPES).toEqual(['id_token', 'id_token token']);
  });
});

describe('normalizeResponseType', () => {
  // OAuth 2.0 Multiple Response Type Encoding Practices §1.2: the order of the
  // space-delimited values does not matter.
  describe('value order', () => {
    it('should put token after id_token', () => {
      expect(normalizeResponseType('token id_token')).toBe('id_token token');
    });

    it('should keep id_token token as it is', () => {
      expect(normalizeResponseType('id_token token')).toBe('id_token token');
    });

    it('should put code first', () => {
      expect(normalizeResponseType('token id_token code')).toBe('code id_token token');
    });

    it('should put values it does not know after code, id_token and token in code point order', () => {
      expect(normalizeResponseType('zeta token alpha')).toBe('token alpha zeta');
    });
  });

  describe('delimiters', () => {
    it('should drop the empty values of repeated, leading and trailing spaces', () => {
      expect(normalizeResponseType(' id_token  token ')).toBe('id_token token');
    });

    it('should return an empty string for a value of spaces only', () => {
      expect(normalizeResponseType('   ')).toBe('');
    });
  });

  // A repeated value makes no response type the OP knows, so it is kept for
  // the comparison to fail instead of being merged away.
  it('should keep a repeated value', () => {
    expect(normalizeResponseType('id_token id_token')).toBe('id_token id_token');
  });
});

describe('responseTypeIncludes', () => {
  it('should find a value in a multi-valued response type', () => {
    expect(responseTypeIncludes('id_token token', 'token')).toBe(true);
  });

  it('should find code in code', () => {
    expect(responseTypeIncludes('code', 'code')).toBe(true);
  });

  it('should not find code in the Implicit Flow response types', () => {
    expect([
      responseTypeIncludes('id_token', 'code'),
      responseTypeIncludes('id_token token', 'code'),
    ]).toEqual([false, false]);
  });

  it('should not match a value that only contains the searched one', () => {
    expect(responseTypeIncludes('id_token', 'token')).toBe(false);
  });

  it('should return false without a response type', () => {
    expect(responseTypeIncludes(undefined, 'code')).toBe(false);
  });
});

describe('isImplicitResponseType', () => {
  it('should accept id_token and id_token token', () => {
    expect([isImplicitResponseType('id_token'), isImplicitResponseType('id_token token')]).toEqual([
      true,
      true,
    ]);
  });

  it('should accept the values in any order', () => {
    expect(isImplicitResponseType('token id_token')).toBe(true);
  });

  it('should reject code, token alone and the hybrid response types', () => {
    expect([
      isImplicitResponseType('code'),
      isImplicitResponseType('token'),
      isImplicitResponseType('code id_token'),
      isImplicitResponseType('code id_token token'),
    ]).toEqual([false, false, false, false]);
  });

  it('should reject a missing response type', () => {
    expect(isImplicitResponseType(undefined)).toBe(false);
  });
});

describe('defaultResponseModeOf', () => {
  // OAuth 2.0 Multiple Response Type Encoding Practices §2.1.
  it('should answer code in the query', () => {
    expect(defaultResponseModeOf('code')).toBe('query');
  });

  // Multiple Response Type Encoding Practices §3 / §5: the fragment, and never the query.
  it('should answer the response types that return an ID Token or an access token in the fragment', () => {
    expect([
      defaultResponseModeOf('id_token'),
      defaultResponseModeOf('id_token token'),
      defaultResponseModeOf('token'),
      defaultResponseModeOf('code id_token'),
    ]).toEqual(['fragment', 'fragment', 'fragment', 'fragment']);
  });

  it('should answer a response type it does not know in the query', () => {
    expect(defaultResponseModeOf('unknown')).toBe('query');
  });
});
