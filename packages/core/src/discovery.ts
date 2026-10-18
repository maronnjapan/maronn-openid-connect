/**
 * OpenID Connect Discovery 1.0
 * https://openid.net/specs/openid-connect-discovery-1_0.html
 */

import { getJwaAlgorithm } from './crypto-utils.js';
import { isLoopbackHostname } from './loopback.js';
import { assertHasRs256Key } from './signing-key.js';

/**
 * Provider Metadata configuration (camelCase input)
 * Maps to the OpenID Provider Metadata fields defined in Section 3.
 */
export interface ProviderMetadataConfig {
  // Required
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  responseTypesSupported: string[];
  subjectTypesSupported: string[];
  /**
   * ID Token signing keys registered with the OP. The list of advertised
   * `id_token_signing_alg_values_supported` is derived from these keys via
   * `getJwaAlgorithm` (deduplicated). Must include at least one RS256 key
   * (OIDC Core 1.0 §15.1, enforced by `assertHasRs256Key`).
   *
   * Letting the OP advertise an alg list it cannot actually sign with breaks
   * client-side ID Token verification, so we derive the list from the actual
   * keys instead of accepting a manual string list.
   */
  idTokenSigningKeys: CryptoKey[];

  // Recommended
  userinfoEndpoint?: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  claimsSupported?: string[];
  /**
   * OIDC Discovery 1.0 §3: Claim Types the OP supports (`normal` / `aggregated` /
   * `distributed`). OPTIONAL; omitted means `normal` only. This OP implements Normal
   * Claims only, so only `["normal"]` is valid here — any other value is rejected to
   * avoid advertising an unimplemented capability (Aggregated/Distributed).
   */
  claimTypesSupported?: string[];
  /**
   * Algorithms the OP can use to sign UserInfo responses.
   * Required to advertise when any client uses userinfo_signed_response_alg
   * (OIDC Discovery 1.0 Section 3, Core 1.0 Section 5.3.2).
   */
  userinfoSigningAlgValuesSupported?: string[];

  // Optional
  grantTypesSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  responseModesSupported?: string[];
  claimsParameterSupported?: boolean;
  requestParameterSupported?: boolean;
  requestUriParameterSupported?: boolean;
  /**
   * OIDC Discovery 1.0 §3: JWS `alg` values the OP supports for signed Request
   * Objects (`request` parameter). Advertise when `requestParameterSupported` is
   * true so clients know which signing algorithms to use (e.g. `["RS256"]`).
   */
  requestObjectSigningAlgValuesSupported?: string[];

  // RFC 9207 §3: indicates that the AS returns the `iss` parameter in
  // authorization responses for issuer identification.
  authorizationResponseIssParameterSupported?: boolean;

  // RFC 8414 (OAuth 2.0 Authorization Server Metadata) — advertised here
  // because the major IdPs put them on this same document even though
  // OIDC Discovery 1.0 itself does not define them.
  introspectionEndpoint?: string;
  introspectionEndpointAuthMethodsSupported?: string[];
  revocationEndpoint?: string;
  revocationEndpointAuthMethodsSupported?: string[];
}

/**
 * OpenID Provider Metadata (snake_case output as per the spec)
 */
export interface ProviderMetadata {
  // Required
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];

  // Recommended
  userinfo_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  claims_supported?: string[];
  claim_types_supported?: string[];
  userinfo_signing_alg_values_supported?: string[];

  // Optional
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  response_modes_supported?: string[];
  claims_parameter_supported?: boolean;
  request_parameter_supported?: boolean;
  request_uri_parameter_supported?: boolean;
  request_object_signing_alg_values_supported?: string[];

  // RFC 9207 §3
  authorization_response_iss_parameter_supported?: boolean;

  // RFC 8414
  introspection_endpoint?: string;
  introspection_endpoint_auth_methods_supported?: string[];
  revocation_endpoint?: string;
  revocation_endpoint_auth_methods_supported?: string[];
}

/**
 * Validate issuer per OIDC Discovery Section 3:
 * - MUST use https scheme (except loopback hosts for development)
 * - MUST NOT contain query parameters
 * - MUST NOT contain fragments
 */
function validateIssuer(issuer: string): void {
  if (!issuer) {
    throw new Error('issuer is required');
  }

  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`issuer must be a valid URL: ${issuer}`);
  }

  if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('issuer must use https scheme (except loopback hosts)');
  }

  if (url.search) {
    throw new Error('issuer must not contain query parameters');
  }

  if (url.hash) {
    throw new Error('issuer must not contain a fragment');
  }
}

/**
 * Build OpenID Provider Metadata from configuration.
 * Validates required fields and returns the metadata object per OIDC Discovery 1.0.
 */
