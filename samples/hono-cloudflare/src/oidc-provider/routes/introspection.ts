import { Hono } from 'hono';
import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  requireIntrospectionToken,
  requireIntrospectionClient,
  resolveIntrospectionToken,
  isIntrospectionTokenActive,
  buildIntrospectionResponse,
  INACTIVE_INTROSPECTION_RESPONSE,
  IntrospectionError,
  TokenError,
  selectSigningKeyByAlg,
  type SigningKey,
  type IntrospectionResponse,
} from '@maronn-openid-connect/core';
import {
  TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,
  acceptsIntrospectionJwt,
  createIntrospectionResponseJwt,
  restrictIntrospectionResponseToCaller,
} from '@maronn-openid-connect/experimental/jwt-introspection-response';
import {
  tokenClientResolver as defaultTokenClientResolver,
  introspectionAccessTokenResolver as defaultAccessResolver,
  introspectionRefreshTokenResolver as defaultRefreshResolver,
} from '../resolvers.js';

export const introspectionApp = new Hono<{ Variables: Record<string, any> }>();

function isFormUrlEncoded(contentType: string): boolean {
  return contentType.toLowerCase().split(';')[0]?.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Token Introspection Endpoint
 * RFC 7662 Section 2
 *
 * Confidential client only — public clients are out of scope for this template.
 * Response is always cache-busting per RFC 7662 Section 2.2.
 */
introspectionApp.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  if (!isFormUrlEncoded(c.req.header('Content-Type') ?? '')) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
      400,
    );
  }

  const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
  const authorization = c.req.header('Authorization') ?? '';
  const params = Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, String(v)]),
  );

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const accessTokenResolver =
      c.get('introspectionAccessTokenResolver') ?? defaultAccessResolver;
    const refreshTokenResolver =
      c.get('introspectionRefreshTokenResolver') ?? defaultRefreshResolver;

    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9, called in the same order as core's
    // authenticateClient(). RFC 7662 §2.1 requires the caller to authenticate.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });
    const introspectingClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );
    validateClientAuthMethod(introspectingClient, presentedCredentials);
    await verifyClientSecret(introspectingClient, presentedCredentials.clientSecret);
    const authenticatedClientId = presentedCredentials.clientId;

    // --- Introspection pipeline ---------------------------------------------
    // Each step below is an independent core function, called in the same order
    // as core's handleIntrospectionRequest(). Delete a call to drop that step,
    // or insert your own logic between steps.

    // RFC 7662 §2.1: token is REQUIRED (invalid_request when absent).
    const token = requireIntrospectionToken({
      token: typeof params.token === 'string' ? params.token : undefined,
    });

    // RFC 7662 §2.1: the caller must be an authenticated client (invalid_client).
    requireIntrospectionClient(authenticatedClientId);

    // RFC 7662 §2.1: token_type_hint only reorders the lookup — the other token
    // type is still searched when the hint misses.
    const resolved = await resolveIntrospectionToken({
      token,
      tokenTypeHint:
        typeof params.token_type_hint === 'string' ? params.token_type_hint : undefined,
      accessTokenResolver,
      refreshTokenResolver,
    });

    // RFC 7662 §2.2: an unknown, expired, not-yet-valid or rotated token is
    // reported as { active: false } with no other member, so the caller cannot
    // distinguish "never existed" from "no longer valid".
    let response: IntrospectionResponse = INACTIVE_INTROSPECTION_RESPONSE;
    if (resolved !== null && isIntrospectionTokenActive(resolved)) {
      response = buildIntrospectionResponse(resolved);
    }

    // EXPERIMENTAL — RFC 9701 §4 / §5: a caller whose Accept header names
    // application/token-introspection+jwt receives the introspection response
    // as a signed JWT. Any other request (no Accept, application/json, a
    // wildcard) is answered exactly as before, and the branch sits AFTER client
    // authentication and token resolution so the Accept header can never
    // bypass either (§8.2 downgrade prevention).
    if (acceptsIntrospectionJwt(c.req.header('Accept'))) {
      // RFC 9701 §3 / §5: before the response leaves as a signed assertion its
      // members are restricted to what the authenticated caller may see — a
      // caller that is neither the client the token was issued to nor listed in
      // its aud gets { active: false }, indistinguishable from an unknown token.
      const restrictedResponse = restrictIntrospectionResponseToCaller(
        response,
        authenticatedClientId,
      );
      // RFC 9701 §6: alg is pinned to RS256 (the default for a client that
      // registered no introspection_signed_response_alg). The general-purpose
      // ACTIVE key is not guaranteed to be RS256 — SigningKeyProvider may
      // legitimately return ES256 as active alongside an RS256 + ES256
      // registered set — so the key is picked by alg from the registered set.
      // Its public half is published at /.well-known/jwks.json under the same
      // kid. selectSigningKeyByAlg throws when no RS256 key is registered,
      // which surfaces as a server_error below (a configuration mistake)
      // rather than as an unverifiable introspection response.
      const introspectionSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
      const introspectionSigningKey = introspectionSigningKeys.length > 0
        ? selectSigningKeyByAlg(introspectionSigningKeys, 'RS256')
        : {
            // Falls back to the single-key context so a hand-wired provider
            // that never populated the key set keeps working; on the default
            // single RS256 key both branches resolve the same key.
            privateKey: c.get('privateKey'),
            publicJwk: c.get('publicJwk'),
            keyId: c.get('keyId'),
          };
      const responseJwt = await createIntrospectionResponseJwt({
        issuer: c.get('config').issuer,
        audience: authenticatedClientId,
        introspection: restrictedResponse,
        signingKey: introspectionSigningKey,
      });
      // RFC 9701 §5: the success response is the compact JWS itself under its
      // own media type. c.body (unlike c.text, which forces text/plain) keeps
      // the explicitly set Content-Type, and the cache-busting headers set at
      // the top of the handler still apply.
      c.header('Content-Type', TOKEN_INTROSPECTION_JWT_MEDIA_TYPE);
      return c.body(responseJwt);
    }

    return c.json(response);
  } catch (error) {
    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    if (error instanceof IntrospectionError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
