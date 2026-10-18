/**
 * Records the tests of the stores and resolvers start from.
 */
import type { AccessTokenInfo, RefreshTokenInfo } from '@maronn-openid-connect/core';
import type { CibaAuthenticationRequestRecord } from '@maronn-openid-connect/experimental/ciba';
import type { DeviceAuthorizationRecord } from '@maronn-openid-connect/experimental/device-authorization-grant';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A pending device authorization record (RFC 8628 §3.2) that expires in 600 seconds. */
export function pendingDeviceRecord(overrides: Partial<DeviceAuthorizationRecord> = {}): DeviceAuthorizationRecord {
  const now = Date.now();
  return {
    deviceCode: 'device-code-' + crypto.randomUUID(),
    userCode: 'BCDFGHJK',
    userCodeDisplay: 'BCDF-GHJK',
    clientId: 'device-client',
    scope: ['openid', 'profile'],
    status: 'pending',
    createdAt: new Date(now),
    expiresAt: new Date(now + 600_000),
    interval: 5,
    lastPolledAt: null,
    csrfToken: null,
    bindingHash: null,
    loginAttempts: 0,
    ...overrides,
  };
}

/** A pending CIBA authentication request for alice (CIBA Core 1.0 §7.3) that expires in 120 seconds. */
export function pendingCibaRecord(
  overrides: Partial<CibaAuthenticationRequestRecord> = {},
): CibaAuthenticationRequestRecord {
  const now = Date.now();
  return {
    authReqId: 'auth-req-' + crypto.randomUUID(),
    clientId: 'ciba-client',
    subject: 'alice',
    scope: ['openid', 'profile'],
    status: 'pending',
    createdAt: new Date(now),
    expiresAt: new Date(now + 120_000),
    interval: 5,
    lastPolledAt: null,
    csrfToken: null,
    ...overrides,
  };
}

/** An access token record, valid for an hour unless overridden. */
export function accessTokenInfo(overrides: Partial<AccessTokenInfo> = {}): AccessTokenInfo {
  return {
    sub: 'user-1',
    scope: ['openid'],
    clientId: 'client-1',
    expiresAt: nowSeconds() + 3600,
    ...overrides,
  };
}

/** An unused refresh token record, valid for an hour unless overridden. */
export function refreshTokenInfo(overrides: Partial<RefreshTokenInfo> = {}): RefreshTokenInfo {
  const now = nowSeconds();
  return {
    subject: 'user-1',
    clientId: 'client-1',
    scope: ['openid'],
    expiresAt: now + 3600,
    used: false,
    grantId: 'grant-1',
    originalIssuedAt: now,
    authTime: now,
    ...overrides,
  };
}
