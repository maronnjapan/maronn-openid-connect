/**
 * Discovery and JWKS endpoints (`routes/discovery.ts`, `routes/jwks.ts`) for
 * the hono / express / fastify output: one fragment per step of the
 * `discovery` and `jwks` endpoints of the flow catalog.
 */
import { DEFAULT_FEATURES } from '../../../features.js';
import type { OidcFeatureConfig } from '../../../features.js';
import { buildOpFlow } from '../../../flow/catalog.js';
import { renderPipelineRoute, type StepFragment } from '../pipeline.js';

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const COLLECT_SIGNING_ALGORITHMS: StepFragment = {
  imports: { core: ['getJwaAlgorithm', 'type SigningKey'] },
  definition: `/**
 * Collect what the registered key sets let the OP advertise: the ID Token
 * signing keys (id_token_signing_alg_values_supported is derived from them,
 * OIDC Core 1.0 §15.1) and the UserInfo signing algorithms (§5.3.2).
 */
export function collectAdvertisedSigningKeys(c: any): {
  idTokenSigningKeys: CryptoKey[];
  userinfoSigningAlgValues: string[];
} {
  // Derive id_token_signing_alg_values_supported from the actual key set
  // (OIDC Core 1.0 §15.1 — RS256 presence is enforced by buildProviderMetadata).
  // T-022: 全 registered ID Token 鍵の alg を集約することで RS256+ES256 など
  // 混在鍵セットも正しく advertise できる。
  const idTokenSigningKeyArr = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
  const idTokenSigningKeys: CryptoKey[] = idTokenSigningKeyArr.map((k) => k.privateKey);

  // OIDC Core 1.0 §5.3.2 / §3 discovery: advertise the UserInfo signing algs the OP
  // can actually sign with, derived from the registered UserInfo key set (RS256,
  // ES256, ...), so userinfo_signed_response_alg clients can rely on metadata.
  const userinfoSigningKeyArr = (c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? [];
  const userinfoSigningAlgValues = [
    ...new Set(userinfoSigningKeyArr.map((k) => getJwaAlgorithm(k.privateKey))),
  ];
  return { idTokenSigningKeys, userinfoSigningAlgValues };
}`,
  call: { bind: ['idTokenSigningKeys', 'userinfoSigningAlgValues'], expression: 'collectAdvertisedSigningKeys(c)' },
};

