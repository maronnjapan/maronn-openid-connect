import { BackchannelAuthenticationError } from '@maronn-openid-connect/experimental/ciba';
import { describe, expect, it } from 'vitest';
import { validateCibaClientScope } from './validate-client-scope.js';

describe('validateCibaClientScope', () => {
  // RFC 7591 §2: a client registered with a scope list may request those scopes.
  it('should accept a scope within the client registration', () => {
    expect(
      validateCibaClientScope({ scope: 'openid  email' }, { clientId: 'ciba-client', scope: ['openid', 'email'] }),
    ).toBeUndefined();
  });

  it('should accept any scope for a client registered without a scope list', () => {
    expect(validateCibaClientScope({ scope: 'openid phone' }, { clientId: 'ciba-client' })).toBeUndefined();
  });

  it('should leave a request without scope to the later scope validation', () => {
    expect(validateCibaClientScope({}, { clientId: 'ciba-client', scope: ['openid'] })).toBeUndefined();
  });

  // RFC 7591 §2 / RFC 6749 §3.3: invalid_scope listing every scope outside the registration.
  it('should reject scopes outside the client registration with invalid_scope listing them', () => {
    const validate = () =>
      validateCibaClientScope({ scope: 'openid email phone' }, { clientId: 'ciba-client', scope: ['openid'] });

    expect(validate).toThrow(BackchannelAuthenticationError);
    expect(validate).toThrow(
      expect.objectContaining({
        code: 'invalid_scope',
        errorDescription: 'Client is not registered for scope: email phone',
      }),
    );
  });
});
