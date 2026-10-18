import type { AccessTokenInfo } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { registerUser } from '../../../db/memory/users.js';
import { resolveUserInfoResponseClaims } from './resolve-claims.js';

function tokenInfo(overrides: Partial<AccessTokenInfo> = {}): AccessTokenInfo {
  return { sub: 'alice', scope: ['openid'], clientId: 'client-1', expiresAt: 0, ...overrides };
}

async function contextWithAlice() {
  const { c, db } = await providerContext();
  await registerUser(db, {
    sub: 'alice',
    name: 'Alice Example',
    email: 'alice@example.com',
    email_verified: true,
    phone_number: '+81-3-0000-0000',
  });
  return c;
}

describe('resolveUserInfoResponseClaims', () => {
  // OIDC Core 1.0 §5.4: the email scope releases email and email_verified.
  it('should return sub and the claims of the granted scopes only', async () => {
    const c = await contextWithAlice();

    expect(await resolveUserInfoResponseClaims(c, tokenInfo({ scope: ['openid', 'email'] }))).toEqual({
      sub: 'alice',
      email: 'alice@example.com',
      email_verified: true,
    });
  });

  // OIDC Core 1.0 §5.5: claims.userinfo members are returned independently of scope.
  it('should add the individually requested claims stored with the token', async () => {
    const c = await contextWithAlice();

    const claims = await resolveUserInfoResponseClaims(
      c,
      tokenInfo({ claims: { userinfo: { name: null, phone_number: { essential: true } } } }),
    );

    expect(claims).toEqual({ sub: 'alice', name: 'Alice Example', phone_number: '+81-3-0000-0000' });
  });

  // OIDC Core 1.0 §5.5.1: a claim whose value does not match the requested value is omitted.
  it('should omit a requested claim whose value does not match the requested value', async () => {
    const c = await contextWithAlice();

    const claims = await resolveUserInfoResponseClaims(
      c,
      tokenInfo({ claims: { userinfo: { name: { value: 'Someone Else' } } } }),
    );

    expect(claims).toEqual({ sub: 'alice' });
  });

  it('should reject a token whose subject has no user with invalid_token', async () => {
    const { c } = await providerContext();

    await expect(resolveUserInfoResponseClaims(c, tokenInfo({ sub: 'deleted-user' }))).rejects.toMatchObject({
      error: 'invalid_token',
      errorDescription: 'User not found for the given access token',
    });
  });
});
