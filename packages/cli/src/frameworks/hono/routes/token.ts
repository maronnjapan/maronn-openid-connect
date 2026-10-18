/**
 * Token endpoint (`routes/token.ts`) for the hono / express / fastify output.
 *
 * One fragment per step of the `token` endpoint of the flow catalog. The route
 * module is assembled by renderPipelineRoute(): every box of
 * `maronn-oidc graph --detail steps --endpoint token` is one exported function
 * below, and the handler calls them in the order of the catalog or of the
 * `--flow` document.
 */
import { DEFAULT_FEATURES } from '../../../registry.js';
import type { OidcFeatureConfig } from '../../../registry.js';
import { buildOpFlow } from '../../../flow/catalog.js';
import { EXPERIMENTAL_PACKAGE } from '../../packages.js';
import { renderPipelineRoute, type StepFragment } from '../pipeline.js';

const EXPERIMENTAL_NOTICE = ` * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change
 * in a breaking way between releases. Do not build production code on it
 * without pinning the version.`;

function tokenHeader(features: OidcFeatureConfig): string {
  const tokenExchangeConfigBlock = features.tokenExchange
    ? `
/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange settings (RFC 8693).
 *
 * - allowedTargets: the audience / resource values a client may ask an
 *   exchanged token to be issued for. Empty by default (fail safe): with an
 *   empty list every exchange that names a target is rejected with
 *   invalid_target, and only scope-narrowing / lifetime-shortening exchanges
 *   succeed. Add the identifiers of your downstream services here.
 */
export const tokenExchangeConfig = {
  allowedTargets: [] as string[],
};
`
    : '';
  const idJagRefreshConfigDoc =
    features.idJag && features.refreshToken
      ? `
 * - allowRefreshTokenSubjects: whether a refresh token this OP issued may stand
 *   in for the ID Token as the subject_token (draft §4.3 MAY), so a client can
 *   request a fresh ID-JAG after its ID Token expired without a new SSO round
 *   trip. Validated exactly like the standard refresh_token grant (rotation
 *   reuse revokes the token family; online tokens require the login session to
 *   be alive); the refresh token is NOT consumed. Grants without the openid
 *   scope are refused — their refresh token replaces no identity assertion.`
      : '';
  const idJagRefreshConfigField =
    features.idJag && features.refreshToken
      ? `
  allowRefreshTokenSubjects: true,`
      : '';
  const idJagConfigBlock = features.idJag
    ? `
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
 *   policy again on redemption).${idJagRefreshConfigDoc}
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
 *   \`jwks\` when present, otherwise from \`jwksUri\` (fetched and cached below).
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
  allowedScopes: undefined as string[] | undefined,${idJagRefreshConfigField}
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
    // A failed fetch propagates: the generic catch turns it into server_error,
    // which is honest — the assertion was never evaluated, so invalid_grant
    // would wrongly blame the client for an outage on this side.
    const response = await fetch(entry.jwksUri);
    if (!response.ok) {
      throw new Error(\`Fetching the JWKS of trusted IdP \${entry.issuer} failed with status \${response.status}\`);
    }
    const jwks = (await response.json()) as JwkSet;
    idJagJwksCache.set(entry.jwksUri, { jwks, expiresAt: Date.now() + ID_JAG_JWKS_CACHE_TTL_MS });
    resolved.push({ issuer: entry.issuer, jwks });
  }
  return resolved;
}
`
    : '';
  return `/**
 * Token endpoint (API layer).
 * OIDC Core 1.0 Section 3.1.3 / RFC 6749 Section 4.1.3
 *
 * Every function exported below is one box of the token endpoint's pipeline
 * (\`maronn-oidc graph --detail steps --endpoint token\`): parse the request,
 * authenticate the client, dispatch the experimental grants, validate the
 * grant, select the keys, resolve the subject, issue and store the tokens,
 * and answer. The handler at the bottom calls them in order; delete a call to
 * drop that step, or insert your own logic between two steps. A box that is
 * left out of a \`--flow\` document is left out of this file.
 */

/**
 * The form parameters of a token request: the fields OIDC Core / OAuth 2.1
 * name, plus every other field the client posted (the experimental grants
 * read their own parameters from it).
 */
export type TokenRequestBody = TokenRequestParams & Record<string, string>;

/** What the token endpoint answers; respondToken() turns it into HTTP. */
export interface TokenEndpointResponse {
  status: number;
  body: object;
  /** Headers beside the no-store pair every answer carries (e.g. WWW-Authenticate). */
  headers?: Record<string, string>;
}

/**
 * A failure a step answers with a fixed response: a malformed request (400)
 * or a server configuration problem (500). respondTokenError() sends the
 * response as it is.
 */
export class TokenEndpointError extends Error {
  constructor(readonly response: TokenEndpointResponse) {
    const details = response.body as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'token endpoint error'));
    this.name = 'TokenEndpointError';
  }
}
${tokenExchangeConfigBlock}${idJagConfigBlock}
export const tokenApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Narrows raw body params to the typed TokenRequestParams.
 * Returns false when the required grant_type field is absent.
 */
function isTokenRequestParams(
  params: unknown,
): params is TokenRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p['grant_type'] === 'string';
}

/**
 * Returns true when the Content-Type names application/x-www-form-urlencoded.
 * RFC 6749 §4.1.3 / Appendix B / OIDC Core 1.0 §3.1.3.1: the Token Request
 * entity-body MUST be application/x-www-form-urlencoded. Media types are
 * case-insensitive (RFC 9110 §8.3.1) and may carry parameters such as
 * "; charset=UTF-8", so we lowercase and strip everything after the first ';'.
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}`;
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

const PARSE_REQUEST: StepFragment = {
  imports: { core: ['type TokenRequestParams'] },
  definition: `/**
 * Parse the token request: the form body and the Authorization header.
 * RFC 6749 §4.1.3 / §3.2 / OIDC Core 1.0 §3.1.3.1
 *
 * Rejects (TokenEndpointError, 400 invalid_request) a body that is not
 * application/x-www-form-urlencoded, a repeated parameter and a missing
 * grant_type before anything is consumed as token parameters.
 */
export async function parseTokenRequest(
  c: any,
): Promise<{ params: TokenRequestBody; authorization: string }> {
  // RFC 6749 §4.1.3 / OIDC Core 1.0 §3.1.3.1: reject any body that is not
  // application/x-www-form-urlencoded (e.g. multipart/form-data, application/json)
  // before parsing so a non-form payload is never consumed as token parameters.
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    throw new TokenEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Token requests must use application/x-www-form-urlencoded' },
    });
  }

  // RFC 6749 §3.2: token endpoint request parameters MUST NOT be repeated.
  // Read the raw form body so URLSearchParams iteration exposes duplicate keys
  // instead of letting parseBody silently keep only the last value.
  const rawBody = await c.req.text();
  const searchParams = new URLSearchParams(rawBody);
  const rawParams: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    rawParams[key] = value;
  }
  const authorization = c.req.header('Authorization') ?? '';

  if (duplicateKey !== undefined) {
    throw new TokenEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: \`Parameter "\${duplicateKey}" must not be repeated\` },
    });
  }

  if (!isTokenRequestParams(rawParams)) {
    throw new TokenEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Missing required parameter: grant_type' },
    });
  }

  return { params: rawParams, authorization };
}`,
  call: { bind: ['params', 'authorization'], expression: 'await parseTokenRequest(c)' },
};

const AUTHENTICATE_CLIENT: StepFragment = {
  imports: {
    core: [
      'extractClientCredentials',
      'resolveAuthenticatedTokenClient',
      'validateClientAuthMethod',
      'verifyClientSecret',
      'type TokenClientInfo',
    ],
    resolvers: ['tokenClientResolver as defaultTokenClientResolver'],
  },
  definition: `/**
 * Authenticate the client.
 * OAuth 2.1 §2.3 / OIDC Core 1.0 §9: client_secret_basic / client_secret_post.
 *
 * Each step inside is an independent core function. Replace verifyClientSecret
 * with your own assertion check (e.g. private_key_jwt) without touching the rest.
 */
export async function authenticateTokenClient(
  c: any,
  params: TokenRequestBody,
  authorization: string,
): Promise<{ tokenClient: TokenClientInfo; authenticatedClientId: string }> {
  const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;

  // Read the presented credentials and which method was actually used.
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });

  // RFC 6749 §5.2: the presented client_id must resolve to a registered client.
  const tokenClient = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );

  // OIDC Core 1.0 §9: the method used must be one the client registered
  // (blocks auth method downgrade / public-client mixups).
  validateClientAuthMethod(tokenClient, presentedCredentials);

  // OAuth 2.1 §7.4.1: constant-time client_secret comparison.
  await verifyClientSecret(tokenClient, presentedCredentials.clientSecret);

  return { tokenClient, authenticatedClientId: presentedCredentials.clientId };
}`,
  call: {
    bind: ['tokenClient', 'authenticatedClientId'],
    expression: 'await authenticateTokenClient(c, params, authorization)',
  },
};

function dispatchCall(local: string, expression: string): string {
  return `    const ${local} = ${expression};
    if (${local}) return respondToken(c, ${local});`;
}

function idJagIssuanceFragment(features: OidcFeatureConfig): StepFragment {
  const refreshSubjectArgs = features.refreshToken
    ? `
      ...(idJagConfig.allowRefreshTokenSubjects
        ? {
            refreshTokenResolver: c.get('refreshTokenResolver') ?? defaultRefreshTokenResolver,
            authenticationSessionResolver:
              c.get('authenticationSessionResolver') ?? defaultAuthenticationSessionResolver,
          }
        : {}),`
    : '';
  const tokenExchangeFallback = features.tokenExchange
    ? ''
    : `

  // Generated without --enable token-exchange: the exchange grant exists here
  // only to issue ID-JAGs, so any other requested_token_type is answered with
  // a pointer instead of falling through to unsupported_grant_type (discovery
  // does advertise the exchange grant in this build).
  if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: \`This authorization server only supports requested_token_type \${ID_JAG_TOKEN_TYPE} for token exchange\`,
      },
    };
  }`;
  return {
    imports: {
      core: ['selectSigningKeyByAlg', 'type SigningKey', 'type TokenClientInfo'],
      resolvers: features.refreshToken
        ? [
            'refreshTokenResolver as defaultRefreshTokenResolver',
            'authenticationSessionResolver as defaultAuthenticationSessionResolver',
          ]
        : [],
      modules: {
        [`${EXPERIMENTAL_PACKAGE}/id-jag`]: [
          'matchesIdJagIssuanceRequest',
          'processIdJagIssuanceRequest',
          ...(features.tokenExchange ? [] : ['ID_JAG_TOKEN_TYPE', 'TOKEN_EXCHANGE_GRANT_TYPE']),
        ],
      },
    },
    definition: `/**
 * EXPERIMENTAL — ID-JAG issuance (Cross-App Access, draft §4.3).
 *
 * A token-exchange request whose requested_token_type is the ID-JAG URN.
 * Dispatched right after client authentication and BEFORE the plain
 * token-exchange step (same grant_type URN) and the grant_type validation. The
 * subject_token must be an ID Token this OP issued to the authenticated client;
 * the result is a signed grant JWT for the resource authorization server named
 * by \`audience\` — not an access token (the response carries token_type N_A).
 * Returns undefined for any other request, so the pipeline continues.
 *
${EXPERIMENTAL_NOTICE}
 * The underlying specification is an IETF draft (-04) and may itself change.
 */
export async function issueIdJag(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
): Promise<TokenEndpointResponse | undefined> {
  if (matchesIdJagIssuanceRequest(params)) {
    const idJagIssuanceConfig = c.get('config');
    // The ID-JAG is signed with a registered RS256 key so the peer AS can
    // verify it against this OP's JWKS endpoint (same key-selection contract
    // as JARM: RS256 is pinned, the first key of the set may be another alg).
    const idJagSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
    let idJagSigningKey: SigningKey;
    try {
      idJagSigningKey = selectSigningKeyByAlg(idJagSigningKeys, 'RS256');
    } catch {
      throw new TokenEndpointError({
        status: 500,
        body: { error: 'server_error', error_description: 'No RS256 signing key registered for ID-JAG issuance' },
      });
    }
    // The subject_token is verified against the same JWKS that id_token_hint
    // uses (the OP's own ID Token signing keys) — draft §4.3.3 requires the
    // assertion's audience to be the authenticated client, which
    // processIdJagIssuanceRequest checks.
    const idJagJwks = await c.get('jwksProvider')();

    const idJagIssuanceResponse = await processIdJagIssuanceRequest({
      params,
      client: tokenClient,
      issuer: idJagIssuanceConfig.issuer,
      jwks: idJagJwks,
      signingKey: idJagSigningKey,
      allowedAudiences: idJagConfig.allowedAudiences,
      allowedScopes: idJagConfig.allowedScopes,
      lifetimeSeconds: idJagConfig.idJagLifetimeSeconds,
      // Extension (draft §9.7): when enabled, an actor_token is recorded as
      // the ID-JAG's act claim. Every accepted token type goes through the
      // same resolver, which owns the content validation.
      allowActorTokens: idJagConfig.allowActorTokens,
      ...(idJagConfig.actorTokenResolver === undefined
        ? {}
        : { actorTokenResolver: idJagConfig.actorTokenResolver }),${refreshSubjectArgs}
    });

    // RFC 6749 §5.1: token responses MUST NOT be cached. The ID-JAG itself is
    // not persisted — it is a self-contained signed grant the peer AS
    // verifies by signature and exp.
    return { status: 200, body: idJagIssuanceResponse };
  }${tokenExchangeFallback}
  return undefined;
}`,
    call: dispatchCall('idJagIssuance', 'await issueIdJag(c, params, tokenClient)'),
  };
}

const ID_JAG_REDEMPTION: StepFragment = {
  imports: {
    core: [
      'buildAccessTokenAudience',
      'buildAccessTokenPayload',
      'createJwtAccessTokenIssuer',
      'createOpaqueAccessTokenIssuer',
      'type AccessTokenIssuer',
      'type SigningKey',
      'type TokenClientInfo',
    ],
    store: ['accessTokenStore as defaultAccessTokenStore'],
    modules: {
      [`${EXPERIMENTAL_PACKAGE}/id-jag`]: [
        'JWT_BEARER_GRANT_TYPE',
        'processIdJagRedemptionRequest',
        'type IdJagAccessTokenInfo',
      ],
    },
  },
  definition: `/**
 * EXPERIMENTAL — ID-JAG redemption (Cross-App Access, draft §4.4).
 *
 * The jwt-bearer grant (RFC 7523 §2.1). The assertion must be an ID-JAG
 * (typ oauth-id-jag+jwt) issued by one of idJagConfig.trustedIdentityProviders
 * for THIS issuer and for the authenticated client. This OP then issues its
 * own access token — the IdP never mints tokens for this AS. Returns undefined
 * for any other grant_type, so the pipeline continues.
 *
 * No ID Token is issued (this is not an OIDC authentication flow: the
 * openid scope only grants UserInfo access) and no refresh token is issued
 * (draft §4.4.3 SHOULD NOT — re-presenting the still-valid ID-JAG replaces
 * the refresh token).
 *
${EXPERIMENTAL_NOTICE}
 */
export async function redeemIdJag(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
): Promise<TokenEndpointResponse | undefined> {
  if (params.grant_type !== JWT_BEARER_GRANT_TYPE) return undefined;

  const accessTokenStore = c.get('accessTokenStore') ?? defaultAccessTokenStore;
  const idJagRedemptionConfig = c.get('config');
  const idJagIdentityProviders = await resolveTrustedIdentityProviders();

  const idJagGrant = await processIdJagRedemptionRequest({
    params,
    client: tokenClient,
    issuer: idJagRedemptionConfig.issuer,
    identityProviders: idJagIdentityProviders,
    configuredExpiresIn: idJagRedemptionConfig.accessTokenExpiresIn,
  });

  // The first registered key signs new tokens (SigningKeyProvider contract).
  const idJagAccessTokenSigningKey: SigningKey = c.get('signingKeys')[0];
  const idJagTokenIssuer: AccessTokenIssuer =
    idJagRedemptionConfig.accessTokenFormat === 'opaque'
      ? createOpaqueAccessTokenIssuer()
      : createJwtAccessTokenIssuer();

  // Same aud policy as the standard grants: the UserInfo endpoint stays a
  // permanent member (RFC 9068 §3); the ID-JAG's resource claim (RFC 8707)
  // contributes the requested resources.
  const idJagAudience = buildAccessTokenAudience({
    userInfoEndpoint: \`\${idJagRedemptionConfig.issuer}/userinfo\`,
    requested: idJagGrant.requestedResources,
    issuer: idJagRedemptionConfig.issuer,
  });

  const idJagIssuedAt = Math.floor(Date.now() / 1000);
  const idJagAccessTokenPayload = buildAccessTokenPayload({
    issuer: idJagRedemptionConfig.issuer,
    subject: idJagGrant.subject,
    clientId: idJagGrant.clientId,
    scope: idJagGrant.scope,
    audience: idJagAudience,
    expiresIn: idJagGrant.expiresIn,
    issuedAt: idJagIssuedAt,
  });
  const idJagAccessToken = await idJagTokenIssuer.issue({
    payload: {
      ...idJagAccessTokenPayload,
      // RFC 8693 §4.1: an act claim carried by the ID-JAG is preserved on
      // the issued access token, so downstream services still see WHO acts
      // on the subject's behalf (dropping it would silently turn the
      // delegation into impersonation).
      ...(idJagGrant.actor === undefined ? {} : { act: idJagGrant.actor }),
    },
    privateKey: idJagAccessTokenSigningKey.privateKey,
    keyId: idJagAccessTokenSigningKey.keyId,
  });

  const idJagAccessTokenMetadata: IdJagAccessTokenInfo = {
    // draft §4.4.1: the ID-JAG's sub is used as the local subject directly
    // (subject resolution by identical sub; JIT provisioning is out of scope).
    sub: idJagGrant.subject,
    clientId: idJagGrant.clientId,
    scope: idJagGrant.scope,
    expiresAt: idJagIssuedAt + idJagGrant.expiresIn,
    // Each redemption is its own grant: revoking one issued token must not
    // affect tokens from other redemptions of the same (re-presentable)
    // ID-JAG, so the payload's own jti doubles as the grant id.
    grantId: idJagAccessTokenPayload.jti,
    iat: idJagIssuedAt,
    nbf: idJagIssuedAt,
    audience: idJagAudience,
    issuer: idJagRedemptionConfig.issuer,
    jti: idJagAccessTokenPayload.jti,
    // The actor record is persisted too, so opaque-token introspection and
    // store-based tooling can surface it just like the JWT claim.
    ...(idJagGrant.actor === undefined ? {} : { act: idJagGrant.actor }),
  };
  await accessTokenStore.set(idJagAccessToken, idJagAccessTokenMetadata);

  return {
    status: 200,
    body: {
      access_token: idJagAccessToken,
      token_type: 'Bearer' as const,
      expires_in: idJagGrant.expiresIn,
      scope: idJagGrant.scope.join(' '),
    },
  };
}`,
  call: dispatchCall('idJagRedemption', 'await redeemIdJag(c, params, tokenClient)'),
};

const TOKEN_EXCHANGE: StepFragment = {
  imports: {
    core: [
      'buildAccessTokenAudience',
      'buildAccessTokenPayload',
      'createJwtAccessTokenIssuer',
      'createOpaqueAccessTokenIssuer',
      'type AccessTokenIssuer',
      'type SigningKey',
      'type TokenClientInfo',
    ],
    resolvers: ['accessTokenResolver as defaultAccessTokenResolver'],
    store: ['accessTokenStore as defaultAccessTokenStore'],
    modules: {
      [`${EXPERIMENTAL_PACKAGE}/token-exchange`]: [
        'TOKEN_EXCHANGE_GRANT_TYPE',
        'buildTokenExchangeResponse',
        'processTokenExchangeRequest',
        'type ExchangedAccessTokenInfo',
      ],
    },
  },
  definition: `/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange (RFC 8693 §2.1).
 *
 * Dispatched right after client authentication and BEFORE the grant_type
 * validation, which does not know the URN and would reject it with
 * unsupported_grant_type. Answers the request itself and never falls through
 * to the standard grants; returns undefined for any other grant_type.
 *
${EXPERIMENTAL_NOTICE}
 *
 * Known limitation: RFC 8693 §2.1 permits repeated \`resource\` / \`audience\`
 * parameters, but this endpoint rejects any repeated parameter (RFC 6749
 * §3.2), so only a single value of each is supported.
 */
export async function exchangeToken(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
): Promise<TokenEndpointResponse | undefined> {
  if (params.grant_type !== TOKEN_EXCHANGE_GRANT_TYPE) return undefined;

  const accessTokenResolver = c.get('accessTokenResolver') ?? defaultAccessTokenResolver;
  const accessTokenStore = c.get('accessTokenStore') ?? defaultAccessTokenStore;
  const exchangeConfig = c.get('config');
  // The first registered key signs new tokens (SigningKeyProvider contract).
  const exchangeSigningKey: SigningKey = c.get('signingKeys')[0];
  const exchangeIssuer: AccessTokenIssuer =
    exchangeConfig.accessTokenFormat === 'opaque'
      ? createOpaqueAccessTokenIssuer()
      : createJwtAccessTokenIssuer();

  // Validate the request and derive the issuing material. Each check inside
  // is also exported as its own step function, so you can call them one by
  // one instead and drop or replace individual rules.
  const grant = await processTokenExchangeRequest({
    params,
    client: tokenClient,
    accessTokenResolver,
    allowedTargets: tokenExchangeConfig.allowedTargets,
    configuredExpiresIn: exchangeConfig.accessTokenExpiresIn,
  });

  // Same aud policy as the standard grants: the UserInfo endpoint stays a
  // permanent member (RFC 9068 §3), so an exchanged token still passes the
  // UserInfo endpoint's audience check.
  const exchangeAudience = buildAccessTokenAudience({
    userInfoEndpoint: \`\${exchangeConfig.issuer}/userinfo\`,
    requested: grant.requestedAudience,
    issuer: exchangeConfig.issuer,
  });

  const exchangeIssuedAt = Math.floor(Date.now() / 1000);
  const exchangePayload = buildAccessTokenPayload({
    issuer: exchangeConfig.issuer,
    subject: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    audience: exchangeAudience,
    expiresIn: grant.expiresIn,
    issuedAt: exchangeIssuedAt,
  });
  const exchangedToken = await exchangeIssuer.issue({
    payload: {
      ...exchangePayload,
      // RFC 8693 §4.1: a delegation exchange records the current actor in
      // the act claim (chains already nested by processTokenExchangeRequest).
      // Impersonation exchanges carry no act claim.
      ...(grant.actor === undefined ? {} : { act: grant.actor }),
    },
    privateKey: exchangeSigningKey.privateKey,
    keyId: exchangeSigningKey.keyId,
  });

  const exchangeMetadata: ExchangedAccessTokenInfo = {
    // RFC 8693 §1.1: the exchanged token acts as the same subject, but is
    // bound to the client that requested the exchange.
    sub: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    expiresAt: exchangeIssuedAt + grant.expiresIn,
    // Inherit the subject token's grant so revoking the grant (e.g. on code
    // reuse detection) also kills every token exchanged from it.
    grantId: grant.grantId,
    iat: exchangeIssuedAt,
    nbf: exchangeIssuedAt,
    audience: exchangeAudience,
    issuer: exchangeConfig.issuer,
    // RFC 9068 §2.2 / RFC 7662 §2.2: the exchanged token gets its own jti,
    // so it is a distinct store record even when it is exchanged twice from
    // the same subject_token within one second.
    jti: exchangePayload.jti,
    // Persisting act lets a later exchange that presents THIS token as its
    // subject_token pick up the chain (RFC 8693 §4.1 nesting).
    ...(grant.actor === undefined ? {} : { act: grant.actor }),
    // The subject token's stored claims parameter (OIDC Core 1.0 §5.5) is
    // deliberately NOT inherited: an exchanged token yields scope-based
    // claims only at the UserInfo endpoint.
  };
  await accessTokenStore.set(exchangedToken, exchangeMetadata);

  // RFC 8693 §2.2.1: access_token / issued_token_type / token_type are
  // REQUIRED; expires_in and scope are always included here.
  return {
    status: 200,
    body: buildTokenExchangeResponse({
      accessToken: exchangedToken,
      expiresIn: grant.expiresIn,
      scope: grant.scope,
    }),
  };
}`,
  call: dispatchCall('exchanged', 'await exchangeToken(c, params, tokenClient)'),
};

/**
 * The device_code and CIBA grants issue the same tokens from an approved
 * record, so the two fragments share one body with the names swapped.
 */
function approvedRecordGrantFragment(
  features: OidcFeatureConfig,
  spec: {
    id: 'device' | 'ciba';
    functionName: string;
    local: string;
    module: string;
    grantConstant: string;
    processFunction: string;
    storeName: string;
    doc: string;
    stateMachineComment: string;
    idTokenComment: string;
    refreshComment: string;
    noncePolicyComment: string;
    grantIdComment: string;
    noResourceComment: string;
  },
): StepFragment {
  const prefix = spec.id;
  const refreshTokenBlock = features.refreshToken
    ? `
${spec.refreshComment}
  const ${prefix}RefreshToken = ${prefix}Grant.scope.includes('offline_access')
    ? generateRandomString(32)
    : undefined;
  if (${prefix}RefreshToken) {
    const ${prefix}RefreshTokenStore = c.get('refreshTokenStore') ?? defaultRefreshTokenStore;
    await ${prefix}RefreshTokenStore.set(${prefix}RefreshToken, {
      subject: ${prefix}Grant.subject,
      clientId: ${prefix}Grant.clientId,
      scope: ${prefix}Grant.scope,
      // OAuth 2.1 §6.1: absolute lifetime from initial issuance; rotations
      // inherit originalIssuedAt so the deadline never slides forward.
      expiresAt: ${prefix}IssuedAt + ${prefix}Config.refreshTokenAbsoluteLifetime,
      originalIssuedAt: ${prefix}IssuedAt,
      used: false,
      grantId: ${prefix}Grant.grantId,
      iat: ${prefix}IssuedAt,
      issuer: ${prefix}Config.issuer,
      audience: ${prefix}Audience,
      authTime: ${prefix}Grant.authTime,
${spec.noncePolicyComment}
      nonce: undefined,
      acr: ${prefix}Acr,
      amr: ${prefix}Amr,
      azp: undefined,
    });
  }
`
    : '';
  const refreshTokenField = features.refreshToken
    ? `
      refresh_token: ${prefix}RefreshToken,`
    : '';
  return {
    imports: {
      core: [
        'buildAccessTokenAudience',
        'buildAccessTokenPayload',
        'buildIdTokenPayload',
        'computeAtHash',
        'createJwtAccessTokenIssuer',
        'createOpaqueAccessTokenIssuer',
        'generateIdToken',
        'resolveAcrAmr',
        'selectSigningKeyByAlg',
        ...(features.refreshToken ? ['generateRandomString'] : []),
        'type AccessTokenIssuer',
        'type AcrResolver',
        'type SigningKey',
        'type TokenClientInfo',
      ],
      resolvers: ['tokenClientResolver as defaultTokenClientResolver'],
      store: [
        'accessTokenStore as defaultAccessTokenStore',
        ...(features.refreshToken ? ['refreshTokenStore as defaultRefreshTokenStore'] : []),
        `${spec.storeName} as default${spec.storeName[0]?.toUpperCase()}${spec.storeName.slice(1)}`,
      ],
      config: ['type RegisteredClient'],
      modules: {
        [`${EXPERIMENTAL_PACKAGE}/${spec.module}`]: [spec.grantConstant, spec.processFunction],
      },
    },
    definition: `${spec.doc}
export async function ${spec.functionName}(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
  authenticatedClientId: string,
): Promise<TokenEndpointResponse | undefined> {
  if (params.grant_type !== ${spec.grantConstant}) return undefined;

  const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
  const accessTokenStore = c.get('accessTokenStore') ?? defaultAccessTokenStore;
  const ${prefix}Store = c.get('${spec.storeName}') ?? default${spec.storeName[0]?.toUpperCase()}${spec.storeName.slice(1)};

${spec.stateMachineComment}
  const ${prefix}Grant = await ${spec.processFunction}({
    params,
    client: tokenClient,
    store: ${prefix}Store,
  });

  const ${prefix}Config = c.get('config');
  // The first registered key signs new tokens (SigningKeyProvider contract).
  const ${prefix}SigningKey: SigningKey = c.get('signingKeys')[0];
  const ${prefix}PrivateKey = ${prefix}SigningKey.privateKey;
  const ${prefix}KeyId = ${prefix}SigningKey.keyId;
  // T-022: the ID Token this grant issues follows the SAME key-selection rule
  // as the standard grants — pick a registered ID Token key whose alg matches
  // the client's id_token_signed_response_alg (OIDC Dynamic Client
  // Registration 1.0 §2), not simply the first key of the set. Using the
  // first key would hand an ES256-registered client an RS256 ID Token, which
  // it rejects, and would hash at_hash with the wrong algorithm.
  const ${prefix}IdTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
  const ${prefix}RegisteredClient = (await tokenClientResolver.findClient(
    authenticatedClientId,
  )) as RegisteredClient | null;
  const ${prefix}RequestedIdTokenAlg = ${prefix}RegisteredClient?.idTokenSignedResponseAlg;
  let ${prefix}SelectedIdTokenKey: SigningKey;
  try {
    ${prefix}SelectedIdTokenKey = selectSigningKeyByAlg(${prefix}IdTokenSigningKeys, ${prefix}RequestedIdTokenAlg);
  } catch {
    throw new TokenEndpointError({
      status: 500,
      body: {
        error: 'server_error',
        error_description: \`No ID Token signing key registered for alg "\${${prefix}RequestedIdTokenAlg ?? 'RS256'}"\`,
      },
    });
  }
  const ${prefix}IdTokenPrivateKey = ${prefix}SelectedIdTokenKey.privateKey;
  const ${prefix}IdTokenKeyId = ${prefix}SelectedIdTokenKey.keyId;
  const ${prefix}Issuer: AccessTokenIssuer =
    ${prefix}Config.accessTokenFormat === 'opaque'
      ? createOpaqueAccessTokenIssuer()
      : createJwtAccessTokenIssuer();

${spec.noResourceComment}
  const ${prefix}Audience = buildAccessTokenAudience({
    userInfoEndpoint: \`\${${prefix}Config.issuer}/userinfo\`,
    issuer: ${prefix}Config.issuer,
  });

  const ${prefix}IssuedAt = Math.floor(Date.now() / 1000);
  const ${prefix}AccessTokenPayload = buildAccessTokenPayload({
    issuer: ${prefix}Config.issuer,
    subject: ${prefix}Grant.subject,
    clientId: ${prefix}Grant.clientId,
    scope: ${prefix}Grant.scope,
    audience: ${prefix}Audience,
    expiresIn: ${prefix}Config.accessTokenExpiresIn,
    issuedAt: ${prefix}IssuedAt,
  });
  const ${prefix}AccessToken = await ${prefix}Issuer.issue({
    payload: ${prefix}AccessTokenPayload,
    privateKey: ${prefix}PrivateKey,
    keyId: ${prefix}KeyId,
  });

${spec.idTokenComment}
  const ${prefix}AtHash = await computeAtHash(${prefix}AccessToken, ${prefix}IdTokenPrivateKey);
  const ${prefix}AcrResolver = c.get('acrResolver') as AcrResolver | undefined;
  const { acr: ${prefix}Acr, amr: ${prefix}Amr } = await resolveAcrAmr({
    subject: ${prefix}Grant.subject,
    clientId: ${prefix}Grant.clientId,
    acrResolver: ${prefix}AcrResolver,
  });
  const ${prefix}IdTokenPayload = buildIdTokenPayload({
    issuer: ${prefix}Config.issuer,
    subject: ${prefix}Grant.subject,
    clientId: ${prefix}Grant.clientId,
    scope: ${prefix}Grant.scope,
    expiresIn: ${prefix}Config.idTokenExpiresIn,
    issuedAt: ${prefix}IssuedAt,
    atHash: ${prefix}AtHash,
    authTime: ${prefix}Grant.authTime,
    acr: ${prefix}Acr,
    amr: ${prefix}Amr,
  });
  const ${prefix}IdToken = await generateIdToken({
    payload: ${prefix}IdTokenPayload,
    privateKey: ${prefix}IdTokenPrivateKey,
    keyId: ${prefix}IdTokenKeyId,
  });

  await accessTokenStore.set(${prefix}AccessToken, {
    sub: ${prefix}Grant.subject,
    clientId: ${prefix}Grant.clientId,
    scope: ${prefix}Grant.scope,
    expiresAt: ${prefix}IssuedAt + ${prefix}Config.accessTokenExpiresIn,
${spec.grantIdComment}
    grantId: ${prefix}Grant.grantId,
    iat: ${prefix}IssuedAt,
    nbf: ${prefix}IssuedAt,
    audience: ${prefix}Audience,
    issuer: ${prefix}Config.issuer,
    jti: ${prefix}AccessTokenPayload.jti,
  });
${refreshTokenBlock}
  return {
    status: 200,
    body: {
      access_token: ${prefix}AccessToken,
      token_type: 'Bearer' as const,
      expires_in: ${prefix}Config.accessTokenExpiresIn,
      id_token: ${prefix}IdToken,
      scope: ${prefix}Grant.scope.join(' '),${refreshTokenField}
    },
  };
}`,
    call: dispatchCall(
      spec.local,
      `await ${spec.functionName}(c, params, tokenClient, authenticatedClientId)`,
    ),
  };
}

function deviceCodeFragment(features: OidcFeatureConfig): StepFragment {
  return approvedRecordGrantFragment(features, {
    id: 'device',
    functionName: 'redeemDeviceCode',
    local: 'deviceGrantResponse',
    module: 'device-authorization-grant',
    grantConstant: 'DEVICE_CODE_GRANT_TYPE',
    processFunction: 'processDeviceCodeGrant',
    storeName: 'deviceAuthorizationStore',
    doc: `/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628 §3.4).
 *
 * Dispatched right after client authentication and BEFORE the grant_type
 * validation, which does not know the URN and would reject it with
 * unsupported_grant_type. Answers the request itself and never falls through
 * to the standard grants; returns undefined for any other grant_type.
 *
${EXPERIMENTAL_NOTICE}
 */`,
    stateMachineComment: `  // RFC 8628 §3.5 state machine. Everything except "approved" throws:
  // authorization_pending / slow_down / access_denied / expired_token, plus
  // invalid_request / invalid_grant / unauthorized_client from §3.4.`,
    idTokenComment: `  // The device authorization endpoint requires the openid scope, so an ID
  // Token is always issued. It carries no nonce (RFC 8628 defines no such
  // parameter, and OIDC Core 1.0 §2 only requires nonce when the
  // authentication request carried one) and no c_hash (there is no code).`,
    refreshComment: `  // OIDC Core 1.0 §11: offline_access survived the device authorization
  // endpoint's policy check only if this client may hold refresh tokens, and
  // the approval screen the user just went through IS the explicit consent
  // that §11 asks for. Nothing further to gate on here.`,
    noncePolicyComment: `      // RFC 8628 has no nonce parameter, so the re-issued ID Token has none
      // to preserve either.`,
    grantIdComment: `    // Inherit the grantId minted at approval so revoking the grant kills
    // every token issued from this device authorization.`,
    noResourceComment: `  // Same aud policy as the standard grants: the UserInfo endpoint stays a
  // permanent member (RFC 9068 §3). RFC 8628 has no resource parameter, so
  // nothing else is requested.`,
  });
}

function cibaGrantFragment(features: OidcFeatureConfig): StepFragment {
  return approvedRecordGrantFragment(features, {
    id: 'ciba',
    functionName: 'redeemCibaRequest',
    local: 'cibaGrantResponse',
    module: 'ciba',
    grantConstant: 'CIBA_GRANT_TYPE',
    processFunction: 'processCibaGrant',
    storeName: 'cibaAuthenticationRequestStore',
    doc: `/**
 * EXPERIMENTAL — CIBA grant (CIBA Core 1.0 §10.1, poll mode).
 *
 * Dispatched right after client authentication and BEFORE the grant_type
 * validation, which does not know the URN and would reject it with
 * unsupported_grant_type. Answers the request itself and never falls through
 * to the standard grants; returns undefined for any other grant_type.
 *
${EXPERIMENTAL_NOTICE}
 */`,
    stateMachineComment: `  // CIBA §11 state machine. Everything except "approved" throws:
  // authorization_pending / slow_down / access_denied / expired_token, plus
  // invalid_request / invalid_grant.`,
    idTokenComment: `  // The backchannel authentication endpoint requires the openid scope, so
  // an ID Token is always issued. It carries no nonce (CIBA §7.1 defines no
  // such parameter, and OIDC Core 1.0 §2 only requires nonce when the
  // authentication request carried one) and no c_hash (there is no code).
  // Poll mode adds no CIBA-specific claims either — the auth_req_id claim
  // of §10.3.1 belongs to the push-mode token delivery message.`,
    refreshComment: `  // OIDC Core 1.0 §11: offline_access survived the backchannel
  // authentication endpoint's policy check only if this client may hold
  // refresh tokens, and the approval screen the user just went through IS
  // the explicit consent that §11 asks for. Nothing further to gate on here.`,
    noncePolicyComment: `      // CIBA §7.1 defines no nonce parameter, so the re-issued ID Token has
      // none to preserve either.`,
    grantIdComment: `    // Inherit the grantId minted at approval so revoking the grant kills
    // every token issued from this backchannel authentication.`,
    noResourceComment: `  // Same aud policy as the standard grants: the UserInfo endpoint stays a
  // permanent member (RFC 9068 §3). CIBA §7.1 has no resource parameter,
  // so nothing else is requested.`,
  });
}

function validateGrantTypeFragment(features: OidcFeatureConfig): StepFragment {
  const supportedStep = features.refreshToken
    ? `  // RFC 6749 §5.2: is the grant_type offered by this OP at all?
  // (defaults to ['authorization_code', 'refresh_token'])
  const grantType = validateGrantTypeSupported(params.grant_type);`
    : `  // The refresh_token feature is disabled: the OP only offers the
  // authorization_code grant, so refresh_token requests are rejected with
  // unsupported_grant_type (RFC 6749 §5.2).
  const grantType = validateGrantTypeSupported(params.grant_type, ['authorization_code']);`;
  return {
    imports: {
      core: ['validateGrantTypeSupported', 'validateClientGrantType', 'type TokenClientInfo', 'type TokenRequestParams'],
    },
    definition: `/**
 * Validate grant_type: offered by this OP, and allowed for this client.
 * RFC 6749 §5.2 (unsupported_grant_type / unauthorized_client)
 */
export function validateTokenGrantType(
  params: TokenRequestParams,
  tokenClient: TokenClientInfo,
): 'authorization_code' | 'refresh_token' {
${supportedStep}

  // RFC 6749 §5.2: per-client grant_type authorization (unauthorized_client).
  validateClientGrantType(tokenClient, grantType);

  return grantType;
}`,
    call: { bind: 'grantType', expression: 'validateTokenGrantType(params, tokenClient)' },
  };
}

function authorizationCodeGrantFragment(features: OidcFeatureConfig): StepFragment {
  const call = features.refreshToken
    ? `    const validatedRequest: ValidatedTokenRequest =
      grantType === 'refresh_token'
        ? await validateRefreshTokenGrant(c, params, authenticatedClientId)
        : await validateAuthorizationCodeGrant(c, params, authenticatedClientId);`
    : `    const validatedRequest: ValidatedTokenRequest = await validateAuthorizationCodeGrant(
      c,
      params,
      authenticatedClientId,
    );`;
  return {
    imports: {
      core: [
        'resolveAuthorizationCode',
        'validateAuthorizationCodeUnused',
        'validateAuthorizationCodeClient',
        'validateAuthorizationCodeExpiration',
        'validateAuthorizationCodeRedirectUri',
        'verifyAuthorizationCodePkce',
        'consumeAuthorizationCode',
        'buildValidatedAuthorizationCodeRequest',
        'type TokenRequestParams',
        'type ValidatedAuthorizationCodeRequest',
        'type ValidatedTokenRequest',
      ],
      resolvers: ['authorizationCodeResolver as defaultAuthorizationCodeResolver'],
    },
    definition: `/**
 * Validate the authorization_code grant.
 * OAuth 2.1 §4.1.2 / RFC 7636 / OIDC Core 1.0 §3.1.3.2
 *
 * Each security rule is a separate core call so it can be removed, replaced,
 * or surrounded with experiment-specific logic.
 */
export async function validateAuthorizationCodeGrant(
  c: any,
  params: TokenRequestParams,
  authenticatedClientId: string,
): Promise<ValidatedAuthorizationCodeRequest> {
  const authorizationCodeResolver = c.get('authCodeResolver') ?? defaultAuthorizationCodeResolver;

  // Resolve the presented authorization code and retain the non-optional code.
  const { code, authorizationCode } = await resolveAuthorizationCode(
    params,
    authorizationCodeResolver,
  );

  // OAuth 2.1 §4.1.2: reject reuse and revoke tokens from the compromised grant.
  await validateAuthorizationCodeUnused(
    authorizationCode,
    authorizationCodeResolver,
  );

  // Bind the authorization code to the authenticated client and its lifetime.
  validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
  validateAuthorizationCodeExpiration(authorizationCode);

  // OIDC Core 1.0 §3.1.3.2: bind the token request redirect_uri.
  validateAuthorizationCodeRedirectUri(
    authorizationCode,
    params.redirect_uri,
  );

  // RFC 7636: validate the S256 verifier when the code carries a PKCE binding.
  const codeVerified = await verifyAuthorizationCodePkce(
    authorizationCode,
    params.code_verifier,
  );

  // Mark used (do not physically delete) so a later replay remains detectable.
  await consumeAuthorizationCode(code, authorizationCodeResolver);

  return buildValidatedAuthorizationCodeRequest(
    code,
    authorizationCode,
    authenticatedClientId,
    codeVerified,
  );
}`,
    call,
  };
}

const REFRESH_TOKEN_GRANT: StepFragment = {
  imports: {
    core: [
      'resolveRefreshToken',
      'validateRefreshTokenUnused',
      'validateRefreshTokenClient',
      'validateRefreshTokenExpiration',
      'validateRefreshTokenIdleTimeout',
      'validateRefreshTokenSession',
      'validateRefreshTokenScope',
      'buildValidatedRefreshTokenRequest',
      'type TokenRequestParams',
      'type ValidatedRefreshTokenRequest',
    ],
    resolvers: [
      'refreshTokenResolver as defaultRefreshTokenResolver',
      'authenticationSessionResolver as defaultAuthenticationSessionResolver',
    ],
  },
  definition: `/**
 * Validate the refresh_token grant.
 * OAuth 2.1 §4.3.1 / RFC 6749 §6
 *
 * Each security rule is a separate core call so it can be removed, replaced,
 * or surrounded with experiment-specific logic.
 */
export async function validateRefreshTokenGrant(
  c: any,
  params: TokenRequestParams,
  authenticatedClientId: string,
): Promise<ValidatedRefreshTokenRequest> {
  const refreshTokenResolver = c.get('refreshTokenResolver') ?? defaultRefreshTokenResolver;
  // online refresh token の束縛先セッションを sessionId から引く。差し替えると
  // 「セッションが生きているか」の判定そのものを差し替えられる。
  const authenticationSessionResolver =
    c.get('authenticationSessionResolver') ?? defaultAuthenticationSessionResolver;

  // Resolve the presented refresh token and retain its stored grant context.
  const { refreshTokenInfo } = await resolveRefreshToken(
    params,
    refreshTokenResolver,
  );

  // OAuth 2.1 §4.3.1: reject rotation reuse and revoke the token family.
  await validateRefreshTokenUnused(refreshTokenInfo, refreshTokenResolver);

  // Bind the refresh token to the authenticated client.
  validateRefreshTokenClient(refreshTokenInfo, authenticatedClientId);

  // Absolute lifetime: expiresAt <= now is expired.
  validateRefreshTokenExpiration(refreshTokenInfo);

  // Optional inactivity policy. Replace undefined with your timeout in seconds
  // to enable it, or remove this step if your experiment has no idle lifetime.
  validateRefreshTokenIdleTimeout(refreshTokenInfo, undefined);

  // online refresh token（sessionId を持つ RT）は、束縛先のログインセッションが
  // 生きている間だけ使える。ログアウト・別ユーザーでの再ログインでセッションが
  // 消えれば invalid_grant になる。offline_access が付与された RT は sessionId を
  // 持たないため、このステップを素通りしてログアウト後も使い続けられる。
  await validateRefreshTokenSession(refreshTokenInfo, authenticationSessionResolver);

  // RFC 6749 §6: requested scope may only narrow the original grant.
  const effectiveScope = validateRefreshTokenScope(
    params.scope,
    refreshTokenInfo.scope,
  );

  return buildValidatedRefreshTokenRequest(
    refreshTokenInfo,
    authenticatedClientId,
    effectiveScope,
  );
}`,
  // Called from the grant branch that validateAuthorizationCodeGrant's statement emits.
  call: '',
};

const SELECT_SIGNING_KEYS: StepFragment = {
  imports: {
    core: ['selectSigningKeyByAlg', 'type SigningKey'],
    resolvers: ['tokenClientResolver as defaultTokenClientResolver'],
    config: ['type RegisteredClient'],
  },
  definition: `/**
 * Select the signing keys: the first registered key signs the access token
 * (SigningKeyProvider contract); the ID Token key is picked by the alg the
 * client registered as id_token_signed_response_alg (OIDC Dynamic Client
 * Registration 1.0 §2; RS256 when unregistered). No matching key is a server
 * configuration error (TokenEndpointError, 500 server_error).
 */
export async function selectTokenSigningKeys(
  c: any,
  authenticatedClientId: string,
): Promise<{ signingKey: SigningKey; idTokenSigningKey: SigningKey }> {
  const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
  // The first registered key signs new tokens (SigningKeyProvider contract).
  const signingKey: SigningKey = c.get('signingKeys')[0];

  // T-022: pick an ID Token signing key whose alg matches the client's
  // id_token_signed_response_alg (OIDC Dynamic Client Registration §2).
  // - 未指定クライアントは OIDC 仕様デフォルトの RS256 で扱う。
  // - alg に合う鍵が登録されていなければサーバ設定エラー (server_error)。
  const idTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
  const registeredClient = (await tokenClientResolver.findClient(authenticatedClientId)) as
    | RegisteredClient
    | null;
  const requestedIdTokenAlg = registeredClient?.idTokenSignedResponseAlg;
  let idTokenSigningKey: SigningKey;
  try {
    idTokenSigningKey = selectSigningKeyByAlg(idTokenSigningKeys, requestedIdTokenAlg);
  } catch {
    throw new TokenEndpointError({
      status: 500,
      body: {
        error: 'server_error',
        error_description: \`No ID Token signing key registered for alg "\${requestedIdTokenAlg ?? 'RS256'}"\`,
      },
    });
  }
  return { signingKey, idTokenSigningKey };
}`,
  call: {
    bind: ['signingKey', 'idTokenSigningKey'],
    expression: 'await selectTokenSigningKeys(c, authenticatedClientId)',
  },
};

const RESOLVE_SUBJECT: StepFragment = {
  imports: {
    core: ['TokenError', 'TokenErrorCode', 'type ValidatedTokenRequest'],
    store: ['authCodeStore as defaultAuthCodeStore'],
  },
  definition: `/**
 * Resolve the subject, auth_time and nonce the tokens are issued for: from the
 * authorization code record (authorization_code), or from the refresh token's
 * stored grant (refresh_token).
 * OIDC Core 1.0 §12.2
 */
export async function resolveTokenSubject(
  c: any,
  validatedRequest: ValidatedTokenRequest,
): Promise<{ subject: string; authTime: number | undefined; nonce: string | undefined }> {
  if (validatedRequest.grantType === 'authorization_code') {
    const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
    const authCode = await authCodeStore.get(validatedRequest.code);
    if (!authCode?.subject || !authCode.authTime) {
      throw new TokenError(
        TokenErrorCode.InvalidGrant,
        'Authorization code missing required subject context',
      );
    }
    return { subject: authCode.subject, authTime: authCode.authTime, nonce: validatedRequest.nonce };
  }
  // refresh_token grant
  // OIDC Core 1.0 §12.2: the re-issued ID Token retains iss/sub/aud/exp/iat/
  // auth_time/azp/acr/amr — nonce is NOT in that list. nonce binds an
  // Authentication Request to its ID Token (§2); a refresh has no such request,
  // so carrying the old nonce adds no replay protection. Major OPs (Google,
  // Auth0) omit it on refresh, so we omit it here by default. auth_time is
  // still preserved per §12.1.
  return { subject: validatedRequest.subject, authTime: validatedRequest.authTime, nonce: undefined };
}`,
  call: {
    bind: ['subject', 'authTime', 'nonce'],
    expression: 'await resolveTokenSubject(c, validatedRequest)',
  },
};

const DECIDE_REFRESH_TOKEN_ISSUANCE: StepFragment = {
  imports: {
    core: ['clientAllowsRefreshTokenGrant', 'type TokenClientInfo', 'type ValidatedTokenRequest'],
  },
  definition: `/** Whether, and how, a refresh token is issued with this response. */
export interface RefreshTokenDecision {
  /** The grant holds offline_access: the refresh token outlives the login session. */
  grantHasOfflineAccess: boolean;
  /** The login session an online refresh token is bound to (undefined: not bound). */
  boundSessionId: string | undefined;
  /** Whether a refresh token is minted at all. */
  issueRefreshToken: boolean;
}

/**
 * Decide whether a refresh token is issued, and whether it is bound to the
 * login session (online) or outlives it (offline_access).
 * OIDC Core 1.0 §11 / RFC 9700 §4.14 / RFC 6749 §6
 */
export function decideRefreshTokenIssuance(
  c: any,
  tokenClient: TokenClientInfo,
  validatedRequest: ValidatedTokenRequest,
): RefreshTokenDecision {
  const config = c.get('config');

  // RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2: grant_types の既定は
  // ["authorization_code"]。refresh_token を登録していないクライアントへ RT を渡しても、
  // 次に grant_type=refresh_token を出した瞬間 validateClientGrantType が
  // unauthorized_client で拒否する。一度も使えない長期資格情報を保存させるだけなので
  // （RFC 9700 §4.14）、登録が無ければ発行しない。
  const clientAllowsRefreshGrant = clientAllowsRefreshTokenGrant(tokenClient);

  // RFC 6749 §6 / OIDC Core 1.0 §11: refresh 時の scope 縮小は当該リクエストの access token /
  // ID Token の権限縮小として扱い、refresh token rotation の可否とは切り離す。rotation 可否は
  // 「元の grant が offline_access を持っていたか」で判断する。
  // - authorization_code grant: 今回付与された scope に offline_access があるか。
  // - refresh_token grant: 元 refresh token の grant が offline_access を持っていたか
  //   (validatedRequest.hadOfflineAccess)。縮小後 scope から offline_access を落としても
  //   元 grant の権限は失われないため rotation を継続する。
  const grantHasOfflineAccess =
    clientAllowsRefreshGrant &&
    (validatedRequest.grantType === 'refresh_token'
      ? validatedRequest.hadOfflineAccess
      : validatedRequest.scope.includes('offline_access'));

  // online refresh token の束縛先セッション。
  // OIDC Core 1.0 §11 は offline_access を「End-User が居ない（not logged in）ときにも
  // 使える Refresh Token」と定義したうえで、Refresh Token の利用がその用途に限られない
  // ことも明示している（"The Authorization Server MAY grant Refresh Tokens in other
  // contexts"）。この OP はその other contexts を online refresh token として実装し、
  // ログインセッションへ束縛する。offline_access がある grant は束縛しない。
  // - authorization_code grant: 認可コードが持つ sessionId（ログイン時に確立したもの）。
  // - refresh_token grant: 元 RT の束縛をそのまま引き継ぎ、rotation で外れないようにする。
  const boundSessionId = grantHasOfflineAccess ? undefined : validatedRequest.sessionId;

  // 束縛先が分からなければ online refresh token は発行しない。ブラウザセッションを
  // 持たない経路（device authorization grant）が該当する。ログアウトで止まる保証を
  // 付けられない RT を配らないための fail-closed。
  const issueRefreshToken =
    clientAllowsRefreshGrant &&
    (grantHasOfflineAccess ||
      (config.onlineRefreshTokenEnabled && boundSessionId !== undefined));

  return { grantHasOfflineAccess, boundSessionId, issueRefreshToken };
}`,
  call: {
    bind: 'refreshTokenDecision',
    expression: 'decideRefreshTokenIssuance(c, tokenClient, validatedRequest)',
  },
};

const RESOLVE_ACR_AMR: StepFragment = {
  imports: {
    core: [
      'resolveAcrAmr',
      'selectPreferredAcr',
      'selectRequestedAcrValues',
      'type AcrResolver',
      'type ValidatedTokenRequest',
    ],
  },
  definition: `/**
 * Resolve the acr / amr the tokens carry: the ID Token gets both, and the
 * access token gets the acr, so a resource server can tell how the End-User
 * authenticated (RFC 9068 §2.2.1).
 * OIDC Core 1.0 §2 / §3.1.2.1 / §12.1
 *
 * - authorization_code: the acrResolver option of the app decides from the
 *   acr values the client requested (acr_values, or claims.id_token.acr.values,
 *   OIDC Core 1.0 §5.5.1.1). Without an acrResolver the tokens carry the most
 *   preferred requested value and no amr, and no acr when none was requested.
 * - refresh_token: the acr / amr of the first authentication are kept
 *   (OIDC Core 1.0 §12.1); the resolver is not asked again.
 */
export async function resolveTokenAcrAmr(
  c: any,
  input: { subject: string; validatedRequest: ValidatedTokenRequest },
): Promise<{ acr: string | undefined; amr: string[] | undefined }> {
  const { subject, validatedRequest } = input;
  if (validatedRequest.grantType === 'refresh_token') {
    return { acr: validatedRequest.acr, amr: validatedRequest.amr };
  }

  // The requested acr values, in order of preference.
  const requestedAcrValues = selectRequestedAcrValues(validatedRequest.acrValues, validatedRequest.claims);

  const acrResolver = c.get('acrResolver') as AcrResolver | undefined;
  if (acrResolver !== undefined) {
    const { acr, amr } = await resolveAcrAmr({
      subject,
      clientId: validatedRequest.clientId,
      requestedAcrValues,
      acrResolver,
    });
    return { acr, amr };
  }

  // No acrResolver: the tokens carry the most preferred requested acr as it
  // is. This trusts the request; pass an acrResolver that reports the acr your
  // login actually satisfied before a resource server relies on it.
  return { acr: selectPreferredAcr(requestedAcrValues), amr: undefined };
}`,
  call: {
    bind: ['acr', 'amr'],
    expression: 'await resolveTokenAcrAmr(c, { subject, validatedRequest })',
  },
  otherwise: {
    acr: 'const acr: string | undefined = undefined;',
    amr: 'const amr: string[] | undefined = undefined;',
  },
};

const ISSUE_ACCESS_TOKEN: StepFragment = {
  imports: {
    core: [
      'buildAccessTokenAudience',
      'buildAccessTokenPayload',
      'createJwtAccessTokenIssuer',
      'createOpaqueAccessTokenIssuer',
      'type AccessTokenIssuer',
      'type SigningKey',
      'type ValidatedTokenRequest',
    ],
  },
  definition: `/**
 * Issue the access token: decide its audience, build the RFC 9068 payload
 * and sign it (JWT) or mint an opaque reference, as config.accessTokenFormat says.
 * RFC 9068 §2.2 / §2.2.1 / §3
 */
export async function issueAccessToken(
  c: any,
  input: {
    signingKey: SigningKey;
    subject: string;
    validatedRequest: ValidatedTokenRequest;
    /** One timestamp for the whole response so the tokens and the stored records agree on iat / exp. */
    issuedAt: number;
    /** The acr of the authentication (the ID Token carries the same); undefined leaves the claim out. */
    acr: string | undefined;
  },
): Promise<{ accessToken: string; accessTokenPayload: { jti?: string }; audience: string[] }> {
  const { signingKey, subject, validatedRequest, issuedAt, acr } = input;
  const config = c.get('config');

  // Choose access token issuer based on config (default: JWT).
  // Opaque tokens are recommended when immediate revocation is required,
  // since the resource server can call the introspection endpoint instead
  // of self-validating a JWT.
  const accessTokenIssuer: AccessTokenIssuer =
    config.accessTokenFormat === 'opaque'
      ? createOpaqueAccessTokenIssuer()
      : createJwtAccessTokenIssuer();

  // アクセストークンの audience を決定する（合成ポリシーは core の buildAccessTokenAudience に集約）。
  // RFC 9068 §3: JWT access token の aud は非空でなければならない。
  // このアクセストークンは常に OP 自身の UserInfo エンドポイントで使用できるため、UserInfo
  // エンドポイント（discovery が広告する userinfo_endpoint と同じ URL）を aud の恒久メンバとして
  // 必ず含める。resource 指定（validatedRequest.audience）があれば末尾に追加し、UserInfo
  // エンドポイントを取り除くことはしない。重複は除去される。
  // refresh では保存済み aud（既に UserInfo を含む）を引き継ぐため、再計算しても同一集合になる。
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: \`\${config.issuer}/userinfo\`,
    requested: validatedRequest.audience,
    issuer: config.issuer,
  });

  // RFC 9068 §2.2: iss / sub / aud / exp / iat / scope / client_id, and the
  // acr of the authentication (§2.2.1) when there is one.
  // Add access token claims here before the payload is signed.
  const accessTokenPayload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject,
    clientId: validatedRequest.clientId,
    scope: validatedRequest.scope,
    audience,
    expiresIn: config.accessTokenExpiresIn,
    issuedAt,
    acr,
  });

  // JWT or opaque, chosen above from config.accessTokenFormat.
  const accessToken = await accessTokenIssuer.issue({
    payload: accessTokenPayload,
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
  });

  return { accessToken, accessTokenPayload, audience };
}`,
  call: {
    before: `    // One timestamp for the whole response so the issued tokens and the stored
    // token metadata agree on iat / exp.
    const issuedAt = Math.floor(Date.now() / 1000);`,
    bind: ['accessToken', 'accessTokenPayload', 'audience'],
    expression: 'await issueAccessToken(c, { signingKey, subject, validatedRequest, issuedAt, acr })',
  },
};

const ISSUE_ID_TOKEN: StepFragment = {
  imports: {
    core: [
      'computeAtHash',
      'buildIdTokenPayload',
      'generateIdToken',
      'type SigningKey',
      'type ValidatedTokenRequest',
    ],
  },
  definition: `/**
 * Issue the ID Token when the grant carries the openid scope: at_hash binds
 * it to the access token (§3.1.3.6), and acr / amr are the ones
 * resolveTokenAcrAmr() settled on (kept from the first authentication on a
 * refresh, §12.1).
 * OIDC Core 1.0 §3.1.3.6 / §12.1
 */
export async function issueIdToken(
  c: any,
  input: {
    idTokenSigningKey: SigningKey;
    accessToken: string;
    subject: string;
    authTime: number | undefined;
    nonce: string | undefined;
    validatedRequest: ValidatedTokenRequest;
    issuedAt: number;
    acr: string | undefined;
    amr: string[] | undefined;
  },
): Promise<string | undefined> {
  const { idTokenSigningKey, accessToken, subject, authTime, nonce, validatedRequest, issuedAt, acr, amr } = input;
  const config = c.get('config');

  // OIDC Core 1.0 §12: refresh_token grant でも id_token は MAY。
  // openid scope を持つ場合は §12.1 に従い初回認証時と同じ auth_time / acr / amr / azp で再発行する。
  // （§12.2 は nonce を再発行 ID Token の保持クレームに挙げないため nonce は refresh では undefined）
  if (!validatedRequest.scope.includes('openid')) {
    return undefined;
  }

  // OIDC Core 1.0 §3.1.3.6: at_hash binds the ID Token to this access token.
  // The hash function follows the ID Token signing alg.
  const atHash = await computeAtHash(accessToken, idTokenSigningKey.privateKey);

  const idTokenPayload = buildIdTokenPayload({
    issuer: config.issuer,
    subject,
    clientId: validatedRequest.clientId,
    scope: validatedRequest.scope,
    expiresIn: config.idTokenExpiresIn,
    issuedAt,
    atHash,
    nonce,
    authTime,
    acr,
    amr,
  });

  // Add your own ID Token claims here, e.g.:
  //   idTokenPayload.tenant_id = await lookupTenant(subject);

  return generateIdToken({
    payload: idTokenPayload,
    privateKey: idTokenSigningKey.privateKey,
    keyId: idTokenSigningKey.keyId,
  });
}`,
  call: {
    bind: 'idToken',
    expression:
      'await issueIdToken(c, { idTokenSigningKey, accessToken, subject, authTime, nonce, validatedRequest, issuedAt, acr, amr })',
  },
  otherwise: {
    idToken: 'const idToken: string | undefined = undefined;',
  },
};

const PERSIST_ACCESS_TOKEN: StepFragment = {
  imports: {
    core: ['type ValidatedTokenRequest'],
    store: ['accessTokenStore as defaultAccessTokenStore'],
  },
  definition: `/**
 * Store the access token record for the UserInfo, introspection and
 * revocation endpoints.
 * RFC 7662 §2.2 / RFC 9068 §2.2 / OIDC Core 1.0 §5.5 / RFC 9470 §6.2
 *
 * iat / nbf / audience / issuer / acr are kept so introspection can echo
 * them. grantId binds this token to the original authorization grant so it can
 * be revoked together with sibling tokens on code reuse (OAuth 2.1 §4.1.2).
 */
export async function persistAccessToken(
  c: any,
  input: {
    accessToken: string;
    accessTokenPayload: { jti?: string };
    subject: string;
    validatedRequest: ValidatedTokenRequest;
    issuedAt: number;
    audience: string[];
    acr: string | undefined;
  },
): Promise<void> {
  const { accessToken, accessTokenPayload, subject, validatedRequest, issuedAt, audience, acr } = input;
  const accessTokenStore = c.get('accessTokenStore') ?? defaultAccessTokenStore;
  const config = c.get('config');

  await accessTokenStore.set(accessToken, {
    sub: subject,
    clientId: validatedRequest.clientId,
    scope: validatedRequest.scope,
    expiresAt: issuedAt + config.accessTokenExpiresIn,
    grantId: validatedRequest.grantId,
    iat: issuedAt,
    // RFC 7519 §4.1.5 / RFC 7662 §2.2: persist nbf (= iat) for JWT and opaque
    // tokens alike so introspection reports a not-yet-valid token inactive and
    // can echo nbf. The JWT issuer emits the same nbf = iat inside the token.
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    // RFC 9068 §2.2 / RFC 7662 §2.2: persist the token identifier core minted
    // for this issuance so introspection can echo jti. It is also what makes
    // two same-second issuances distinct token strings (RS256 is deterministic),
    // so this store key never collides across grants.
    jti: accessTokenPayload.jti,
    // OIDC Core 1.0 §5.5: persist the authorization request's claims parameter
    // so the UserInfo endpoint can honor claims.userinfo members (e.g.
    // {"userinfo":{"name":{"essential":true}}}) independently of scope.
    claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
    // RFC 9068 §2.2.1 / RFC 9470 §6.2: the acr the token was issued with, so
    // introspection reports it for an opaque token too.
    acr,
  });
}`,
  call: `    await persistAccessToken(c, { accessToken, accessTokenPayload, subject, validatedRequest, issuedAt, audience, acr });`,
};

const ISSUE_REFRESH_TOKEN: StepFragment = {
  imports: {
    core: ['generateRandomString', 'TokenError', 'TokenErrorCode', 'type ValidatedTokenRequest'],
    store: ['refreshTokenStore as defaultRefreshTokenStore'],
  },
  definition: `/**
 * Mint the refresh token the decision asked for and store its record for
 * rotation. Returns undefined when none is issued.
 * OAuth 2.1 §4.3.1 / §6.1 / OIDC Core 1.0 §12.1
 *
 * The same grantId / audience / authTime / nonce / acr / amr / azp is propagated
 * through rotations so descendants can be revoked on code reuse, the audience
 * never expands, and the ID Token a refresh re-issues keeps the values of the
 * first authentication (OIDC Core 1.0 §12.1).
 */
export async function issueRefreshToken(
  c: any,
  input: {
    decision: RefreshTokenDecision;
    subject: string;
    authTime: number | undefined;
    nonce: string | undefined;
    validatedRequest: ValidatedTokenRequest;
    issuedAt: number;
    audience: string[];
    acr: string | undefined;
    amr: string[] | undefined;
  },
): Promise<string | undefined> {
  const { decision, subject, authTime, nonce, validatedRequest, issuedAt, audience, acr, amr } = input;
  if (!decision.issueRefreshToken) return undefined;

  const refreshTokenStore = c.get('refreshTokenStore') ?? defaultRefreshTokenStore;
  const config = c.get('config');
  const refreshToken = generateRandomString(32);

  // authTime はここで必ず確定する: authorization_code 経由は authCode.authTime、
  // refresh_token 経由は validatedRequest.authTime。
  if (authTime === undefined) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'authTime is required to issue a refresh token',
    );
  }
  // OAuth 2.1 §6.1: refresh token は initial issuance からの absolute lifetime のみで失効する。
  // rotation を跨いで originalIssuedAt を引き継ぎ、expiresAt はそこからの絶対的な期限で固定する。
  // sliding expiry は持たないため、リフレッシュを繰り返しても失効時刻は前に進まず、
  // 漏洩 RT の長期 abuse を防ぐ。
  // - authorization_code grant: 今回が初回発行なので originalIssuedAt = issuedAt。
  // - refresh_token grant: 元 RT の originalIssuedAt をそのまま引き継ぐ。
  const originalIssuedAt =
    validatedRequest.grantType === 'refresh_token'
      ? validatedRequest.originalIssuedAt
      : issuedAt;
  const refreshTokenExpiresAt = originalIssuedAt + config.refreshTokenAbsoluteLifetime;
  // RFC 6749 §6: 縮小後 scope（validatedRequest.scope）から offline_access が落ちても、
  // grant が offline_access を持つ限り次回以降の rotation を継続できるよう、永続化する
  // refresh token の scope には offline_access を保持する。access token は
  // validatedRequest.scope をそのまま使うため、当該リクエストの権限は縮小されたままになる。
  const refreshTokenScope =
    decision.grantHasOfflineAccess && !validatedRequest.scope.includes('offline_access')
      ? [...validatedRequest.scope, 'offline_access']
      : validatedRequest.scope;
  await refreshTokenStore.set(refreshToken, {
    subject,
    clientId: validatedRequest.clientId,
    scope: refreshTokenScope,
    expiresAt: refreshTokenExpiresAt,
    originalIssuedAt,
    used: false,
    grantId: validatedRequest.grantId,
    iat: issuedAt,
    issuer: config.issuer,
    audience,
    authTime,
    nonce,
    // OIDC Core 1.0 §12.1: refresh で再発行する ID Token は初回認証時の acr / amr を保持する。
    // - authorization_code grant: resolveTokenAcrAmr() が決めた値をそのまま永続化する。
    // - refresh_token grant: 既に保存済みの値を引き継ぐ（resolver は呼ばれていない）。
    acr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : acr,
    amr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : amr,
    azp: validatedRequest.grantType === 'refresh_token' ? validatedRequest.azp : undefined,
    // online refresh token の束縛。undefined なら offline refresh token として
    // セッションから独立し、ログアウト後も使える。
    sessionId: decision.boundSessionId,
  });

  return refreshToken;
}`,
  call: {
    bind: 'refreshToken',
    expression:
      'await issueRefreshToken(c, {\n      decision: refreshTokenDecision,\n      subject,\n      authTime,\n      nonce,\n      validatedRequest,\n      issuedAt,\n      audience,\n      acr,\n      amr,\n    })',
  },
};

const REVOKE_ROTATED_REFRESH_TOKEN: StepFragment = {
  imports: {
    core: ['type TokenRequestParams', 'type ValidatedTokenRequest'],
    resolvers: ['refreshTokenResolver as defaultRefreshTokenResolver'],
  },
  definition: `/**
 * Rotation: revoke the refresh token the request presented, now that its
 * successor is stored. Always this order, so a failure never leaves the
 * End-User without a refresh token.
 * OAuth 2.1 §4.3.1
 */
export async function revokeRotatedRefreshToken(
  c: any,
  params: TokenRequestParams,
  validatedRequest: ValidatedTokenRequest,
): Promise<void> {
  if (validatedRequest.grantType !== 'refresh_token' || !params.refresh_token) return;
  const refreshTokenResolver = c.get('refreshTokenResolver') ?? defaultRefreshTokenResolver;
  await refreshTokenResolver.revokeRefreshToken(params.refresh_token);
}`,
  call: `    await revokeRotatedRefreshToken(c, params, validatedRequest);`,
};

function buildTokenResponseFragment(features: OidcFeatureConfig): StepFragment {
  const refreshField = features.refreshToken ? 'refreshToken?: string;' : '';
  const refreshDestructure = features.refreshToken ? 'refreshToken, ' : '';
  const refreshValue = features.refreshToken
    ? 'refreshToken'
    : 'undefined /* the refresh_token feature is disabled: never issue one */';
  const callArgs = features.refreshToken
    ? '{ accessToken, idToken, refreshToken, validatedRequest }'
    : '{ accessToken, idToken, validatedRequest }';
  return {
    imports: { core: ['type ValidatedTokenRequest'] },
    definition: `/**
 * Build the token response body.
 * OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1
 */
export function buildTokenResponse(
  c: any,
  input: {
    accessToken: string;
    idToken: string | undefined;
    ${refreshField}
    validatedRequest: ValidatedTokenRequest;
  },
): TokenEndpointResponse {
  const { accessToken, idToken, ${refreshDestructure}validatedRequest } = input;
  const config = c.get('config');
  return {
    status: 200,
    body: {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: config.accessTokenExpiresIn,
      id_token: idToken,
      scope: validatedRequest.scope.join(' '),
      refresh_token: ${refreshValue},
    },
  };
}`.replace('\n    \n', '\n'),
    call: { bind: 'tokenResponse', expression: `buildTokenResponse(c, ${callArgs})` },
  };
}

const RESPOND: StepFragment = {
  definition: `/**
 * Send a token endpoint answer.
 * RFC 6749 §5.1 / §5.2: token responses and error responses MUST NOT be cached.
 */
export function respondToken(c: any, response: TokenEndpointResponse): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  return c.json(response.body, response.status);
}`,
  call: `    return respondToken(c, tokenResponse);`,
};

function respondErrorFragment(features: OidcFeatureConfig): StepFragment {
  const experimental: { condition: string; module: string; name: string; comment: string }[] = [
    ...(features.idJag
      ? [
          {
            condition: 'IdJagError',
            module: `${EXPERIMENTAL_PACKAGE}/id-jag`,
            name: 'IdJagError',
            comment: `    // ID-JAG errors use the RFC 6749 §5.2 shape and are always 400 — a 401
    // can only come from client authentication, which runs before both
    // branches and throws core's TokenError. Issuance failures map to
    // invalid_request / invalid_target / invalid_scope / unauthorized_client
    // (RFC 8693 §2.2.2); assertion failures on redemption map to
    // invalid_grant (RFC 7521 §4.1).`,
          },
        ]
      : []),
    ...(features.tokenExchange
      ? [
          {
            condition: 'TokenExchangeError',
            module: `${EXPERIMENTAL_PACKAGE}/token-exchange`,
            name: 'TokenExchangeError',
            comment: `    // RFC 8693 §2.2.2: the exchange errors use the RFC 6749 §5.2 shape. They
    // are always 400 — a 401 can only come from client authentication, which
    // runs before the branch and throws core's TokenError.`,
          },
        ]
      : []),
    ...(features.deviceAuthorizationGrant
      ? [
          {
            condition: 'DeviceAuthorizationError',
            module: `${EXPERIMENTAL_PACKAGE}/device-authorization-grant`,
            name: 'DeviceAuthorizationError',
            comment: `    // RFC 8628 §3.5: authorization_pending / slow_down / access_denied /
    // expired_token use the RFC 6749 §5.2 shape and are always 400. A 401 can
    // only come from client authentication, which runs before the branch and
    // throws core's TokenError.`,
          },
        ]
      : []),
    ...(features.ciba
      ? [
          {
            condition: 'CibaGrantError',
            module: `${EXPERIMENTAL_PACKAGE}/ciba`,
            name: 'CibaGrantError',
            comment: `    // CIBA §11: authorization_pending / slow_down / access_denied /
    // expired_token use the RFC 6749 §5.2 shape and are always 400. A 401 can
    // only come from client authentication, which runs before the branch and
    // throws core's TokenError.`,
          },
        ]
      : []),
  ];
  const modules: Record<string, string[]> = {};
  for (const entry of experimental) {
    modules[entry.module] = [...(modules[entry.module] ?? []), entry.name];
  }
  const experimentalBranches = experimental
    .map(
      (entry) => `  if (error instanceof ${entry.condition}) {
${entry.comment}
    return respondToken(c, {
      status: error.statusCode,
      body: { error: error.code, error_description: error.errorDescription },
    });
  }
`,
    )
    .join('');
  return {
    imports: { core: ['TokenError'], modules },
    definition: `/**
 * Answer a failure of any step with the OAuth error response.
 * RFC 6749 §5.2 / RFC 6750 §3 / OAuth 2.1 §5.2
 */
export function respondTokenError(c: any, error: unknown): Response {
  // A step already decided the whole response (malformed request, server
  // configuration problem): send it as it is.
  if (error instanceof TokenEndpointError) {
    return respondToken(c, error.response);
  }
${experimentalBranches}  if (error instanceof TokenError) {
    // RFC 6750 Section 3 / OAuth 2.1 Section 5.2: 401 responses include WWW-Authenticate
    return respondToken(c, {
      status: error.statusCode,
      body: { error: error.error, error_description: error.errorDescription },
      headers: error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
    });
  }
  // RFC 6749 Section 5.2: server_error responses MUST NOT be cached either.
  return respondToken(c, { status: 500, body: { error: 'server_error' } });
}`,
    call: '',
  };
}

function tokenFragments(features: OidcFeatureConfig): Record<string, StepFragment> {
  return {
    'parse-request': PARSE_REQUEST,
    'authenticate-client': AUTHENTICATE_CLIENT,
    'dispatch-id-jag-issuance': idJagIssuanceFragment(features),
    'dispatch-id-jag-redemption': ID_JAG_REDEMPTION,
    'dispatch-token-exchange': TOKEN_EXCHANGE,
    'dispatch-device-code': deviceCodeFragment(features),
    'dispatch-ciba': cibaGrantFragment(features),
    'validate-grant-type': validateGrantTypeFragment(features),
    'validate-authorization-code-grant': authorizationCodeGrantFragment(features),
    'validate-refresh-token-grant': REFRESH_TOKEN_GRANT,
    'select-signing-keys': SELECT_SIGNING_KEYS,
    'resolve-subject': RESOLVE_SUBJECT,
    'decide-refresh-token-issuance': DECIDE_REFRESH_TOKEN_ISSUANCE,
    'resolve-acr-amr': RESOLVE_ACR_AMR,
    'issue-access-token': ISSUE_ACCESS_TOKEN,
    'issue-id-token': ISSUE_ID_TOKEN,
    'persist-access-token': PERSIST_ACCESS_TOKEN,
    'issue-refresh-token': ISSUE_REFRESH_TOKEN,
    'revoke-rotated-refresh-token': REVOKE_ROTATED_REFRESH_TOKEN,
    'build-token-response': buildTokenResponseFragment(features),
    respond: RESPOND,
    'respond-error': respondErrorFragment(features),
  };
}

/**
 * The generated `routes/token.ts`. `steps` is the `--flow` selection for the
 * token endpoint (default: the catalog's steps, in order).
 */
export function tokenRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  steps?: string[],
): string {
  const endpoint = buildOpFlow({ features }).endpoints.find((e) => e.id === 'token');
  if (endpoint === undefined) throw new Error('The flow catalog has no token endpoint');
  // The id-jag settings block and the trusted-IdP cache live in the header, so
  // their imports are fixed rather than tied to a step.
  const idJagHeaderImports = features.idJag
    ? {
        core: ['type JwkSet'],
        modules: {
          [`${EXPERIMENTAL_PACKAGE}/id-jag`]: [
            'TOKEN_TYPE_ID_TOKEN',
            'resolveIdJagActor',
            'type IdJagActorTokenResolver',
            'type IdJagTrustedIdentityProvider',
          ],
        },
      }
    : {};
  return renderPipelineRoute({
    endpoint,
    fragments: tokenFragments(features),
    ...(steps === undefined ? {} : { selection: steps }),
    corePkg,
    fixedImports: { hono: true, core: ['type TokenRequestParams', ...(idJagHeaderImports.core ?? [])], modules: idJagHeaderImports.modules ?? {} },
    header: tokenHeader(features),
    handlerOpen: `/**
 * Token Endpoint
 * OIDC Core 1.0 Section 3.1.3
 *
 * The pipeline: each statement below is one step function of this module, in
 * the order of the flow. A step that throws ends in respondTokenError().
 */
tokenApp.post('/', async (c) => {
  try {`,
    handlerClose: `  } catch (error) {
    return respondTokenError(c, error);
  }
});
`,
  });
}
