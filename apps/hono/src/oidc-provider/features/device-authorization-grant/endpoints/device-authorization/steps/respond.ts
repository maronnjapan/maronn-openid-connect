import {
  type DeviceAuthorizationRecord,
  buildDeviceAuthorizationResponse,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { noStore } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'device-authorization',
  feature: 'device-authorization-grant',
  kind: 'respond',
  label: 'Respond with the device authorization response (no-store)',
  spec: 'RFC 8628 §3.2',
  function: 'respondDeviceAuthorization',
  calls: ['buildDeviceAuthorizationResponse'],
  consumes: ['record'],
  produces: [],
  removable: false,
});

/**
 * RFC 8628 §3.2: the device authorization response. §3.2 has no explicit
 * caching rule, but device_code is a credential, so the response follows the
 * token response rules of RFC 6749 §5.1 (no-store).
 */
export function respondDeviceAuthorization(c: any, record: DeviceAuthorizationRecord): Response {
  const config = c.get('config');
  noStore(c);
  return c.json(buildDeviceAuthorizationResponse(record, config.issuer));
}