function buildMetadataFragment(features: OidcFeatureConfig, scopes: string[]): StepFragment {
  const customScopesDeclared = scopes.length > 0;
  const scopesSupportedEntry = customScopesDeclared
    ? `    // OIDC Discovery 1.0 §3: scopes_supported is this OP's scope allow list —
    // the standard scopes plus the custom ones declared with --scope (see
    // scopes.ts). It is OP metadata, so it lists what the provider accepts, not
    // what a particular End-User is granted (resolveGrantableScopes decides that).
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
  const supportedGrantTypes = [
    `'authorization_code'`,
    ...(features.refreshToken ? [`'refresh_token'`] : []),
    // EXPERIMENTAL (ID-JAG draft §4.3): issuing an ID-JAG happens on the
    // token-exchange grant, so enabling id-jag alone also advertises it.
    ...(features.tokenExchange || features.idJag
      ? [`'urn:ietf:params:oauth:grant-type:token-exchange'`]
      : []),
    // EXPERIMENTAL (ID-JAG draft §7.2): a resource AS that advertises the
    // id-jag grant profile MUST also advertise the jwt-bearer grant.
    ...(features.idJag ? [`'urn:ietf:params:oauth:grant-type:jwt-bearer'`] : []),
    ...(features.deviceAuthorizationGrant ? [`'urn:ietf:params:oauth:grant-type:device_code'`] : []),
    ...(features.ciba ? [`'urn:openid:params:grant-type:ciba'`] : []),
  ];
  const requestObjectMetadata = features.requestObject
    ? `    // OIDC Core 1.0 §6.1 / OIDC Discovery 1.0 §3: signed Request Object by value is
    // supported (verified against the client's registered JWKS). request_uri (§6.2)
    // is not supported, so it is explicitly advertised as false (Discovery defaults
    // request_uri_parameter_supported to true when omitted). RS256 is the required
    // signing alg; 'none' is added only when unsigned objects are accepted for
    // Basic OP conformance compatibility.
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
      ? `    // RFC 8414 — both endpoints require confidential client authentication.
`
      : features.introspection || features.revocation
        ? `    // RFC 8414 — the endpoint requires confidential client authentication.
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
    ? `    // OAuth 2.0 Multiple Response Type Encoding Practices §2 / OIDC Discovery 1.0 §3:
    // the OP only implements the authorization code flow, whose authorization
    // response is returned via query. EXPERIMENTAL (JARM §4): this provider was
    // generated with --enable jarm, so the JWT-secured query modes are advertised
    // alongside it. Extend this list when form_post (or other modes) are added.
    responseModesSupported: ['query', 'query.jwt', 'jwt'],`
    : `    // OAuth 2.0 Multiple Response Type Encoding Practices §2 / OIDC Discovery 1.0 §3:
    // the OP only implements the authorization code flow, whose authorization
    // response is returned via query, so response_modes_supported is pinned to
    // ['query']. Extend this list when form_post (or other modes) are added.
    responseModesSupported: ['query'],`;
  const jarmDiscoveryMetadata = features.jarm
    ? `
    // EXPERIMENTAL — JARM §4 metadata. The response JWT is always signed with
    // RS256 (JARM §3: the default for a client that registered no
    // authorization_signed_response_alg), so exactly one alg is advertised.
    authorization_signing_alg_values_supported: ['RS256'],`
    : '';
  const parDiscoveryMetadata = features.par
    ? `
    // EXPERIMENTAL — RFC 9126 §5 metadata. require_pushed_authorization_requests
    // is only advertised when PAR is actually enforced (its default is false).
    pushed_authorization_request_endpoint: \`\${issuer}/par\`,
    ...(parConfig.requirePushedAuthorizationRequests
      ? { require_pushed_authorization_requests: true }
      : {}),`
    : '';
  const deviceDiscoveryMetadata = features.deviceAuthorizationGrant
    ? `
    // EXPERIMENTAL — RFC 8628 §4 metadata.
    device_authorization_endpoint: \`\${issuer}/device_authorization\`,`
    : '';
  const cibaDiscoveryMetadata = features.ciba
    ? `
    // EXPERIMENTAL — CIBA Core 1.0 §4 metadata. Only the poll delivery mode is
    // offered, so exactly one mode is advertised.
    backchannel_token_delivery_modes_supported: ['poll'],
    backchannel_authentication_endpoint: \`\${issuer}/backchannel_authentication\`,`
    : '';
  const idJagDiscoveryMetadata = features.idJag
    ? `
    // EXPERIMENTAL — ID-JAG draft §7.1: this OP can issue an ID-JAG via token
    // exchange (identity-chaining requested token type).
    identity_chaining_requested_token_types_supported: ['urn:ietf:params:oauth:token-type:id-jag'],
    // EXPERIMENTAL — ID-JAG draft §7.2: this OP can process the ID-JAG grant
    // profile on the jwt-bearer grant. Which issuers are actually trusted is
    // local policy and is not disclosed here (draft §9.4).
    authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],`
    : '';
  const jwtIntrospectionResponseDiscoveryMetadata =
    features.introspection && features.jwtIntrospectionResponse
      ? `
    // EXPERIMENTAL — RFC 9701 §7 metadata. The introspection response JWT is
    // always signed with RS256 (§6: the default for a client that registered no
    // introspection_signed_response_alg), so exactly one alg is advertised.
    introspection_signing_alg_values_supported: ['RS256'],`
      : '';
  const rpInitiatedLogoutDiscoveryMetadata = features.rpInitiatedLogout
    ? `
    // EXPERIMENTAL — RP-Initiated Logout 1.0 §2.1 metadata.
    end_session_endpoint: \`\${issuer}/logout\`,`
    : '';
  const dcrDiscoveryMetadata = features.dynamicClientRegistration
    ? `    // EXPERIMENTAL — OIDC Discovery 1.0 §3: the client registration endpoint
    // (RFC 7591) is advertised only because this OP was generated with
    // --enable dynamic-client-registration.
    registrationEndpoint: \`\${issuer}/register\`,
`
    : '';
  return {
    imports: {
      core: ['buildProviderMetadata'],
      config: ['defaultProviderConfig'],
      modules: {
        ...(features.par ? { './par.js': ['parConfig'] } : {}),
        ...(customScopesDeclared ? { '../scopes.js': ['SUPPORTED_SCOPES'] } : {}),
      },
    },
    definition: `/**
 * Build the provider metadata document.
 * OIDC Discovery 1.0 §3 / RFC 8414
 *
 * Every endpoint URL is built on config.issuer. The entries a feature adds
 * (introspection, revocation, the experimental endpoints) are here only
 * because that feature was generated.
 */
export function buildDiscoveryMetadata(
  c: any,
  input: { idTokenSigningKeys: CryptoKey[]; userinfoSigningAlgValues: string[] },
): Record<string, unknown> {
  const { idTokenSigningKeys, userinfoSigningAlgValues } = input;
  const config = c.get('config') ?? defaultProviderConfig;
  const issuer = config.issuer;

  const metadata = buildProviderMetadata({
    issuer,
    authorizationEndpoint: \`\${issuer}/authorize\`,
    tokenEndpoint: \`\${issuer}/token\`,
    jwksUri: \`\${issuer}/.well-known/jwks.json\`,
    responseTypesSupported: ['code'],
${responseModesSupportedEntry}
    subjectTypesSupported: ['public'],
    idTokenSigningKeys,
    userinfoEndpoint: \`\${issuer}/userinfo\`,
${scopesSupportedEntry}    // OIDC Discovery 1.0 §3 / Core 1.0 §5.6: this OP produces Normal Claims only
    // (no _claim_names / _claim_sources), so advertise ['normal'] explicitly to make
    // the lack of Aggregated/Distributed support machine-readable.
    claimTypesSupported: ['normal'],
    claimsSupported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      // OIDC Core 1.0 §2 / §3.1.3.6: ID Token protocol claims the OP issues
      // (id-token.ts). auth_time/nonce/acr/amr are set from the auth context,
      // azp for multi-audience tokens, at_hash for code flow access tokens.
      // c_hash is intentionally omitted (Hybrid flow is not implemented).
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
    // Required when any client uses userinfo_signed_response_alg
    // (OIDC Core 1.0 Section 5.3.2). Derived from the registered UserInfo key set so
    // ES256 (and other) algs are advertised once a matching key is configured.
    userinfoSigningAlgValuesSupported: userinfoSigningAlgValues,
${requestObjectMetadata}    // OIDC Discovery 1.0 §3 / Core 1.0 §5.5: the 'claims' request parameter is
    // implemented for both the ID Token and UserInfo paths, so it is advertised
    // as supported. Without this (defaults to false) spec-compliant RPs would
    // never send the 'claims' parameter.
    claimsParameterSupported: true,
    // RFC 9207 §3: authorize endpoint adds iss to all authorization responses.
    authorizationResponseIssParameterSupported: true,
${rfc8414Comment}${introspectionMetadata}${revocationMetadata}${dcrDiscoveryMetadata}  });

  // code_challenge_methods_supported is defined in OAuth 2.1 / PKCE spec,
  // not in OIDC Discovery, so it is added separately.
  return {
    ...metadata,
    code_challenge_methods_supported: ['S256'],${parDiscoveryMetadata}${deviceDiscoveryMetadata}${cibaDiscoveryMetadata}${jarmDiscoveryMetadata}${idJagDiscoveryMetadata}${jwtIntrospectionResponseDiscoveryMetadata}${rpInitiatedLogoutDiscoveryMetadata}
  };
}`,
    call: { bind: 'metadata', expression: 'buildDiscoveryMetadata(c, { idTokenSigningKeys, userinfoSigningAlgValues })' },
  };
}