export function buildProviderMetadata(config: ProviderMetadataConfig): ProviderMetadata {
  validateIssuer(config.issuer);

  if (!config.authorizationEndpoint) {
    throw new Error('authorizationEndpoint is required');
  }
  if (!config.tokenEndpoint) {
    throw new Error('tokenEndpoint is required');
  }
  if (!config.jwksUri) {
    throw new Error('jwksUri is required');
  }
  if (!config.responseTypesSupported || config.responseTypesSupported.length === 0) {
    throw new Error('responseTypesSupported must not be empty');
  }
  if (!config.subjectTypesSupported || config.subjectTypesSupported.length === 0) {
    throw new Error('subjectTypesSupported must not be empty');
  }
  if (!config.idTokenSigningKeys || config.idTokenSigningKeys.length === 0) {
    throw new Error('idTokenSigningKeys must not be empty');
  }
  // OIDC Core 1.0 §15.1: at least one RS256 key must be present.
  assertHasRs256Key(config.idTokenSigningKeys);

  // Derive advertised algorithms from the actual key set, deduplicated.
  // Set preserves insertion order so the output is deterministic per call site.
  const idTokenAlgs: string[] = [];
  const seenAlgs = new Set<string>();
  for (const key of config.idTokenSigningKeys) {
    const alg = getJwaAlgorithm(key);
    if (!seenAlgs.has(alg)) {
      seenAlgs.add(alg);
      idTokenAlgs.push(alg);
    }
  }

  const metadata: ProviderMetadata = {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    jwks_uri: config.jwksUri,
    response_types_supported: config.responseTypesSupported,
    subject_types_supported: config.subjectTypesSupported,
    id_token_signing_alg_values_supported: idTokenAlgs,
  };

  // Recommended fields
  if (config.userinfoEndpoint) {
    metadata.userinfo_endpoint = config.userinfoEndpoint;
  }
  if (config.registrationEndpoint) {
    metadata.registration_endpoint = config.registrationEndpoint;
  }
  // Arrays with zero elements MUST be omitted (OIDC Discovery spec)
  if (config.scopesSupported && config.scopesSupported.length > 0) {
    metadata.scopes_supported = config.scopesSupported;
  }
  if (config.claimsSupported && config.claimsSupported.length > 0) {
    metadata.claims_supported = config.claimsSupported;
  }
  if (config.claimTypesSupported && config.claimTypesSupported.length > 0) {
    // OIDC Core 1.0 §5.6: this OP only produces Normal Claims (filterClaimsByScope
    // never emits _claim_names / _claim_sources), so reject any value other than
    // 'normal' to keep the advertisement honest.
    const invalid = config.claimTypesSupported.filter((t) => t !== 'normal');
    if (invalid.length > 0) {
      throw new Error(
        `Unsupported claim_types_supported value(s): ${invalid.join(', ')}. Only 'normal' is supported.`,
      );
    }
    metadata.claim_types_supported = config.claimTypesSupported;
  }
  if (
    config.userinfoSigningAlgValuesSupported &&
    config.userinfoSigningAlgValuesSupported.length > 0
  ) {
    metadata.userinfo_signing_alg_values_supported =
      config.userinfoSigningAlgValuesSupported;
  }

  // Optional fields
  if (config.grantTypesSupported && config.grantTypesSupported.length > 0) {
    metadata.grant_types_supported = config.grantTypesSupported;
  }
  if (config.tokenEndpointAuthMethodsSupported && config.tokenEndpointAuthMethodsSupported.length > 0) {
    metadata.token_endpoint_auth_methods_supported = config.tokenEndpointAuthMethodsSupported;
  }
  if (config.responseModesSupported && config.responseModesSupported.length > 0) {
    metadata.response_modes_supported = config.responseModesSupported;
  }
  if (config.claimsParameterSupported !== undefined) {
    metadata.claims_parameter_supported = config.claimsParameterSupported;
  }
  if (config.requestParameterSupported !== undefined) {
    metadata.request_parameter_supported = config.requestParameterSupported;
  }
  if (config.requestUriParameterSupported !== undefined) {
    metadata.request_uri_parameter_supported = config.requestUriParameterSupported;
  }
  if (
    config.requestObjectSigningAlgValuesSupported &&
    config.requestObjectSigningAlgValuesSupported.length > 0
  ) {
    metadata.request_object_signing_alg_values_supported =
      config.requestObjectSigningAlgValuesSupported;
  }

  // RFC 9207 §3: advertise issuer identification in authorization responses.
  if (config.authorizationResponseIssParameterSupported !== undefined) {
    metadata.authorization_response_iss_parameter_supported =
      config.authorizationResponseIssParameterSupported;
  }

  // RFC 8414 fields. Endpoint URL is required to advertise the matching
  // *_auth_methods_supported list (RFC 8414 Section 2).
  if (config.introspectionEndpoint) {
    metadata.introspection_endpoint = config.introspectionEndpoint;
  }
  if (
    config.introspectionEndpointAuthMethodsSupported &&
    config.introspectionEndpointAuthMethodsSupported.length > 0
  ) {
    metadata.introspection_endpoint_auth_methods_supported =
      config.introspectionEndpointAuthMethodsSupported;
  }
  if (config.revocationEndpoint) {
    metadata.revocation_endpoint = config.revocationEndpoint;
  }
  if (
    config.revocationEndpointAuthMethodsSupported &&
    config.revocationEndpointAuthMethodsSupported.length > 0
  ) {
    metadata.revocation_endpoint_auth_methods_supported =
      config.revocationEndpointAuthMethodsSupported;
  }

  return metadata;
}
