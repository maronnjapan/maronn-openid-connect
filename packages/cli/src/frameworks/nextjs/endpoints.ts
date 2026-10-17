/**
 * Next.js templates for the back-channel Route Handlers next to the token
 * endpoint: UserInfo, introspection, revocation and pushed authorization
 * requests.
 */
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import { EXPERIMENTAL_PACKAGE } from '../hono/templates.js';

/** `userinfo/route.ts` — OIDC Core 1.0 §5.3. */
export function nextJsUserinfoRouteTemplate(corePkg: string): string {
  return `/**
 * UserInfo Endpoint (OIDC Core 1.0 §5.3).
 *
 * The response format follows the client metadata userinfo_signed_response_alg:
 * a signed JWT (application/jwt, §5.3.2) when the client registered one,
 * JSON otherwise. Every answer — success and error — exposes or concerns PII,
 * so none may be cached (RFC 6750 §5.2 / OIDC Core 1.0 §16.4).
 */
import {
  resolveUserInfoAccessToken,
  validateUserInfoTokenExpiration,
  validateUserInfoScope,
  validateUserInfoAudience,
  resolveUserInfoClaims,
  filterClaimsByScope,
  applyRequestedClaims,
  generateUserInfoJwt,
  selectSigningKeyByAlg,
  UserInfoError,
  type SigningKey,
  type UserInfoResponse,
} from '${corePkg}';
import type { RegisteredClient } from '../_oidc-provider/config';
import {
  clientResolver,
  config,
  loadSigningKeys,
  resolvers,
  type ProviderSigningKeys,
} from '../_oidc-provider/provider';
import {
  clientCors,
  corsPreflight,
  noStoreJson,
  signingKeysUnavailable,
  withCors,
} from '../_oidc-provider/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return withCors(request, clientCors, await userinfo(request));
}

export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await userinfo(request));
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

async function userinfo(request: Request): Promise<Response> {
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  let accessToken: string;
  try {
    const { token, methodCount } = await extractAccessToken(request);
    if (methodCount > 1) {
      // RFC 6750 §2: clients MUST NOT use more than one method per request.
      return noStoreJson(
        {
          error: 'invalid_request',
          error_description: 'Multiple access token methods are not allowed',
        },
        {
          status: 400,
          headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo", error="invalid_request"' },
        },
      );
    }
    if (!token) {
      // RFC 6750 §3.1: a request without authentication information gets a
      // challenge that only names the realm (no error / error_description).
      return noStoreJson(
        { error: 'invalid_token', error_description: 'Access token is required' },
        { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo"' } },
      );
    }
    accessToken = token;
  } catch {
    return noStoreJson({ error: 'invalid_request' }, { status: 400 });
  }

  try {
    // --- UserInfo request pipeline ------------------------------------------
    // Each step below is an independent core function. Delete a call to drop
    // that validation, or insert your own logic between steps. Every step
    // throws UserInfoError, which the catch block below renders as an RFC 6750
    // Bearer challenge.

    // OIDC Core 1.0 §5.3.1: resolve the presented Bearer token (invalid_token when unknown).
    const tokenInfo = await resolveUserInfoAccessToken(accessToken, resolvers.accessTokenResolver);

    // RFC 6750 §3.1: an expired access token is invalid_token.
    validateUserInfoTokenExpiration(tokenInfo);

    // OIDC Core 1.0 §5.3.1: the token must carry the openid scope (insufficient_scope).
    validateUserInfoScope(tokenInfo);

    // RFC 9068 §4: this UserInfo endpoint must appear in the access token's aud.
    // The token endpoint always puts it there (buildAccessTokenAudience), so the
    // check is on for JWT and opaque tokens alike. Pass undefined to turn it off.
    validateUserInfoAudience(tokenInfo, \`\${config.issuer}/userinfo\`);

    // Load every claim the OP knows about the token's subject.
    const userClaims = await resolveUserInfoClaims(tokenInfo, resolvers.userClaimsResolver);

    // OIDC Core 1.0 §5.4: keep only the claims the granted scopes allow.
    const scopedResponse = filterClaimsByScope(userClaims, tokenInfo.scope);

    // OIDC Core 1.0 §5.5: overlay the individually requested claims the token
    // endpoint stored with this access token (claims.userinfo members).
    const response = applyRequestedClaims(scopedResponse, userClaims, tokenInfo.claims);

    const client = (await clientResolver.findClient(tokenInfo.clientId)) as RegisteredClient | null;
    if (client?.userinfoSignedResponseAlg) {
      return await signedUserInfo(response, client, keys);
    }
    return noStoreJson(response);
  } catch (error) {
    if (error instanceof UserInfoError) {
      return noStoreJson(
        { error: error.error, error_description: error.errorDescription },
        {
          status: error.statusCode,
          headers: {
            'WWW-Authenticate': \`Bearer realm="UserInfo", error="\${error.error}", error_description="\${error.errorDescription}"\`,
          },
        },
      );
    }
    return noStoreJson({ error: 'server_error' }, { status: 500 });
  }
}

/**
 * OIDC Core 1.0 §5.3.2: the UserInfo Response as a JWS signed with the alg the
 * client registered (RS256, ES256, ...), using the registered UserInfo key of
 * that alg. No key for it is a server configuration error — the response is
 * never silently signed with another alg.
 */
async function signedUserInfo(
  claims: UserInfoResponse,
  client: RegisteredClient,
  keys: ProviderSigningKeys,
): Promise<Response> {
  let signingKey: SigningKey;
  try {
    signingKey = selectSigningKeyByAlg(keys.userinfo, client.userinfoSignedResponseAlg);
  } catch {
    return noStoreJson(
      {
        error: 'server_error',
        error_description: \`No UserInfo signing key registered for alg "\${client.userinfoSignedResponseAlg}"\`,
      },
      { status: 500 },
    );
  }
  const jwt = await generateUserInfoJwt(claims, {
    issuer: config.issuer,
    audience: client.clientId,
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
  });
  return new Response(jwt, {
    headers: { 'Content-Type': 'application/jwt', 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

/**
 * The access token of the request, from:
 * - the Authorization: Bearer header (RFC 6750 §2.1, REQUIRED), or
 * - the access_token form parameter of a POST (RFC 6750 §2.2, OPTIONAL).
 * The query parameter method (§2.3) is not supported: OAuth 2.1 prohibits it.
 * methodCount lets the caller refuse a request that used more than one.
 */
async function extractAccessToken(request: Request): Promise<{ token: string; methodCount: number }> {
  const authHeader = request.headers.get('Authorization') ?? '';
  // RFC 7235 §2.1: the auth scheme is case-insensitive; the token value is kept verbatim.
  const spaceIndex = authHeader.indexOf(' ');
  const headerToken =
    spaceIndex !== -1 && authHeader.slice(0, spaceIndex).toLowerCase() === 'bearer'
      ? authHeader.slice(spaceIndex + 1)
      : '';

  let bodyToken = '';
  if (request.method === 'POST') {
    const mediaType =
      (request.headers.get('Content-Type') ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
    if (mediaType === 'application/x-www-form-urlencoded') {
      bodyToken = new URLSearchParams(await request.text()).get('access_token') ?? '';
    }
  }

  const methodCount = (headerToken ? 1 : 0) + (bodyToken ? 1 : 0);
  return { token: headerToken || bodyToken, methodCount };
}
`;
}

