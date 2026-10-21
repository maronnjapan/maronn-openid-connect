import { RegistrationEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'parse-request',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'parse',
  label: 'Read the JSON metadata',
  spec: 'RFC 7591 §3.1',
  function: 'parseRegistrationRequest',
  consumes: [],
  produces: ['rawBody'],
  removable: false,
});

/**
 * RFC 7591 §3.1: the registration request body MUST be application/json.
 */
function isJson(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/json';
}

/**
 * RFC 7591 §3.1: the registration request body MUST be application/json
 * (parameters such as charset are fine). Enforcing the media type also closes
 * the cross-origin text/plain form post that can synthesize a JSON-shaped body
 * without a CORS preflight.
 *
 * A Content-Length that already declares more than maxRegistrationBodyBytes is
 * refused before the body is read, so an oversized request is not buffered
 * first. The header can lie, so the authoritative check stays the UTF-8 byte
 * count on the body itself (validateClientRegistrationRequest).
 */
export async function parseRegistrationRequest(c: any): Promise<string> {
  if (!isJson(c.req.header('Content-Type') ?? '')) {
    throw new RegistrationEndpointError({
      status: 400,
      body: { error: 'invalid_client_metadata', error_description: 'registration requests must use application/json' },
    });
  }
  const config = c.get('dynamicClientRegistrationConfig');
  const declaredLength = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > config.maxRegistrationBodyBytes) {
    throw new RegistrationEndpointError({
      status: 400,
      body: { error: 'invalid_client_metadata', error_description: 'request body must not exceed the configured maximum size' },
    });
  }
  return c.req.text();
}
