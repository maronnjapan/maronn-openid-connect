import {
  DeviceAuthorizationError,
  DeviceVerificationError,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingDeviceRecord } from '../../../../../test-support/browser-flows.js';
import { remainingTtlSeconds, verificationFailure } from './outcome.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('remainingTtlSeconds', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Rounded up so the binding cookie never expires before the record it binds.
  it('should round a partial second up', () => {
    const record = pendingDeviceRecord({ expiresAt: new Date(NOW.getTime() + 1_001) });

    expect(remainingTtlSeconds(record)).toBe(2);
  });

  it('should return 0 for a record that has already expired', () => {
    const record = pendingDeviceRecord({ expiresAt: new Date(NOW.getTime() - 5_000) });

    expect(remainingTtlSeconds(record)).toBe(0);
  });
});

describe('verificationFailure', () => {
  it('should turn a DeviceVerificationError into an error outcome with its status', () => {
    expect(verificationFailure(new DeviceVerificationError('Device verification binding is missing', 403))).toEqual({
      kind: 'error',
      error: 'Device verification binding is missing',
      statusCode: 403,
    });
  });

  it('should turn a DeviceAuthorizationError into a 400 error outcome with its description', () => {
    expect(
      verificationFailure(new DeviceAuthorizationError('invalid_grant', 'The code is invalid or has expired')),
    ).toEqual({ kind: 'error', error: 'The code is invalid or has expired', statusCode: 400 });
  });

  it('should rethrow any other error', () => {
    const error = new Error('store is down');

    expect(() => verificationFailure(error)).toThrow(error);
  });
});
