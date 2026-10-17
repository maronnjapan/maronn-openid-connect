import { Hono } from 'hono';
import { sanitizeErrorDescription } from '@maronn-openid-connect/core';
import { clientResolver as defaultClientResolver } from '../resolvers.js';
import { parStore as defaultParStore } from '../store.js';
import {
  assertParExpiresInSeconds,
  authenticateParClient,
  rejectForbiddenParParams,
  validatePushedAuthorizationParams,
  buildPushedAuthorizationResponse,
  createPushedAuthorizationRecord,
  ParError,
} from '@maronn-openid-connect/experimental/par';
import { verifyPrivateKeyJwt } from '../client-auth.js';

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
 * then passes to /authorize. Every function exported below is one box of the
 * endpoint's pipeline (`maronn-oidc graph --detail steps --endpoint par`).
 *
 * NOTE (RFC 9126 §2.3): request size limits (413) and rate limiting (429) are
 * deliberately left to the deployment layer (reverse proxy / platform), not
 * implemented here. This endpoint is unauthenticated until the client
 * credentials are checked, so put a rate limit in front of it in production.
 */

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

/** What the pushed authorization request endpoint answers; respondPar() turns it into HTTP. */
export interface ParEndpointResponse {
  status: number;
  body: object;
  headers?: Record<string, string>;
}

/** A failure a step answers with a fixed response (a malformed request). */
export class ParEndpointError extends Error {
  constructor(readonly response: ParEndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'pushed authorization request endpoint error'));
    this.name = 'ParEndpointError';
  }
}

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
 * Parse the pushed authorization request: the form body and the Authorization
 * header. RFC 9126 §2.1 / RFC 6749 §3.1
 */
export async function parsePushedAuthorizationRequest(
  c: any,
): Promise<{ params: Record<string, string>; authorization: string }> {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    throw new ParEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded' },
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
    throw new ParEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated` },
    });
  }

  const authorization = c.req.header('Authorization') ?? '';
  return { params, authorization };
}

/**
 * Authenticate the pushing client exactly like the token endpoint does
 * (public clients present only client_id), after refusing the parameters a
 * pushed request must not carry. RFC 9126 §2.1
 *
 * client_id is a required authorization request parameter, so the pushed
 * parameters are pinned to the authenticated client before validation.
 */
export async function authenticatePushingClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<{ clientId: string; pushedParams: Record<string, string> }> {
  const clientResolver = c.get('clientResolver') ?? defaultClientResolver;

  // RFC 9126 §2.1: request_uri MUST NOT be pushed. The request parameter
  // (PAR + JAR, §3) is not supported by this generated provider.
  rejectForbiddenParParams(params);

  const clientId = await authenticateParClient({
    params,
    authorizationHeader: authorization,
    clientResolver,
    // OIDC Core 1.0 §9: private_key_jwt, checked like the token endpoint does.
    verifyClientAssertion: (client, clientAssertion) =>
      verifyPrivateKeyJwt(c, client, { clientAssertion }, '/par'),
  });

  return { clientId, pushedParams: { ...params, client_id: clientId } };
}

/**
 * RFC 9126 §2.1: "validate the request the same way the authorization
 * endpoint would" — an unregistered redirect_uri or a bad scope fails here,
 * before the user ever sees a screen.
 */
export async function validatePushedRequest(c: any, pushedParams: Record<string, string>): Promise<void> {
  const clientResolver = c.get('clientResolver') ?? defaultClientResolver;
  const config = c.get('config');
  await validatePushedAuthorizationParams(pushedParams, clientResolver, {
    allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
  });
}

/**
 * RFC 9126 §2.2 / §7.1: mint a cryptographically random reference value and
 * store the request under it. Client credentials are never persisted.
 */
export async function storePushedRequest(
  c: any,
  clientId: string,
  pushedParams: Record<string, string>,
): Promise<ParEndpointResponse> {
  const parStore = c.get('parStore') ?? defaultParStore;
  const record = await createPushedAuthorizationRecord({
    clientId,
    params: pushedParams,
    store: parStore,
    expiresInSeconds: parConfig.expiresInSeconds,
  });
  const response = buildPushedAuthorizationResponse(record);

  // Never log the pushed parameters themselves: they can carry PII such as
  // login_hint, and the Authorization header carries the client_secret.

  // RFC 9126 §2.2: 201 Created.
  return { status: 201, body: { request_uri: response.requestUri, expires_in: response.expiresIn } };
}

/** RFC 9126 §2.2: a non-cacheable JSON body. */
export function respondPar(c: any, response: ParEndpointResponse): Response {
  c.header('Cache-Control', 'no-cache, no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  return c.json(response.body, response.status);
}

/**
 * RFC 9126 §2.3: token-endpoint style JSON errors. This endpoint never redirects.
 */
export function respondParError(c: any, error: unknown): Response {
  if (error instanceof ParEndpointError) {
    return respondPar(c, error.response);
  }
  if (error instanceof ParError) {
    return respondPar(c, {
      status: error.statusCode,
      body: { error: error.code, error_description: error.errorDescription },
      headers: error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
    });
  }
  return respondPar(c, { status: 500, body: { error: 'server_error' } });
}

/**
 * Pushed Authorization Request Endpoint
 * RFC 9126 §2
 */
parApp.post('/', async (c) => {
  try {
    // [parse-request] Parse the pushed authorization request — RFC 9126 §2.1 / RFC 6749 §3.1
    const { params, authorization } = await parsePushedAuthorizationRequest(c);

    // [authenticate-client] Authenticate the pushing client — RFC 9126 §2.1
    const { clientId, pushedParams } = await authenticatePushingClient(c, params, authorization);

    // [validate-request] Validate the request as /authorize would — RFC 9126 §2.1
    await validatePushedRequest(c, pushedParams);

    // [store-request] Store the request under a fresh request_uri — RFC 9126 §2.2 / §7.1
    const parResponse = await storePushedRequest(c, clientId, pushedParams);

    // [respond] Respond 201 (no-store) — RFC 9126 §2.2
    return respondPar(c, parResponse);
  } catch (error) {
    return respondParError(c, error);
  }
});
