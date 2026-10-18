import { describe, expect, it } from 'vitest';
import { KEY_PREFIX, keys } from './keys';

describe('keys', () => {
  it('should name every key KEY_PREFIX, the entity and its parts, separated by colons', () => {
    expect(KEY_PREFIX).toBe('oidc:');
    expect({
      client: keys.client('rp-1'),
      clientJwks: keys.clientJwks('rp-1', 'request_object'),
      user: keys.user('alice'),
      federatedIdentity: keys.federatedIdentity('google', 'sub-1'),
      transaction: keys.transaction('txn-1'),
      transactionResult: keys.transactionResult('txn-1'),
      authUser: keys.authUser('txn-1'),
      upstreamAuthRequest: keys.upstreamAuthRequest('txn-1'),
      upstreamNonce: keys.upstreamNonce('nonce-1'),
      code: keys.code('code-hash'),
      codeUsed: keys.codeUsed('code-hash'),
      accessToken: keys.accessToken('token-hash'),
      refreshToken: keys.refreshToken('token-hash'),
      refreshTokenUsed: keys.refreshTokenUsed('token-hash'),
      grant: keys.grant('grant-1'),
      grantAccessTokensRevoked: keys.grantAccessTokensRevoked('grant-1'),
      grantRefreshTokensRevoked: keys.grantRefreshTokensRevoked('grant-1'),
      browserSession: keys.browserSession('session-1'),
      consent: keys.consent('alice', 'rp-1'),
    }).toEqual({
      client: 'oidc:client:rp-1',
      clientJwks: 'oidc:client_jwks:rp-1:request_object',
      user: 'oidc:user:alice',
      federatedIdentity: 'oidc:federated_identity:google:sub-1',
      transaction: 'oidc:transaction:txn-1',
      transactionResult: 'oidc:transaction_result:txn-1',
      authUser: 'oidc:auth_user:txn-1',
      upstreamAuthRequest: 'oidc:upstream_auth_request:txn-1',
      upstreamNonce: 'oidc:upstream_nonce:nonce-1',
      code: 'oidc:code:code-hash',
      codeUsed: 'oidc:code_used:code-hash',
      accessToken: 'oidc:access_token:token-hash',
      refreshToken: 'oidc:refresh_token:token-hash',
      refreshTokenUsed: 'oidc:refresh_token_used:token-hash',
      grant: 'oidc:grant:grant-1',
      grantAccessTokensRevoked: 'oidc:grant_access_tokens_revoked:grant-1',
      grantRefreshTokensRevoked: 'oidc:grant_refresh_tokens_revoked:grant-1',
      browserSession: 'oidc:browser_session:session-1',
      consent: 'oidc:consent:alice:rp-1',
    });
  });

  // A value from a request is URI-encoded, so a colon in it cannot reach into another key.
  it('should URI-encode each part so a colon in a value cannot reach into another key', () => {
    expect(keys.consent('alice:rp-1', 'x')).toBe('oidc:consent:alice%3Arp-1:x');
    expect(keys.consent('alice', 'rp-1:x')).toBe('oidc:consent:alice:rp-1%3Ax');
    expect(keys.federatedIdentity('google', 'a b/c')).toBe('oidc:federated_identity:google:a%20b%2Fc');
  });
});
