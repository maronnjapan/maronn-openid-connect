/**
 * Token Introspection Endpoint (RFC 7662 §2).
 *
 * Confidential clients only: a caller registered with token_endpoint_auth_method
 * 'none' is rejected with invalid_client (RFC 7662 §2.1 / RFC 9701 §5), since a
 * public client_id alone is not authentication. Responses are never cached
 * (RFC 7662 §2.2).
 */
import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  requireIntrospectionToken,
  requireIntrospectionClient,
  requireConfidentialIntrospectionCaller,
  resolveIntrospectionToken,
  isIntrospectionTokenActive,
  buildIntrospectionResponse,
  INACTIVE_INTROSPECTION_RESPONSE,
  IntrospectionError,
  TokenError,
  type IntrospectionResponse,
} from '@maronn-openid-connect/core';
import { clientResolver, resolvers } from '../_oidc-provider/provider';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  noStoreJson,
  oauthError,
  withCors,
} from '../_oidc-provider/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await introspect(request));
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

async function introspect(request: Request): Promise<Response> {
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }
  const params = Object.fromEntries(new URLSearchParams(await request.text()));

  try {
    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9, called in the same order as core's
    // authenticateClient(). RFC 7662 §2.1 requires the caller to authenticate.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: request.headers.get('Authorization') ?? '',
    });
    const introspectingClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      clientResolver,
    );
    validateClientAuthMethod(introspectingClient, presentedCredentials);
    await verifyClientSecret(introspectingClient, presentedCredentials.clientSecret);
    // RFC 7662 §2.1 / RFC 9701 §5: the caller must be an authenticated
    // confidential client. A client registered with token_endpoint_auth_method
    // 'none' passes the pipeline above with its client_id alone — public
    // information — so treating it as authenticated would let anyone scan
    // tokens. Revocation has no such step on purpose: RFC 7009 §2.1 lets a
    // public client revoke its own tokens.
    requireConfidentialIntrospectionCaller(introspectingClient);
    const authenticatedClientId = presentedCredentials.clientId;

    // --- Introspection pipeline ---------------------------------------------
    // Each step below is an independent core function, called in the same order
    // as core's handleIntrospectionRequest(). Delete a call to drop that step,
    // or insert your own logic between steps.

    // RFC 7662 §2.1: token is REQUIRED (invalid_request when absent).
    const token = requireIntrospectionToken({ token: params.token });

    // RFC 7662 §2.1: the caller must be an authenticated client (invalid_client).
    requireIntrospectionClient(authenticatedClientId);

    // RFC 7662 §2.1: token_type_hint only reorders the lookup — the other token
    // type is still searched when the hint misses.
    const resolved = await resolveIntrospectionToken({
      token,
      tokenTypeHint: params.token_type_hint,
      accessTokenResolver: resolvers.introspectionAccessTokenResolver,
      refreshTokenResolver: resolvers.introspectionRefreshTokenResolver,
    });

    // RFC 7662 §2.2: an unknown, expired, not-yet-valid or rotated token is
    // reported as { active: false } and nothing else, so the caller cannot tell
    // "never existed" from "no longer valid".
    let response: IntrospectionResponse = INACTIVE_INTROSPECTION_RESPONSE;
    if (resolved !== null && isIntrospectionTokenActive(resolved)) {
      response = buildIntrospectionResponse(resolved);
    }

    return noStoreJson(response);
  } catch (error) {
    if (error instanceof TokenError || error instanceof IntrospectionError) {
      return oauthError(
        error.error,
        error.errorDescription,
        error.statusCode,
        error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
      );
    }
    return oauthError('server_error', undefined, 500);
  }
}
