/**
 * Next.js templates for the public metadata Route Handlers:
 * `.well-known/openid-configuration` and `.well-known/jwks.json`.
 */
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';

/**
 * The grant types the generated OP supports, as discovery advertises them. A
 * disabled feature contributes nothing, so a client detects support through
 * discovery (RFC 8693 §2.1 / RFC 8628 §4 / CIBA Core 1.0 §4).
 */
export function nextJsSupportedGrantTypes(features: OidcFeatureConfig): string[] {
  return [
    'authorization_code',
    ...(features.refreshToken ? ['refresh_token'] : []),
    // EXPERIMENTAL (ID-JAG draft §4.3): issuing an ID-JAG happens on the
    // token-exchange grant, so enabling id-jag alone also advertises it.
    ...(features.tokenExchange || features.idJag
      ? ['urn:ietf:params:oauth:grant-type:token-exchange']
      : []),
    // EXPERIMENTAL (ID-JAG draft §7.2): a resource AS that advertises the id-jag
    // grant profile MUST also advertise the jwt-bearer grant.
    ...(features.idJag ? ['urn:ietf:params:oauth:grant-type:jwt-bearer'] : []),
    ...(features.deviceAuthorizationGrant
      ? ['urn:ietf:params:oauth:grant-type:device_code']
      : []),
    ...(features.ciba ? ['urn:openid:params:grant-type:ciba'] : []),
  ];
}

/** `.well-known/openid-configuration/route.ts` — OIDC Discovery 1.0 §4. */
export function nextJsDiscoveryRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  // --scope: the declared scopes live in scopes.ts together with the standard
  // ones, so the advertisement reads from there instead of repeating them.
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { SUPPORTED_SCOPES } from '../../_oidc-provider/scopes';`
    : '';
  const scopesSupportedEntry = customScopesDeclared
    ? `    // OIDC Discovery 1.0 §3: scopes_supported is this OP's scope allow list —
    // the standard scopes plus the custom ones declared with --scope (see
    // scopes.ts). It lists what the provider accepts, not what a particular
    // End-User is granted (resolveGrantableScopes decides that).
    scopesSupported: [...SUPPORTED_SCOPES],
`
    : features.refreshToken
    ? `    // OIDC Core 1.0 §11: offline_access is advertised so relying parties (and the
    // OIDF Conformance Suite's oidcc-refresh-token module) know they may request
    // refresh tokens via 'scope=openid offline_access' with prompt=consent.
    // It is a refresh-token request scope, not a claim scope, so no matching
    // entry is added to claimsSupported.
    scopesSupported: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'],
`
    : `    // The refresh_token feature is disabled, so offline_access is not advertised
    // (OIDC Core 1.0 §11: it would never be granted by this provider).
    scopesSupported: ['openid', 'profile', 'email', 'address', 'phone'],
`;
  const supportedGrantTypes = nextJsSupportedGrantTypes(features).map(
    (grantType) => `'${grantType}'`,
  );
  const requestObjectMetadata = features.requestObject
    ? `    // OIDC Core 1.0 §6.1 / OIDC Discovery 1.0 §3: a signed Request Object by value
    // is supported (verified against the client's registered JWKS). request_uri
    // (§6.2) is not, so it is advertised as false explicitly — Discovery defaults
    // request_uri_parameter_supported to true when omitted. 'none' is added only
    // when unsigned objects are accepted for Basic OP conformance compatibility.
    requestParameterSupported: true,
    requestUriParameterSupported: false,
    requestObjectSigningAlgValuesSupported: config.allowUnsignedRequestObject
      ? ['RS256', 'none']
      : ['RS256'],
`
    : `    // OIDC Core 1.0 §6.3: the request parameter (Request Object) is disabled in
    // this generated provider, so request_parameter_supported is advertised as
    // false. request_uri (§6.2) remains unsupported as well.
    requestParameterSupported: false,
    requestUriParameterSupported: false,
`;
  const rfc8414Comment =
    features.introspection && features.revocation
      ? `    // RFC 8414 — both endpoints require client authentication.
`
      : features.introspection || features.revocation
        ? `    // RFC 8414 — the endpoint requires client authentication.
