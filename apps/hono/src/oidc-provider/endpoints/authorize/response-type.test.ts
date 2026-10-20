import { describe, expect, it } from 'vitest';
import { implicitResponseTypeHandler } from '../../features/implicit-flow/response-type.js';
import { responseTypeHandlerOf, supportedResponseTypes } from './response-type.js';

describe('supportedResponseTypes', () => {
  // OIDC Discovery 1.0 §3: code, then the response types of the enabled features.
  it('should return code followed by the response types of the Implicit Flow and of the Hybrid Flow', () => {
    expect(supportedResponseTypes()).toEqual([
      'code',
      'id_token',
      'id_token token',
      'code id_token',
      'code token',
      'code id_token token',
    ]);
  });
});

describe('responseTypeHandlerOf', () => {
  it('should return the handler of the feature that answers the response type', () => {
    expect(responseTypeHandlerOf('id_token')).toBe(implicitResponseTypeHandler);
    expect(responseTypeHandlerOf('id_token token')).toBe(implicitResponseTypeHandler);
  });

  // The provider answers code itself; core's normalizeResponseType() writes
  // the values a handler is looked up by.
  it('should return undefined for code and for a value that is not normalized', () => {
    expect(responseTypeHandlerOf('code')).toBeUndefined();
    expect(responseTypeHandlerOf('token id_token')).toBeUndefined();
  });
});
