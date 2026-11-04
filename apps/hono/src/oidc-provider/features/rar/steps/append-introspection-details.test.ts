import type { ResolvedIntrospectionToken } from '@maronn-openid-connect/core';
import { createInMemoryRarDetailsStore } from '@maronn-openid-connect/experimental/rar';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { appendAuthorizationDetailsToIntrospection } from './append-introspection-details.js';

const DETAILS = [{ type: 'payment_initiation', actions: ['initiate'] }] as const;

const NOW = Math.floor(Date.now() / 1000);

function accessTokenOf(grantId: string): ResolvedIntrospectionToken {
  return {
    tokenType: 'access_token',
    accessToken: {
      sub: 'user-1',
      clientId: 'client-1',
      scope: ['openid'],
      expiresAt: NOW + 3600,
      grantId,
    },
  } as ResolvedIntrospectionToken;
}

function refreshTokenOf(grantId: string): ResolvedIntrospectionToken {
  return {
    tokenType: 'refresh_token',
    refreshToken: {
      subject: 'user-1',
      clientId: 'client-1',
      scope: ['openid'],
      expiresAt: NOW + 3600,
      grantId,
    },
  } as ResolvedIntrospectionToken;
}

describe('appendAuthorizationDetailsToIntrospection', () => {
  it('should add authorization_details as a top-level member for an access token with details', async () => {
    const rarGrantStore = createInMemoryRarDetailsStore();
    await rarGrantStore.set('grant-1', DETAILS);
    const c = contextOf(undefined, { rarGrantStore });

    const appended = await appendAuthorizationDetailsToIntrospection(
      c,
      { active: true, client_id: 'client-1', scope: 'openid' },
      accessTokenOf('grant-1'),
    );

    expect(appended).toEqual({
      active: true,
      client_id: 'client-1',
      scope: 'openid',
      authorization_details: DETAILS,
    });
  });

  it('should resolve the grant of a refresh token the same way', async () => {
    const rarGrantStore = createInMemoryRarDetailsStore();
    await rarGrantStore.set('grant-1', DETAILS);
    const c = contextOf(undefined, { rarGrantStore });

    const appended = await appendAuthorizationDetailsToIntrospection(
      c,
      { active: true, client_id: 'client-1' },
      refreshTokenOf('grant-1'),
    );

    expect(appended).toEqual({ active: true, client_id: 'client-1', authorization_details: DETAILS });
  });

  it('should return the response unchanged for a grant without details', async () => {
    const c = contextOf(undefined, { rarGrantStore: createInMemoryRarDetailsStore() });
    const response = { active: true as const, client_id: 'client-1' };

    expect(await appendAuthorizationDetailsToIntrospection(c, response, accessTokenOf('grant-2'))).toBe(response);
  });

  it('should keep an inactive response as { active: false } only', async () => {
    const rarGrantStore = createInMemoryRarDetailsStore();
    await rarGrantStore.set('grant-1', DETAILS);
    const c = contextOf(undefined, { rarGrantStore });
    const inactive = { active: false as const };

    expect(await appendAuthorizationDetailsToIntrospection(c, inactive, null)).toBe(inactive);
  });
});
