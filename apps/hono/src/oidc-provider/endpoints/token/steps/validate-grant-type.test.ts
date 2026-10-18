import { TokenError, type TokenClientInfo, type TokenRequestParams } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { validateTokenGrantType } from './validate-grant-type.js';

const client: TokenClientInfo = {
  clientId: 'client-1',
  clientType: 'confidential',
  grantTypes: ['authorization_code'],
  tokenEndpointAuthMethods: ['client_secret_post'],
};

function paramsWith(grantType: string): TokenRequestParams {
  return { grant_type: grantType } as TokenRequestParams;
}

describe('validateTokenGrantType', () => {
  it('should return authorization_code for a client registered for it', () => {
    expect(validateTokenGrantType(paramsWith('authorization_code'), client)).toBe('authorization_code');
  });

  // RFC 6749 §5.2: a grant the OP offers but the client is not registered for.
  it('should reject refresh_token with unauthorized_client for a client registered only for authorization_code', () => {
    expect(() => validateTokenGrantType(paramsWith('refresh_token'), client)).toThrow(
      expect.objectContaining({ error: 'unauthorized_client' }),
    );
  });

  // RFC 6749 §5.2: a grant this OP does not offer at all.
  it('should reject an unknown grant_type with unsupported_grant_type', () => {
    expect(() => validateTokenGrantType(paramsWith('password'), client)).toThrow(TokenError);
    expect(() => validateTokenGrantType(paramsWith('password'), client)).toThrow(
      expect.objectContaining({ error: 'unsupported_grant_type' }),
    );
  });
});
