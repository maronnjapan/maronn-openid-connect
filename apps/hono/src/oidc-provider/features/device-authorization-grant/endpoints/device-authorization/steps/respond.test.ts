import { describe, expect, it } from 'vitest';
import { pendingDeviceRecord } from '../../../../../../test-support/browser-flows.js';
import { contextOf, TEST_ISSUER } from '../../../../../../test-support/context.js';
import { respondDeviceAuthorization } from './respond.js';

function recordFor() {
  return pendingDeviceRecord({
    deviceCode: 'device-code-1',
    userCode: 'WDJBMJHT',
    userCodeDisplay: 'WDJB-MJHT',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-01-01T00:10:00.000Z'),
    interval: 5,
  });
}

describe('respondDeviceAuthorization', () => {
  // RFC 8628 §3.2: the device authorization response.
  it('should answer 200 with the device authorization response of the issuer', async () => {
    const c = contextOf(undefined, { config: { issuer: TEST_ISSUER } });

    const response = respondDeviceAuthorization(c, recordFor());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      device_code: 'device-code-1',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://op.example.com/device',
      verification_uri_complete: 'https://op.example.com/device?user_code=WDJB-MJHT',
      expires_in: 600,
      interval: 5,
    });
  });

  // RFC 6749 §5.1: device_code is a credential, so the response must not be cached.
  it('should mark the response no-store', () => {
    const c = contextOf(undefined, { config: { issuer: TEST_ISSUER } });

    const response = respondDeviceAuthorization(c, recordFor());

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
  });
});
