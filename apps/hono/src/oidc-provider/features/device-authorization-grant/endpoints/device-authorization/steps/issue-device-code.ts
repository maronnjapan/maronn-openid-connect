import type { TokenClientInfo } from '@maronn-openid-connect/core';
import {
  createDeviceAuthorizationRecord,
  type DeviceAuthorizationRecord,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { step } from '../../../../../endpoints/step.js';
import { deviceAuthorizationConfig } from '../../../config.js';

export const meta = step({
  id: 'issue-device-code',
  endpoint: 'device-authorization',
  feature: 'device-authorization-grant',
  kind: 'issue',
  label: 'Mint the device_code and user_code',
  spec: 'RFC 8628 §3.2 / §5.2',
  function: 'issueDeviceCodes',
  calls: ['createDeviceAuthorizationRecord'],
  consumes: ['client', 'scope'],
  produces: ['record'],
  removable: false,
});

/**
 * RFC 8628 §3.2 / §5.2: mint a 256-bit device_code and a collision-checked
 * base-20 user_code, then store the pending record under both.
 *
 * Never log device_code or user_code: both are live credentials for the
 * lifetime of the record (RFC 8628 §5.1 / §5.2).
 */
export async function issueDeviceCodes(
  c: any,
  client: TokenClientInfo,
  scope: string[],
): Promise<DeviceAuthorizationRecord> {
  const deviceStore = c.get('deviceAuthorizationStore');
  return createDeviceAuthorizationRecord({
    clientId: client.clientId,
    scope,
    store: deviceStore,
    expiresIn: deviceAuthorizationConfig.deviceCodeExpiresIn,
    interval: deviceAuthorizationConfig.pollInterval,
  });
}