const RESPOND_DISCOVERY: StepFragment = {
  definition: `/**
 * RFC 8414 §3.2 / RFC 9111 §5.2: Discovery metadata is cacheable. Advertise a
 * 3600s freshness lifetime, symmetric with the JWKS endpoint (jwks.ts), so
 * client libraries reuse the metadata deterministically.
 */
export function respondDiscovery(c: any, metadata: Record<string, unknown>): Response {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(metadata);
}`,
  call: `    return respondDiscovery(c, metadata);`,
};

/** The generated `routes/discovery.ts`. `steps` is the `--flow` selection for the endpoint. */
export function discoveryRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
  steps?: string[],
): string {
  const endpoint = buildOpFlow({ features, scopes }).endpoints.find((e) => e.id === 'discovery');
  if (endpoint === undefined) throw new Error('The flow catalog has no discovery endpoint');
  return renderPipelineRoute({
    endpoint,
    fragments: {
      'collect-signing-algorithms': COLLECT_SIGNING_ALGORITHMS,
      'build-metadata': buildMetadataFragment(features, scopes),
      respond: RESPOND_DISCOVERY,
    },
    ...(steps === undefined ? {} : { selection: steps }),
    corePkg,
    fixedImports: { hono: true },
    header: `/**
 * OpenID Connect Discovery endpoint (API layer).
 * OIDC Discovery 1.0 Section 4
 *
 * Every function exported below is one box of the discovery endpoint's
 * pipeline (\`maronn-oidc graph --detail steps --endpoint discovery\`).
 */

export const discoveryApp = new Hono<{ Variables: Record<string, any> }>();`,
    handlerOpen: `/**
 * OpenID Connect Discovery Endpoint
 * OIDC Discovery 1.0 Section 4
 */
discoveryApp.get('/', (c) => {
  {`,
    handlerClose: `  }
});
`,
  });
}