/** `introspect/route.ts` — RFC 7662, generated with the introspection feature. */
export function nextJsIntrospectionRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const jwt = features.jwtIntrospectionResponse;
  const jwtCoreImports = jwt
    ? `
  selectSigningKeyByAlg,`
    : '';
  const jwtImports = jwt
    ? `
import {
  TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,
  acceptsIntrospectionJwt,
  createIntrospectionResponseJwt,
  restrictIntrospectionResponseToCaller,
} from '${EXPERIMENTAL_PACKAGE}/jwt-introspection-response';`
    : '';
  const keyLoading = jwt
    ? `  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

`
    : '';
  const providerImports = jwt
    ? `import { clientResolver, config, loadSigningKeys, resolvers } from '../_oidc-provider/provider';`
    : `import { clientResolver, resolvers } from '../_oidc-provider/provider';`;
  const httpImports = jwt
    ? `import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  noStoreJson,
  oauthError,
  signingKeysUnavailable,
  withCors,
} from '../_oidc-provider/http';`
    : `import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  noStoreJson,
  oauthError,
  withCors,
} from '../_oidc-provider/http';`;
  const jwtBranch = jwt
    ? `    // EXPERIMENTAL — RFC 9701 §4 / §5: a caller whose Accept header names
    // application/token-introspection+jwt receives the response as a signed JWT.
    // Any other request (no Accept, application/json, a wildcard) is answered as
    // JSON, and the branch sits AFTER client authentication and token resolution
    // so the Accept header can never bypass either (§8.2 downgrade prevention).
    if (acceptsIntrospectionJwt(request.headers.get('Accept') ?? undefined)) {
      // RFC 9701 §3 / §5: before the response leaves as a signed assertion its
      // members are restricted to what the authenticated caller may see — a
      // caller that is neither the client the token was issued to nor in its
      // aud gets { active: false }, indistinguishable from an unknown token.
      const restrictedResponse = restrictIntrospectionResponseToCaller(
        response,
        authenticatedClientId,
      );
      // RFC 9701 §6: alg is pinned to RS256 (the default for a client that
      // registered no introspection_signed_response_alg). The first key of the
      // set is not guaranteed to be RS256, so the key is picked by alg from the
      // set; its public half is published at /.well-known/jwks.json under the
      // same kid. No RS256 key surfaces as a server_error (a configuration
      // mistake) rather than as an unverifiable response.
      const responseJwt = await createIntrospectionResponseJwt({
        issuer: config.issuer,
        audience: authenticatedClientId,
        introspection: restrictedResponse,
        signingKey: selectSigningKeyByAlg(keys.general, 'RS256'),
      });
      // RFC 9701 §5: the success response is the compact JWS itself, under its
      // own media type.
      return new Response(responseJwt, {
        headers: {
          'Content-Type': TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        },
      });
    }

`
    : '';
  return `/**
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
  TokenError,${jwtCoreImports}
  type IntrospectionResponse,
} from '${corePkg}';${jwtImports}
${providerImports}
import { verifyPrivateKeyJwt } from '../_oidc-provider/client-auth';
${httpImports}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await introspect(request));
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

async function introspect(request: Request): Promise<Response> {
${keyLoading}  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }
  const params = Object.fromEntries(new URLSearchParams(await request.text()));

  try {
    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9, the same steps as the token endpoint.
    // RFC 7662 §2.1 requires the caller to authenticate.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: request.headers.get('Authorization') ?? '',
    });
    const introspectingClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      clientResolver,
    );
    validateClientAuthMethod(introspectingClient, presentedCredentials);
    if (presentedCredentials.method === 'private_key_jwt') {
      await verifyPrivateKeyJwt(introspectingClient, presentedCredentials, '/introspect');
    } else {
      await verifyClientSecret(introspectingClient, presentedCredentials.clientSecret);
    }
    // RFC 7662 §2.1 / RFC 9701 §5: the caller must be an authenticated
    // confidential client. A client registered with token_endpoint_auth_method
    // 'none' passes the pipeline above with its client_id alone — public
    // information — so treating it as authenticated would let anyone scan
    // tokens. Revocation has no such step on purpose: RFC 7009 §2.1 lets a
    // public client revoke its own tokens.
    requireConfidentialIntrospectionCaller(introspectingClient);
    const authenticatedClientId = presentedCredentials.clientId;

    // --- Introspection pipeline ---------------------------------------------
    // Each step below is an independent core function, called in RFC 7662 §2
    // order. Delete a call to drop that step, or insert your own logic between
    // steps.

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

${jwtBranch}    return noStoreJson(response);
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
`;
}

