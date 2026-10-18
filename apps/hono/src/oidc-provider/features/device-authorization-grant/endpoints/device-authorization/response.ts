/**
 * What the device authorization endpoint answers, and the failure a step
 * answers with a fixed response.
 */

/** What the device authorization endpoint answers; respondDeviceAuthorization() turns it into HTTP. */
export interface DeviceAuthorizationEndpointResponse {
  status: number;
  body: object;
  headers?: Record<string, string>;
}

/** A failure a step answers with a fixed response (a malformed request). */
export class DeviceAuthorizationEndpointError extends Error {
  constructor(readonly response: DeviceAuthorizationEndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'device authorization endpoint error'));
    this.name = 'DeviceAuthorizationEndpointError';
  }
}

export function noStore(c: any): void {
  // RFC 8628 §3.2 has no explicit rule, but device_code is a credential, so the
  // response follows the token response rules of RFC 6749 §5.1.
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}
