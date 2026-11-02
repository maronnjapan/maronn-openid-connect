import { UserInfoEndpointError } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'parse-access-token',
  endpoint: 'userinfo',
  kind: 'parse',
  label: 'Read the Bearer token',
  spec: 'RFC 6750 §2.1 / §2.2',
  function: 'parseUserInfoRequest',
  consumes: [],
  produces: ['accessToken'],
  removable: false,
});

/**
 * Read the access token from the request, supporting:
 * - Authorization: Bearer header (RFC 6750 Section 2.1, REQUIRED)
 * - access_token form body parameter on POST (RFC 6750 Section 2.2, OPTIONAL)
 *
 * Per RFC 6750 Section 2, clients MUST NOT use more than one method per request.
 * URL query parameter (Section 2.3) is intentionally NOT supported (OAuth 2.1 prohibits it).
 * A request without a token is answered 401 with the realm-only challenge of
 * RFC 6750 §3.1; one that uses two methods is answered 400.
 */
export async function parseUserInfoRequest(c: any): Promise<string> {
  let headerToken = '';
  let bodyToken = '';
  try {
    headerToken = readBearerToken(c.req.header('Authorization') ?? '');

    if (c.req.method === 'POST') {
      const contentType = c.req.header('Content-Type') ?? '';
      const mediaType = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
      if (mediaType === 'application/x-www-form-urlencoded') {
        // Parse the form payload ourselves after media-type normalization. Hono's
        // parseBody() dispatch is case-sensitive for some Content-Type spellings.
        const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
        const candidate = body['access_token'];
        if (typeof candidate === 'string') {
          bodyToken = candidate;
        }
      }
    }
  } catch {
    throw new UserInfoEndpointError({ status: 400, body: { error: 'invalid_request' } });
  }

  const methodCount = (headerToken ? 1 : 0) + (bodyToken ? 1 : 0);
  if (methodCount > 1) {
    // RFC 6750 Section 2: clients MUST NOT use more than one method per request.
    throw new UserInfoEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
      headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo", error="invalid_request"' },
    });
  }
  const accessToken = headerToken || bodyToken;
  if (!accessToken) {
    // RFC 6750 §3.1: when the request has no authentication information, the
    // challenge omits error/error_description and only identifies the realm.
    throw new UserInfoEndpointError({
      status: 401,
      body: { error: 'invalid_token', error_description: 'Access token is required' },
      headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo"' },
    });
  }
  return accessToken;
}

/**
 * Return the token of an Authorization header value of the Bearer scheme, or
 * '' for another scheme or a Bearer value without a token. The scheme matches
 * without regard to case (RFC 7235 §2.1), every space after it is skipped
 * (`"Bearer" 1*SP b64token`), and the token is kept as it is.
 *
 * @spec RFC 6750 §2.1
 */
function readBearerToken(authorizationHeader: string): string {
  return /^Bearer +(.*)$/i.exec(authorizationHeader)?.[1] ?? '';
}
