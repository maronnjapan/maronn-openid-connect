/**
 * EXPERIMENTAL — Pushed Authorization Requests (RFC 9126).
 *
 * This route was generated because the OP was created with `--enable par`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The client POSTs the authorization request parameters here (back channel,
 * authenticated) and receives a short-lived `request_uri` reference that it
 * then passes to /authorize.
 */
import { Hono } from 'hono';
import {
  ParError,
  assertParExpiresInSeconds,
  authenticateParClient,
  buildPushedAuthorizationResponse,
  createPushedAuthorizationRecord,
  rejectForbiddenParParams,
  validatePushedAuthorizationParams,
} from '@maronn-openid-connect/experimental/par';
import { sanitizeErrorDescription } from '@maronn-openid-connect/core';
import { clientResolver as defaultClientResolver } from '../resolvers.js';
import { parStore as defaultParStore } from '../store.js';

/**
 * PAR settings. Imported by the authorize route, so keep both files in sync when
 * changing them.
 *
 * - expiresInSeconds: request_uri lifetime. RFC 9126 §2.2 recommends 5–600
 *   seconds; values outside that range fail fast at module load.
 * - requirePushedAuthorizationRequests: RFC 9126 §5. When true, /authorize
 *   rejects any request that did not go through this endpoint, and discovery
 *   advertises require_pushed_authorization_requests: true.
 */
export const parConfig = {
  expiresInSeconds: 60,
  requirePushedAuthorizationRequests: false,
};

assertParExpiresInSeconds(parConfig.expiresInSeconds);

export const parApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * RFC 9126 §2.1: the pushed authorization request body MUST be
 * application/x-www-form-urlencoded.
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Pushed Authorization Request Endpoint
 * RFC 9126 §2
 *
 * NOTE (RFC 9126 §2.3): request size limits (413) and rate limiting (429) are
 * deliberately left to the deployment layer (reverse proxy / platform), not
 * implemented here. This endpoint is unauthenticated until the client
 * credentials are checked, so put a rate limit in front of it in production.
 */
parApp.post('/', async (c) => {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded' }, 400);
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
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated` }, 400);
  }

  const authorization = c.req.header('Authorization') ?? '';

  try {
    const clientResolver = c.get('clientResolver') ?? defaultClientResolver;
    const parStore = c.get('parStore') ?? defaultParStore;
    const config = c.get('config');

    // --- Pushed authorization request pipeline ------------------------------
    // Each step below is an independent function from @maronn-openid-connect/experimental/par,
    // called in RFC 9126 §2.1 order. Delete a call to drop that validation, or
    // insert your own logic between steps.

    // RFC 9126 §2.1: request_uri MUST NOT be pushed. The request parameter
    // (PAR + JAR, §3) is not supported by this generated provider.
    rejectForbiddenParParams(params);

    // RFC 9126 §2.1: authenticate exactly like the token endpoint does.
    // Public clients present only client_id (no credentials).
    const clientId = await authenticateParClient({
      params,
      authorizationHeader: authorization,
      clientResolver,
    });

    // client_id is a required authorization request parameter (RFC 9126 §2.1),
    // so pin it to the authenticated client before validating and storing.
    const pushedParams = { ...params, client_id: clientId };

    // RFC 9126 §2.1: "validate the request the same way the authorization
    // endpoint would" — an unregistered redirect_uri or a bad scope fails here,
    // before the user ever sees a screen.
    await validatePushedAuthorizationParams(pushedParams, clientResolver, {
      allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
    });

    // RFC 9126 §2.2 / §7.1: mint a cryptographically random reference value and
    // store the request under it. Client credentials are never persisted.
    const record = await createPushedAuthorizationRecord({
      clientId,
      params: pushedParams,
      store: parStore,
      expiresInSeconds: parConfig.expiresInSeconds,
    });
    const response = buildPushedAuthorizationResponse(record);

    // Never log the pushed parameters themselves: they can carry PII such as
    // login_hint, and the Authorization header carries the client_secret.

    // RFC 9126 §2.2: 201 Created with a non-cacheable JSON body.
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ request_uri: response.requestUri, expires_in: response.expiresIn }, 201);
  } catch (error) {
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    if (error instanceof ParError) {
      // RFC 9126 §2.3: token-endpoint style JSON errors. This endpoint never redirects.
      if (error.wwwAuthenticate) {
        c.header('WWW-Authenticate', error.wwwAuthenticate);
      }
      return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