/** `revoke/route.ts` — RFC 7009, generated with the revocation feature. */
export function nextJsRevocationRouteTemplate(corePkg: string): string {
  return `/**
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
} from '${corePkg}';
import { verifyPrivateKeyJwt } from '../_oidc-provider/client-auth';
import { clientResolver, resolvers } from '../_oidc-provider/provider';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  oauthError,
  withCors,
} from '../_oidc-provider/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await revoke(request));
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

async function revoke(request: Request): Promise<Response> {
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }
  const params = Object.fromEntries(new URLSearchParams(await request.text()));
  const { revocationResolvers } = resolvers;

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
    if (presentedCredentials.method === 'private_key_jwt') {
      await verifyPrivateKeyJwt(revokingClient, presentedCredentials, '/revoke');
    } else {
      await verifyClientSecret(revokingClient, presentedCredentials.clientSecret);
    }
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
`;
}

/** `par/config.ts` — EXPERIMENTAL RFC 9126 settings, only with --enable par. */
export function nextJsParConfigTemplate(): string {
  return `/**
 * EXPERIMENTAL — Pushed Authorization Requests settings (RFC 9126).
 *
 * Read by the PAR endpoint (par/route.ts), the authorization endpoint and
 * discovery, so it lives in its own module.
 *
 * - expiresInSeconds: request_uri lifetime. RFC 9126 §2.2 recommends 5–600
 *   seconds; values outside that range fail fast at module load.
 * - requirePushedAuthorizationRequests: RFC 9126 §5. When true, /authorize
 *   rejects any request that did not go through /par, and discovery
 *   advertises require_pushed_authorization_requests: true.
 */
import { assertParExpiresInSeconds } from '${EXPERIMENTAL_PACKAGE}/par';

export const parConfig = {
  expiresInSeconds: 60,
  requirePushedAuthorizationRequests: false,
};

assertParExpiresInSeconds(parConfig.expiresInSeconds);
`;
}

