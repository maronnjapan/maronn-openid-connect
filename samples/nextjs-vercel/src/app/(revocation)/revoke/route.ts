/**
 * Token Revocation Endpoint (RFC 7009 §2).
 *
 * Confidential clients authenticate with their registered method; public
 * clients registered with token_endpoint_auth_method=none identify themselves
 * with client_id alone (RFC 7009 §2.1). "Revoked" and "not found" both answer
 * 200 with no body, so the endpoint reveals nothing about which tokens exist
 * (§2.2). Revoking a refresh token also revokes the access tokens of the same
 * grant (§2.1 SHOULD).
 */
import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  requireRevocationToken,
  requireRevocationClient,
  resolveRevocationTarget,
  validateRevocationTokenClient,
  revokeResolvedToken,
  revokeGrantAccessTokens,
  RevocationError,
  TokenError,
} from '@maronn-openid-connect/core';
import { clientResolver, stores } from '../../_oidc-provider/provider';
import { createRevocationResolvers } from '../../_oidc-provider/features/revocation/resolvers';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  oauthError,
  withCors,
} from '../../_oidc-provider/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const revocationResolvers = createRevocationResolvers(stores);

/**
 * Answer a revocation request (POST /revoke) with the response of revoke() —
 * 200 with an empty body, or an OAuth error — plus the clientCors headers.
 */
export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await revoke(request));
}

/**
 * Answer the CORS preflight of /revoke: 204 with no body and the clientCors
 * headers (allowed origin, methods, headers, max age).
 */
export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

/**
 * Authenticate the client and revoke the presented token when it was issued
 * to that client — a refresh token together with the access tokens of its
 * grant — answering 200 with an empty no-store body, also for an unknown
 * token.
 *
 * A public client identifies itself by client_id alone. Errors are no-store
 * OAuth error JSON: 400 invalid_request for a body that is not form-urlencoded
 * or has no token, 400 invalid_grant for a token issued to another client, 401
 * invalid_client (with WWW-Authenticate) when client authentication fails, 500
 * server_error otherwise.
 *
 * @spec RFC 7009 §2
 */
async function revoke(request: Request): Promise<Response> {
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }
  const params = Object.fromEntries(new URLSearchParams(await request.text()));

  try {
    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9, the same steps as the token endpoint.
    // Public clients registered with token_endpoint_auth_method=none pass with
    // client_id only (RFC 7009 §2.1).
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: request.headers.get('Authorization') ?? '',
    });
    const revokingClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      clientResolver,
    );
    validateClientAuthMethod(revokingClient, presentedCredentials);
    await verifyClientSecret(revokingClient, presentedCredentials.clientSecret);
    const authenticatedClientId = presentedCredentials.clientId;

    // --- Revocation pipeline ------------------------------------------------
    // Each step below is an independent core function, called in RFC 7009 §2
    // order. Delete a call to drop that step, or insert your own logic between
    // steps.

    // RFC 7009 §2.1: token is REQUIRED (invalid_request when absent).
    const token = requireRevocationToken({ token: params.token });

    // RFC 7009 §2.1: the caller must be an identified client (invalid_client).
    requireRevocationClient(authenticatedClientId);

    // RFC 7009 §2.1: token_type_hint only reorders the lookup — the other token
    // type is still searched when the hint misses.
    const resolved = await resolveRevocationTarget({
      token,
      tokenTypeHint: params.token_type_hint,
      resolvers: revocationResolvers,
    });

    // RFC 7009 §2.2: an unknown token is still a success, so the client cannot
    // probe which token values exist.
    if (resolved !== null) {
      // RFC 7009 §2.1: a token issued to another client is refused (invalid_grant).
      validateRevocationTokenClient(resolved, authenticatedClientId);

      await revokeResolvedToken(token, resolved, revocationResolvers);

      // RFC 7009 §2.1 SHOULD: revoking a refresh token also revokes the access
      // tokens of the same grant. Delete this call to revoke only the presented
      // token.
      await revokeGrantAccessTokens(resolved, revocationResolvers);
    }

    // RFC 7009 §2.2: 200 with an empty body.
    return new Response(null, {
      status: 200,
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  } catch (error) {
    if (error instanceof TokenError || error instanceof RevocationError) {
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
