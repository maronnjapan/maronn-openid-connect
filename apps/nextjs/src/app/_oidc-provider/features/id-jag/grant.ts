/**
 * EXPERIMENTAL — Identity Assertion JWT Authorization Grant (ID-JAG), the
 * Cross-App Access flow (draft-ietf-oauth-identity-assertion-authz-grant-04).
 *
 * Generated because the OP was created with `--enable id-jag`. The OP plays
 * both roles:
 * - as the IdP it issues ID-JAGs on the token-exchange grant (issueIdJag);
 * - as a resource authorization server it redeems ID-JAGs from trusted IdPs on
 *   the jwt-bearer grant (redeemIdJag).
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change in
 * a breaking way between releases. Do not build production code on it without
 * pinning the version. The underlying specification is an IETF draft and may
 * itself change.
 */
import {
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  selectSigningKeyByAlg,
  type JwkSet,
  type SigningKey,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import {
  ID_JAG_TOKEN_TYPE,
  IdJagError,
  JWT_BEARER_GRANT_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  matchesIdJagIssuanceRequest,
  processIdJagIssuanceRequest,
  processIdJagRedemptionRequest,
  type IdJagAccessTokenInfo,
  type IdJagTrustedIdentityProvider,
} from '@maronn-openid-connect/experimental/id-jag';
import {
  accessTokenIssuer,
  config,
  idTokenHintJwks,
  resolvers,
  stores,
  type ProviderSigningKeys,
} from '../../provider';
import { noStoreJson, oauthError } from '../../http';
import { features } from '../../features';
import { idJagConfig } from './config';

/**
 * Issue an ID-JAG (draft §4.3): the subject_token must be an ID Token this OP
 * issued to the authenticated client, and the answer is a signed grant JWT for
 * the resource authorization server named by `audience` — not an access token
 * (the response carries token_type N_A). Errors are thrown as IdJagError and
 * answered by the token route.
 */
export async function issueIdJag(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  // Signed with a registered RS256 key so the peer AS can verify it against
  // this OP's JWKS endpoint (same key-selection contract as JARM: RS256 is
  // pinned, the first key of the set may be another alg).
  let signingKey: SigningKey;
  try {
    signingKey = selectSigningKeyByAlg(keys.general, 'RS256');
  } catch {
    return oauthError('server_error', 'No RS256 signing key registered for ID-JAG issuance', 500);
  }

  const response = await processIdJagIssuanceRequest({
    params,
    client,
    issuer: config.issuer,
    // The subject_token is verified against the keys id_token_hint uses (this
    // OP's own ID Token keys); draft §4.3.3 requires its audience to be the
    // authenticated client, which processIdJagIssuanceRequest checks.
    jwks: await idTokenHintJwks(keys),
    signingKey,
    allowedAudiences: idJagConfig.allowedAudiences,
    allowedScopes: idJagConfig.allowedScopes,
    lifetimeSeconds: idJagConfig.idJagLifetimeSeconds,
    // Extension (draft §9.7): when enabled, an actor_token is recorded as the
    // ID-JAG's act claim. Every accepted token type goes through the same
    // resolver, which owns the content validation.
    allowActorTokens: idJagConfig.allowActorTokens,
    ...(idJagConfig.actorTokenResolver === undefined
      ? {}
      : { actorTokenResolver: idJagConfig.actorTokenResolver }),
    ...(idJagConfig.allowRefreshTokenSubjects
      ? {
          refreshTokenResolver: resolvers.refreshTokenResolver,
          authenticationSessionResolver: resolvers.authenticationSessionResolver,
        }
      : {}),
  });

  // The ID-JAG itself is not persisted: it is a self-contained signed grant the
  // peer AS verifies by signature and exp.
  return noStoreJson(response);
}

/**
 * Redeem an ID-JAG on the jwt-bearer grant (RFC 7523 §2.1 / draft §4.4). The
 * assertion must be issued by one of idJagConfig.trustedIdentityProviders for
 * THIS issuer and the authenticated client; this OP then issues its own access
 * token. No ID Token (this is not an OIDC authentication) and no refresh token
 * (draft §4.4.3 SHOULD NOT — the still-valid ID-JAG can be presented again).
 */
export async function redeemIdJag(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  const grant = await processIdJagRedemptionRequest({
    params,
    client,
    issuer: config.issuer,
    identityProviders: await resolveTrustedIdentityProviders(),
    configuredExpiresIn: config.accessTokenExpiresIn,
  });

  // Same aud policy as the standard grants: the UserInfo endpoint stays a
  // permanent member (RFC 9068 §3); the ID-JAG's resource claim (RFC 8707)
  // contributes the requested resources.
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: `${config.issuer}/userinfo`,
    requested: grant.requestedResources,
    issuer: config.issuer,
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    audience,
    expiresIn: grant.expiresIn,
    issuedAt,
  });
  const accessToken = await accessTokenIssuer.issue({
    payload: {
      ...payload,
      // RFC 8693 §4.1: an act claim carried by the ID-JAG is preserved, so
      // downstream services still see WHO acts on the subject's behalf
      // (dropping it would silently turn the delegation into impersonation).
      ...(grant.actor === undefined ? {} : { act: grant.actor }),
    },
    privateKey: keys.general[0].privateKey,
    keyId: keys.general[0].keyId,
  });

  const metadata: IdJagAccessTokenInfo = {
    // draft §4.4.1: the ID-JAG's sub is used as the local subject directly
    // (subject resolution by identical sub; JIT provisioning is out of scope).
    sub: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    expiresAt: issuedAt + grant.expiresIn,
    // Each redemption is its own grant: revoking one issued token must not
    // affect tokens from other redemptions of the same (re-presentable) ID-JAG,
    // so the payload's own jti doubles as the grant id.
    grantId: payload.jti,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    jti: payload.jti,
    // The actor is persisted too, so opaque-token introspection and store-based
    // tooling can surface it just like the JWT claim.
    ...(grant.actor === undefined ? {} : { act: grant.actor }),
  };
  await stores.accessTokenStore.set(accessToken, metadata);

  return noStoreJson({
    access_token: accessToken,
    token_type: 'Bearer' as const,
    expires_in: grant.expiresIn,
    scope: grant.scope.join(' '),
  });
}

