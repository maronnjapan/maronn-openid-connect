/**
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
} from '@maronn-openid-connect/core';
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
    validateUserInfoAudience(tokenInfo, `${config.issuer}/userinfo`);

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
            'WWW-Authenticate': `Bearer realm="UserInfo", error="${error.error}", error_description="${error.errorDescription}"`,
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
        error_description: `No UserInfo signing key registered for alg "${client.userinfoSignedResponseAlg}"`,
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