`
        : '';
  const introspectionMetadata = features.introspection
    ? `    introspectionEndpoint: \`\${issuer}/introspect\`,
    introspectionEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
    ],
`
    : '';
  const revocationMetadata = features.revocation
    ? `    revocationEndpoint: \`\${issuer}/revoke\`,
    revocationEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
    ],
`
    : '';
  const responseModesSupportedEntry = features.jarm
    ? `    // OAuth 2.0 Multiple Response Type Encoding Practices §2 / OIDC Discovery 1.0
    // §3: the code flow answers via query. EXPERIMENTAL (JARM §4): this provider
    // was generated with --enable jarm, so the JWT-secured query modes are
    // advertised alongside it.
    responseModesSupported: ['query', 'query.jwt', 'jwt'],`
    : `    // OAuth 2.0 Multiple Response Type Encoding Practices §2 / OIDC Discovery 1.0
    // §3: the OP only implements the authorization code flow, whose response is
    // returned via query, so response_modes_supported is pinned to ['query'].
    responseModesSupported: ['query'],`;
  const parImport = features.par
    ? `
import { parConfig } from '../../par/config';`
    : '';
  // Metadata core's buildProviderMetadata() has no field for is merged onto its
  // result, one entry per generated feature.
  const extensionMetadata = [
    ...(features.par
      ? [`      // EXPERIMENTAL — RFC 9126 §5. require_pushed_authorization_requests is only
      // advertised when PAR is actually enforced (its default is false).
      pushed_authorization_request_endpoint: \`\${issuer}/par\`,
      ...(parConfig.requirePushedAuthorizationRequests
        ? { require_pushed_authorization_requests: true }
        : {}),`]
      : []),
    ...(features.deviceAuthorizationGrant
      ? [`      // EXPERIMENTAL — RFC 8628 §4.
      device_authorization_endpoint: \`\${issuer}/device_authorization\`,`]
      : []),
    ...(features.ciba
      ? [`      // EXPERIMENTAL — CIBA Core 1.0 §4. Only the poll delivery mode is offered.
      backchannel_token_delivery_modes_supported: ['poll'],
      backchannel_authentication_endpoint: \`\${issuer}/backchannel_authentication\`,`]
      : []),
    ...(features.jarm
      ? [`      // EXPERIMENTAL — JARM §4. The response JWT is always signed with RS256 (JARM
      // §3: the default for a client that registered no
      // authorization_signed_response_alg).
      authorization_signing_alg_values_supported: ['RS256'],`]
      : []),
    ...(features.idJag
      ? [`      // EXPERIMENTAL — ID-JAG draft §7.1 / §7.2: this OP issues ID-JAGs via token
      // exchange and redeems them on the jwt-bearer grant. Which issuers and
      // audiences are trusted is local policy and is not disclosed (draft §9.4).
      identity_chaining_requested_token_types_supported: ['urn:ietf:params:oauth:token-type:id-jag'],
      authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],`]
      : []),
    ...(features.introspection && features.jwtIntrospectionResponse
      ? [`      // EXPERIMENTAL — RFC 9701 §7. The introspection response JWT is always signed
      // with RS256 (§6: the default for a client that registered no
      // introspection_signed_response_alg).
      introspection_signing_alg_values_supported: ['RS256'],`]
      : []),
    ...(features.rpInitiatedLogout
      ? [`      // EXPERIMENTAL — RP-Initiated Logout 1.0 §2.1.
      end_session_endpoint: \`\${issuer}/logout\`,`]
      : []),
  ];
  const extensionMetadataBlock = extensionMetadata.length > 0
    ? `\n${extensionMetadata.join('\n')}`
    : '';
  return `/**
 * OpenID Provider Configuration (OIDC Discovery 1.0 §4).
 */
import { buildProviderMetadata, getJwaAlgorithm } from '${corePkg}';
import { config, loadSigningKeys } from '../../_oidc-provider/provider';
import {
  corsPreflight,
  publicCors,
  signingKeysUnavailable,
  withCors,
} from '../../_oidc-provider/http';${parImport}${customScopeImport}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return withCors(request, publicCors, await providerMetadata());
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, publicCors);
}

async function providerMetadata(): Promise<Response> {
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  const issuer = config.issuer;
  const metadata = buildProviderMetadata({
    issuer,
    authorizationEndpoint: \`\${issuer}/authorize\`,
    tokenEndpoint: \`\${issuer}/token\`,
    jwksUri: \`\${issuer}/.well-known/jwks.json\`,
    responseTypesSupported: ['code'],
${responseModesSupportedEntry}
    subjectTypesSupported: ['public'],
    // OIDC Core 1.0 §15.1: id_token_signing_alg_values_supported is derived from
    // every registered ID Token key, so a mixed RS256 + ES256 set is advertised
    // as such (buildProviderMetadata enforces that RS256 is present).
    idTokenSigningKeys: keys.idToken.map((key) => key.privateKey),
    userinfoEndpoint: \`\${issuer}/userinfo\`,
${scopesSupportedEntry}    // OIDC Discovery 1.0 §3 / Core 1.0 §5.6: this OP produces Normal Claims only
    // (no _claim_names / _claim_sources).
    claimTypesSupported: ['normal'],
    claimsSupported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      // OIDC Core 1.0 §2 / §3.1.3.6: ID Token protocol claims the OP issues.
      // c_hash is omitted on purpose: the Hybrid flow is not implemented.
      'auth_time',
      'nonce',
      'acr',
      'amr',
      'azp',
      'at_hash',
      'name',
      'family_name',
      'given_name',
      'middle_name',
      'nickname',
      'preferred_username',
      'profile',
      'picture',
      'website',
      'gender',
      'birthdate',
      'zoneinfo',
      'locale',
      'updated_at',
      'email',
      'email_verified',
      'address',
      'phone_number',
      'phone_number_verified',
    ],
    grantTypesSupported: [${supportedGrantTypes.join(', ')}],
    // RFC 6749 §2.1 / OAuth 2.1 §2.4: 'none' advertises that public clients
    // (no client_secret) are accepted at the token endpoint.
    tokenEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
      'none',
    ],
    // OIDC Core 1.0 §5.3.2: the algs the registered UserInfo keys can sign with,
    // so clients relying on userinfo_signed_response_alg can trust the metadata.
    userinfoSigningAlgValuesSupported: [
      ...new Set(keys.userinfo.map((key) => getJwaAlgorithm(key.privateKey))),
    ],
${requestObjectMetadata}    // OIDC Discovery 1.0 §3 / Core 1.0 §5.5: the claims request parameter is
    // implemented for both the ID Token and UserInfo.
    claimsParameterSupported: true,
    // RFC 9207 §3: every authorization response carries iss.
    authorizationResponseIssParameterSupported: true,
${rfc8414Comment}${introspectionMetadata}${revocationMetadata}  });

  // RFC 8414 §3.2 / RFC 9111 §5.2: discovery metadata is cacheable; 3600s, the
  // same freshness lifetime as the JWKS endpoint.
  return Response.json(
    {
      ...metadata,
      // RFC 7636 / OAuth 2.1: not an OIDC Discovery field, so added here.
      code_challenge_methods_supported: ['S256'],${extensionMetadataBlock}
    },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
`;
}

