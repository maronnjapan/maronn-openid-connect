/**
 * EXPERIMENTAL — Pushed Authorization Request Endpoint (RFC 9126 §2).
 *
 * Generated because the OP was created with `--enable par`. Backed by
 * @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The client POSTs the authorization request parameters here (back channel,
 * authenticated) and receives a short-lived request_uri that it then passes to
 * /authorize.
 *
 * NOTE (RFC 9126 §2.3): request size limits (413) and rate limiting (429) are
 * left to the deployment layer (reverse proxy / platform). This endpoint is
 * unauthenticated until the client credentials are checked, so put a rate
 * limit in front of it in production.
 */
import {
  ParError,
  authenticateParClient,
  buildPushedAuthorizationResponse,
  createPushedAuthorizationRecord,
  rejectForbiddenParParams,
  validatePushedAuthorizationParams,
} from '@maronn-openid-connect/experimental/par';
import { sanitizeErrorDescription } from '@maronn-openid-connect/core';
import { clientResolver, config } from '../../_oidc-provider/provider';
import { parStore } from '../../_oidc-provider/features/par/store';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  uniqueParams,
  withCors,
} from '../../_oidc-provider/http';
import { parConfig } from '../../_oidc-provider/features/par/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await pushAuthorizationRequest(request));
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

async function pushAuthorizationRequest(request: Request): Promise<Response> {
  // RFC 9126 §2.1: the body MUST be application/x-www-form-urlencoded.
  if (!isFormUrlEncoded(request)) {
    return parJson(
      { error: 'invalid_request', error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded' },
      400,
    );
  }

  // RFC 6749 §3.1: request parameters MUST NOT be repeated.
  const { params, duplicateKey } = uniqueParams(new URLSearchParams(await request.text()));
  if (duplicateKey !== undefined) {
    return parJson(
      { error: 'invalid_request', error_description: `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated` },
      400,
    );
  }

  try {
    // --- Pushed authorization request pipeline ------------------------------
    // Each step below is an independent function from
    // @maronn-openid-connect/experimental/par, called in RFC 9126 §2.1 order. Delete a call
    // to drop that validation, or insert your own logic between steps.

    // RFC 9126 §2.1: request_uri MUST NOT be pushed. The request parameter
    // (PAR + JAR, §3) is not supported by this generated provider.
    rejectForbiddenParParams(params);

    // RFC 9126 §2.1: authenticate exactly like the token endpoint does. Public
    // clients present only client_id (no credentials).
    const clientId = await authenticateParClient({
      params,
      authorizationHeader: request.headers.get('Authorization') ?? '',
      clientResolver,
    });

    // client_id is a required authorization request parameter (RFC 9126 §2.1),
    // so it is pinned to the authenticated client before validation and storage.
    const pushedParams = { ...params, client_id: clientId };

    // RFC 9126 §2.1: "validate the request the same way the authorization
    // endpoint would" — an unregistered redirect_uri or a bad scope fails here,
    // before the End-User ever sees a screen.
    await validatePushedAuthorizationParams(pushedParams, clientResolver, {
      allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
    });

    // RFC 9126 §2.2 / §7.1: mint a random reference and store the request under
    // it. Client credentials are never persisted.
    const record = await createPushedAuthorizationRecord({
      clientId,
      params: pushedParams,
      store: parStore,
      expiresInSeconds: parConfig.expiresInSeconds,
    });
    const response = buildPushedAuthorizationResponse(record);

    // Never log the pushed parameters: they can carry PII such as login_hint,
    // and the Authorization header carries the client_secret.

    // RFC 9126 §2.2: 201 Created with a non-cacheable JSON body.
    return parJson({ request_uri: response.requestUri, expires_in: response.expiresIn }, 201);
  } catch (error) {
    if (error instanceof ParError) {
      // RFC 9126 §2.3: token-endpoint style JSON errors; this endpoint never redirects.
      return parJson(
        { error: error.code, error_description: error.errorDescription },
        error.statusCode,
        error.wwwAuthenticate,
      );
    }
    return parJson({ error: 'server_error' }, 500);
  }
}

/** RFC 9126 §2.2 / §2.3: every PAR response is JSON that must not be cached. */
function parJson(body: unknown, status: number, wwwAuthenticate?: string): Response {
  const headers = new Headers({ 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' });
  if (wwwAuthenticate) headers.set('WWW-Authenticate', wwwAuthenticate);
  return Response.json(body, { status, headers });
}