/**
 * jwks_uri cache for trusted identity providers. A fetched JWKS is reused for
 * 300 seconds, so a key rotation at the IdP can take up to that long to be
 * picked up. The fetch target comes exclusively from idJagConfig above — never
 * from request or assertion content — which keeps this endpoint SSRF-free.
 */
const idJagJwksCache = new Map<string, { jwks: JwkSet; expiresAt: number }>();
const ID_JAG_JWKS_CACHE_TTL_MS = 300_000;

async function resolveTrustedIdentityProviders(): Promise<IdJagTrustedIdentityProvider[]> {
  const resolved: IdJagTrustedIdentityProvider[] = [];
  for (const entry of idJagConfig.trustedIdentityProviders) {
    if (entry.jwks !== undefined) {
      resolved.push({ issuer: entry.issuer, jwks: entry.jwks });
      continue;
    }
    if (entry.jwksUri === undefined) {
      // An entry with neither jwks nor jwksUri can never verify anything; skip
      // it so the assertion is answered with the fixed untrusted description.
      continue;
    }
    const cached = idJagJwksCache.get(entry.jwksUri);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      resolved.push({ issuer: entry.issuer, jwks: cached.jwks });
      continue;
    }
    // A failed fetch propagates: the token route turns it into server_error,
    // which is honest — the assertion was never evaluated, so invalid_grant
    // would wrongly blame the client for an outage on this side.
    const response = await fetch(entry.jwksUri);
    if (!response.ok) {
      throw new Error(`Fetching the JWKS of trusted IdP ${entry.issuer} failed with status ${response.status}`);
    }
    const jwks = (await response.json()) as JwkSet;
    idJagJwksCache.set(entry.jwksUri, { jwks, expiresAt: Date.now() + ID_JAG_JWKS_CACHE_TTL_MS });
    resolved.push({ issuer: entry.issuer, jwks });
  }
  return resolved;
}

/**
 * The ID-JAG issuance block of the token endpoint (ID-JAG draft §4.3): the
 * answer to a token exchange that asks for an ID-JAG, undefined for any other
 * request. Checked before the plain token exchange, which shares the
 * grant_type URN.
 *
 * Without the token-exchange feature the exchange grant exists only to issue
 * ID-JAGs, and discovery advertises it for that: any other requested_token_type
 * is answered with a pointer instead of falling through to
 * unsupported_grant_type (RFC 6749 §5.2).
 */
export async function dispatchIdJagIssuance(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response | undefined> {
  if (!matchesIdJagIssuanceRequest(params)) {
    if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE && !features.some((feature) => feature.id === 'token-exchange')) {
      return oauthError(
        'invalid_request',
        `This authorization server only supports requested_token_type ${ID_JAG_TOKEN_TYPE} for token exchange`,
      );
    }
    return undefined;
  }
  return answerIdJagError(() => issueIdJag(params, client, keys));
}

/**
 * The ID-JAG redemption block of the token endpoint (ID-JAG draft §4.4 /
 * RFC 7523 §2.1): the answer to a jwt-bearer grant, undefined for any other
 * grant.
 */
export async function dispatchIdJagRedemption(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response | undefined> {
  if (params.grant_type !== JWT_BEARER_GRANT_TYPE) return undefined;
  return answerIdJagError(() => redeemIdJag(params, client, keys));
}

/** IdJagError in the RFC 6749 §5.2 shape. */
async function answerIdJagError(answer: () => Promise<Response>): Promise<Response> {
  try {
    return await answer();
  } catch (error) {
    if (error instanceof IdJagError) {
      return oauthError(error.code, error.errorDescription, error.statusCode);
    }
    throw error;
  }
}