// ---------------------------------------------------------------------------
// JWKS
// ---------------------------------------------------------------------------

const COLLECT_PUBLIC_KEYS: StepFragment = {
  imports: { core: ['type SigningKey'] },
  definition: `/**
 * Collect every registered signing key of the per-purpose key sets
 * (signingKeys / idTokenSigningKeys / userinfoSigningKeys).
 *
 * T-022: every key is published so rotated-out keys remain verifiable until
 * tokens signed with them expire.
 */
export function collectPublishedKeys(c: any): SigningKey[] {
  return [
    ...((c.get('signingKeys') as SigningKey[] | undefined) ?? []),
    ...((c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? []),
    ...((c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? []),
  ];
}`,
  call: { bind: 'keys', expression: 'collectPublishedKeys(c)' },
};

const EXPORT_JWKS: StepFragment = {
  imports: { core: ['exportJwks', 'extractAlgorithmParamsFromJwk', 'type JwkSet', 'type SigningKey'] },
  definition: `/**
 * Export the public halves as a JWK Set (RFC 7517 §5). kid 指定がある鍵は kid で
 * 重複排除し、kid 未指定の鍵は最新の 1 件のみ採用する（鍵セットは新しい鍵ほど
 * 先頭にある）。An empty key set is a server configuration error.
 */
export async function buildJwksDocument(keys: SigningKey[]): Promise<JwkSet> {
  if (keys.length === 0) {
    throw new Error('No signing key is registered');
  }

  // 同じ kid の鍵は最初に出現したものだけを採用する（ID Token / UserInfo 用の
  // プロバイダは既定で汎用プロバイダと同じ鍵を返すため）。kid 未指定の鍵も同様に
  // 最初の 1 件（= 最新）だけを採用する。
  const seenKids = new Set<string>();
  const entries: { publicKey: CryptoKey; keyId?: string }[] = [];
  for (const key of keys) {
    if (seenKids.has(key.keyId)) continue;
    seenKids.add(key.keyId);
    const jwk = key.publicJwk as JsonWebKey;
    const algParams = extractAlgorithmParamsFromJwk(jwk);
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      algParams,
      true,
      ['verify'],
    );
    entries.push({ publicKey, keyId: key.keyId });
  }

  return exportJwks(entries);
}`,
  call: { bind: 'jwks', expression: 'await buildJwksDocument(keys)' },
};

const RESPOND_JWKS: StepFragment = {
  imports: { core: ['type JwkSet'] },
  definition: `/** Respond with the cacheable JWK Set (3600s, symmetric with discovery). */
export function respondJwks(c: any, jwks: JwkSet): Response {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(jwks);
}`,
  call: `    return respondJwks(c, jwks);`,
};

/** The generated `routes/jwks.ts`. `steps` is the `--flow` selection for the endpoint. */
export function jwksRouteTemplate(corePkg: string, steps?: string[]): string {
  const endpoint = buildOpFlow({ features: DEFAULT_FEATURES }).endpoints.find((e) => e.id === 'jwks');
  if (endpoint === undefined) throw new Error('The flow catalog has no jwks endpoint');
  return renderPipelineRoute({
    endpoint,
    fragments: {
      'collect-public-keys': COLLECT_PUBLIC_KEYS,
      'export-jwks': EXPORT_JWKS,
      respond: RESPOND_JWKS,
    },
    ...(steps === undefined ? {} : { selection: steps }),
    corePkg,
    fixedImports: { hono: true },
    header: `/**
 * JWKS endpoint (API layer).
 * Serves the public keys used to verify token signatures.
 *
 * Every function exported below is one box of the JWKS endpoint's pipeline
 * (\`maronn-oidc graph --detail steps --endpoint jwks\`).
 */

export const jwksApp = new Hono<{ Variables: Record<string, any> }>();`,
    handlerOpen: `/**
 * JWKS Endpoint
 */
jwksApp.get('/', async (c) => {
  try {`,
    handlerClose: `  } catch {
    // An empty key set (or a key that cannot be exported) is a configuration
    // problem of the OP, never the caller's.
    return c.json({ error: 'server_error' }, 500);
  }
});
`,
  });
}
