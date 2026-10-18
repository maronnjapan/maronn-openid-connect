import { sanitizeErrorDescription } from '@maronn-openid-connect/core';
import { BackchannelAuthenticationEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'parse-request',
  endpoint: 'backchannel-authentication',
  feature: 'ciba',
  kind: 'parse',
  label: 'Parse the backchannel authentication request',
  spec: 'CIBA Core 1.0 §7.1',
  function: 'parseBackchannelAuthenticationRequest',
  consumes: [],
  produces: ['params', 'authorization'],
  removable: false,
});

/**
 * CIBA §7.1: the backchannel authentication request body MUST be
 * application/x-www-form-urlencoded.
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Parse the backchannel authentication request: the form body and the
 * Authorization header. CIBA Core 1.0 §7.1 / RFC 6749 §3.1
 */
export async function parseBackchannelAuthenticationRequest(
  c: any,
): Promise<{ params: Record<string, string>; authorization: string }> {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    throw new BackchannelAuthenticationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Backchannel authentication requests must use application/x-www-form-urlencoded' },
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
    throw new BackchannelAuthenticationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated` },
    });
  }

  const authorization = c.req.header('Authorization') ?? '';
  return { params, authorization };
}
