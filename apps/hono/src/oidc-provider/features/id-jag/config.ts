import type { JwkSet } from '@maronn-openid-connect/core';
import {
  TOKEN_TYPE_ID_TOKEN,
  resolveIdJagActor,
  type IdJagActorTokenResolver,
  type IdJagTrustedIdentityProvider,
} from '@maronn-openid-connect/experimental/id-jag';

/**
 * EXPERIMENTAL — Cross-App Access (XAA) / ID-JAG settings
 * (draft-ietf-oauth-identity-assertion-authz-grant-04).
 *
 * Issuing side (this OP as the IdP, draft §4.3):
 * - allowedAudiences: resource authorization server issuers this IdP may issue
 *   an ID-JAG for. Empty by default (fail safe): every issuance request is
 *   rejected with invalid_target until you list the peer AS issuers here.
 *   Adding an entry grants that cross-app connection on behalf of every user —
 *   there is no per-user consent screen in this flow.
 * - idJagLifetimeSeconds: ID-JAG lifetime. Keep it short (draft example: 300);
 *   clients are expected to request a fresh one instead of holding it.
 * - allowedScopes: optional cap on the scopes an ID-JAG may carry. undefined
 *   passes the requested scopes through (the resource AS applies its own
 *   policy again on redemption).
 * - allowRefreshTokenSubjects: whether a refresh token this OP issued may stand
 *   in for the ID Token as the subject_token (draft §4.3 MAY), so a client can
 *   request a fresh ID-JAG after its ID Token expired without a new SSO round
 *   trip. Validated exactly like the standard refresh_token grant (rotation
 *   reuse revokes the token family; online tokens require the login session to
 *   be alive); the refresh token is NOT consumed. Grants without the openid
 *   scope are refused — their refresh token replaces no identity assertion.
 * - allowActorTokens: whether an actor_token (identifying who acts on the
 *   subject's behalf) is accepted and recorded as the ID-JAG's act claim
 *   (RFC 8693 §4.1). The draft defines no normative actor processing (§9.7
 *   sketches extensions), so this is an opt-in extension and defaults to
 *   false — an actor_token is rejected until you flip it, whatever else is
 *   configured. Every token type identifier RFC 8693 §3 defines is accepted
 *   the same way; the type alone decides nothing.
 * - actorTokenResolver: validates the actor_token's CONTENT (signature,
 *   revocation, whose token it is) — for every accepted type, this OP's own
 *   ID Tokens included. The library only checks the request structure and the
 *   shape of what you return. Return the act value ({ sub, act? }) for a valid
 *   token, null for an invalid one (answered with a fixed invalid_request), or
 *   throw IdJagError to pick the response yourself. The default below handles
 *   ID Tokens this OP issued to the authenticated client; extend or replace it
 *   to cover the other types. Clearing it rejects every actor_token.
 *
 * Consuming side (this OP as the resource authorization server, draft §4.4):
 * - trustedIdentityProviders: the IdPs whose ID-JAGs are accepted on the
 *   jwt-bearer grant. Empty by default (fail safe). Keys come from the inline
 *   `jwks` when present, otherwise from `jwksUri` (fetched and cached below).
 *   Never derive the key source from the assertion itself.
 */
const defaultIdJagActorTokenResolver: IdJagActorTokenResolver = async ({
  actorToken,
  actorTokenType,
  clientId,
  issuer,
  jwks,
}) =>
  actorTokenType === TOKEN_TYPE_ID_TOKEN
    ? resolveIdJagActor({ actorToken, issuer, clientId, jwks })
    : null;

export const idJagConfig = {
  allowedAudiences: [] as string[],
  idJagLifetimeSeconds: 300,
  allowedScopes: undefined as string[] | undefined,
  allowRefreshTokenSubjects: true,
  allowActorTokens: false,
  actorTokenResolver: defaultIdJagActorTokenResolver as IdJagActorTokenResolver | undefined,
  trustedIdentityProviders: [] as Array<{ issuer: string; jwksUri?: string; jwks?: JwkSet }>,
};

/**
 * EXPERIMENTAL — jwks_uri cache for trusted identity providers.
 *
 * A fetched JWKS is reused for 300 seconds, so a signing-key rotation at the
 * IdP can take up to that long to be picked up (a verification that fails
 * within the window is answered as an untrusted assertion). The fetch target
 * comes exclusively from the static idJagConfig above — never from request or
 * assertion content — which is what keeps this endpoint SSRF-free.
 */
const idJagJwksCache = new Map<string, { jwks: JwkSet; expiresAt: number }>();
const ID_JAG_JWKS_CACHE_TTL_MS = 300_000;

export async function resolveTrustedIdentityProviders(): Promise<IdJagTrustedIdentityProvider[]> {
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
    // A failed fetch propagates: the generic catch turns it into server_error,
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