/** `par/route.ts` — EXPERIMENTAL RFC 9126, only with --enable par. */
export function nextJsParRouteTemplate(corePkg: string): string {
  return `/**
 * EXPERIMENTAL — Pushed Authorization Request Endpoint (RFC 9126 §2).
 *
 * Generated because the OP was created with \`--enable par\`. Backed by
 * ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change in a breaking
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
} from '${EXPERIMENTAL_PACKAGE}/par';
import { sanitizeErrorDescription } from '${corePkg}';
import { verifyPrivateKeyJwt } from '../_oidc-provider/client-auth';
import { clientResolver, config, parStore } from '../_oidc-provider/provider';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  uniqueParams,
  withCors,
} from '../_oidc-provider/http';
import { parConfig } from './config';

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
      { error: 'invalid_request', error_description: \`Parameter "\${sanitizeErrorDescription(duplicateKey)}" must not be repeated\` },
      400,
    );
  }

  try {
    // --- Pushed authorization request pipeline ------------------------------
    // Each step below is an independent function from
    // ${EXPERIMENTAL_PACKAGE}/par, called in RFC 9126 §2.1 order. Delete a call
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
      // OIDC Core 1.0 §9: private_key_jwt, checked like the token endpoint does.
      verifyClientAssertion: (client, clientAssertion) =>
        verifyPrivateKeyJwt(client, { clientAssertion }, '/par'),
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
`;
}

/**
 * `register/config.ts` — EXPERIMENTAL RFC 7591 settings, only with
 * --enable dynamic-client-registration.
 */
export function nextJsRegisterConfigTemplate(): string {
  return `/**
 * EXPERIMENTAL — Dynamic Client Registration settings (RFC 7591).
 *
 * Read by the registration endpoint (register/route.ts), so it lives in its
 * own module.
 *
 * - initialAccessToken: when set, POST /register requires
 *   \`Authorization: Bearer <value>\` (OIDC Dynamic Client Registration 1.0 §3).
 *   Unset means open registration (RFC 7591 §3.1 SHOULD). This is one static
 *   secret for PoC use — there is no issuance or rotation.
 * - maxRegisteredClients: inventory cap on dynamic registrations
 *   (RFC 7591 §5 DoS consideration). The cap answers 429, not
 *   invalid_client_metadata: nothing about the metadata is wrong, so a
 *   metadata-retry loop must not be invited.
 * - maxRegistrationBodyBytes: request body limit in UTF-8 bytes.
 */
export const dynamicClientRegistrationConfig = {
  initialAccessToken: undefined as string | undefined,
  maxRegisteredClients: 100,
  maxRegistrationBodyBytes: 16384,
};
`;
}

/**
 * `register/route.ts` — EXPERIMENTAL RFC 7591, only with
 * --enable dynamic-client-registration.
 */