/** `.well-known/jwks.json/route.ts` — the public keys tokens are verified with. */
export function nextJsJwksRouteTemplate(corePkg: string): string {
  return `/**
 * JWKS endpoint: the public keys every OP-signed token is verified with.
 *
 * All three key sets are published (general, ID Token, UserInfo) including
 * rotated-out keys, so tokens signed before a rotation keep verifying until
 * they expire. A kid appears once; of the keys without a kid only the newest
 * one (the first, since a set lists its newest key first) is published.
 */
import { exportJwks, extractAlgorithmParamsFromJwk, type SigningKey } from '${corePkg}';
import { loadSigningKeys } from '../../_oidc-provider/provider';
import {
  corsPreflight,
  publicCors,
  signingKeysUnavailable,
  withCors,
} from '../../_oidc-provider/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return withCors(request, publicCors, await jwks());
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, publicCors);
}

async function jwks(): Promise<Response> {
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  const published = publishedKeys([
    ...keys.general,
    ...keys.idToken,
    ...keys.userinfo,
  ]);
  const entries = await Promise.all(
    published.map(async (key) => ({
      publicKey: await crypto.subtle.importKey(
        'jwk',
        key.publicJwk,
        extractAlgorithmParamsFromJwk(key.publicJwk),
        true,
        ['verify'],
      ),
      keyId: key.keyId,
    })),
  );

  return Response.json(await exportJwks(entries), {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
}

/**
 * The first key of every kid; keys without a kid count as one kid, so only the
 * first of them (the newest, since a set lists its newest key first) is kept.
 */
function publishedKeys(candidates: readonly SigningKey[]): SigningKey[] {
  const seenKids = new Set<string>();
  return candidates.filter((key) => {
    if (seenKids.has(key.keyId)) return false;
    seenKids.add(key.keyId);
    return true;
  });
}
`;
}
