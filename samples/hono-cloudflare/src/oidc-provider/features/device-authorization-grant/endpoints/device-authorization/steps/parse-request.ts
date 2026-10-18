import { sanitizeErrorDescription } from '@maronn-openid-connect/core';
import { DeviceAuthorizationEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'parse-request',
  endpoint: 'device-authorization',
  feature: 'device-authorization-grant',
  kind: 'parse',
  label: 'Parse the device authorization request',
  spec: 'RFC 8628 §3.1',
  function: 'parseDeviceAuthorizationRequest',
  consumes: [],
  produces: ['params', 'authorization'],
  removable: false,
});

/**
 * RFC 8628 §3.1: the device authorization request body MUST be
 * application/x-www-form-urlencoded (it follows RFC 6749 §3.2.1).
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Parse the device authorization request: the form body and the
 * Authorization header. RFC 8628 §3.1 / RFC 6749 §3.1
 */
export async function parseDeviceAuthorizationRequest(
  c: any,
): Promise<{ params: Record<string, string>; authorization: string }> {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    throw new DeviceAuthorizationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Device authorization requests must use application/x-www-form-urlencoded' },
    });
  }

  // RFC 6749 §3.1: request parameters MUST NOT be repeated. Read the raw body so
  // URLSearchParams iteration exposes duplicates instead of silently keeping the last.
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    params[key] = value;
  }

  if (duplicateKey !== undefined) {
    throw new DeviceAuthorizationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated` },
    });
  }

  const authorization = c.req.header('Authorization') ?? '';
  return { params, authorization };
}