export function nextJsRegisterRouteTemplate(): string {
  return `/**
 * EXPERIMENTAL — Client Registration Endpoint (RFC 7591 §3).
 *
 * Generated because the OP was created with
 * \`--enable dynamic-client-registration\`. Backed by ${EXPERIMENTAL_PACKAGE},
 * whose API is NOT stable: it may change in a breaking way between releases.
 * Do not build production code on it without pinning the version.
 *
 * The client POSTs its metadata here as JSON and receives a freshly minted
 * client_id (and, for confidential clients, a client_secret) that works on
 * /authorize and /token right away. Registration is open by default
 * (RFC 7591 §3.1 SHOULD); set initialAccessToken (register/config.ts) to
 * require a Bearer token.
 *
 * NOTE (RFC 7591 §5): per-IP rate limiting is deliberately left to the
 * deployment layer (reverse proxy / platform); this endpoint only enforces the
 * inventory and body-size caps of register/config.ts. Open registration grants
 * no trust: what an issued client can do stays bounded by the same validation
 * as a static client (PKCE, exact redirect_uri match, client authentication).
 */
import {
  ClientRegistrationError,
  buildClientRegistrationResponse,
  buildRegisteredClient,
  validateClientRegistrationRequest,
  verifyInitialAccessToken,
} from '${EXPERIMENTAL_PACKAGE}/dynamic-client-registration';
import { dynamicClientStore } from '../_oidc-provider/provider';
import { clientCors, corsPreflight, withCors } from '../_oidc-provider/http';
import { dynamicClientRegistrationConfig } from './config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await registerClient(request));
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

async function registerClient(request: Request): Promise<Response> {
  const config = dynamicClientRegistrationConfig;

  // (1) Initial access token, checked before the body is read. The two 401
  // shapes follow RFC 6750 §3.1: no error code without credentials, and
  // error="invalid_token" for presented-but-wrong ones. Neither reflects
  // anything about the expected token.
  if (config.initialAccessToken !== undefined) {
    const authorization = request.headers.get('Authorization');
    if (authorization === null) {
      return registration401('Bearer');
    }
    const accepted = await verifyInitialAccessToken(authorization, config.initialAccessToken);
    if (!accepted) {
      return registration401('Bearer error="invalid_token"');
    }
  }

  // (2) RFC 7591 §3.1: application/json only (parameters such as charset are
  // fine). Enforcing the media type also closes the cross-origin text/plain
  // form post that can synthesize a JSON-shaped body without a CORS preflight.
  if (!isJson(request.headers.get('Content-Type') ?? '')) {
    return registrationJson(
      { error: 'invalid_client_metadata', error_description: 'registration requests must use application/json' },
      400,
    );
  }

  const rawBody = await request.text();
  try {
    // (3)–(8) Body size, JSON shape, allowlist-pick of the understood fields,
    // value checks and RFC 7591 §2 defaults — pure functions from
    // ${EXPERIMENTAL_PACKAGE}/dynamic-client-registration. Unknown metadata is
    // silently ignored (§2 MUST), and every error_description is a fixed ASCII
    // string that never reflects request values.
    const metadata = validateClientRegistrationRequest(rawBody, {
      maxBodyBytes: config.maxRegistrationBodyBytes,
    });
    const client = buildRegisteredClient(metadata);

    // (9) Inventory cap (RFC 7591 §5). 429 with a fixed body: the metadata is
    // fine, so answering invalid_client_metadata would invite a retry loop that
    // amplifies the very DoS surface the cap is here to close. No Retry-After —
    // the cap is a stock ceiling, not a rate, so no recovery time is promised.
    if ((await dynamicClientStore.count()) >= config.maxRegisteredClients) {
      return registrationJson(
        { error: 'too_many_registrations', error_description: 'registration limit reached' },
        429,
      );
    }
    await dynamicClientStore.save(client);

    // Never log the registration metadata or the issued client_secret.

    // RFC 7591 §3.2.1: 201 Created with the issued values and every registered
    // metadata value (defaults applied). client_secret_expires_at: 0 means the
    // secret does not expire.
    return registrationJson(buildClientRegistrationResponse(client), 201);
  } catch (error) {
    if (error instanceof ClientRegistrationError) {
      // RFC 7591 §3.2.2: 400 with error / error_description JSON.
      return registrationJson({ error: error.error, error_description: error.errorDescription }, 400);
    }
    return registrationJson({ error: 'server_error' }, 500);
  }
}

/** RFC 7591 §3.1: the registration request body MUST be application/json. */
function isJson(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/json';
}

/** The 201 body carries the client_secret, so no registration response may be cached. */
function registrationJson(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

/** RFC 6750 §3.1: a 401 challenge with an empty body. */
function registration401(wwwAuthenticate: string): Response {
  return new Response(null, {
    status: 401,
    headers: {
      'WWW-Authenticate': wwwAuthenticate,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}
`;
}
