/**
 * OpenID Provider Configuration (OIDC Discovery 1.0 §4).
 */
import { buildProviderMetadata, getJwaAlgorithm } from '@maronn-openid-connect/core';
import { config, loadSigningKeys } from '../../_oidc-provider/provider';
import {
  corsPreflight,
  publicCors,
  signingKeysUnavailable,
  withCors,
} from '../../_oidc-provider/http';

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
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    responseTypesSupported: ['code'],
    // OAuth 2.0 Multiple Response Type Encoding Practices §2 / OIDC Discovery 1.0
    // §3: the OP only implements the authorization code flow, whose response is
    // returned via query, so response_modes_supported is pinned to ['query'].
    responseModesSupported: ['query'],
    subjectTypesSupported: ['public'],
    // OIDC Core 1.0 §15.1: id_token_signing_alg_values_supported is derived from
    // every registered ID Token key, so a mixed RS256 + ES256 set is advertised
    // as such (buildProviderMetadata enforces that RS256 is present).
    idTokenSigningKeys: keys.idToken.map((key) => key.privateKey),
    userinfoEndpoint: `${issuer}/userinfo`,
    // OIDC Core 1.0 §11: offline_access is advertised so relying parties (and the
    // OIDF Conformance Suite's oidcc-refresh-token module) know they may request
    // refresh tokens via 'scope=openid offline_access' with prompt=consent.
    // It is a refresh-token request scope, not a claim scope, so no matching
    // entry is added to claimsSupported.
    scopesSupported: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'],
    // OIDC Discovery 1.0 §3 / Core 1.0 §5.6: this OP produces Normal Claims only
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
    grantTypesSupported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'urn:openid:params:grant-type:ciba'],
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
    // OIDC Core 1.0 §6.1 / OIDC Discovery 1.0 §3: a signed Request Object by value
    // is supported (verified against the client's registered JWKS). request_uri
    // (§6.2) is not, so it is advertised as false explicitly — Discovery defaults
    // request_uri_parameter_supported to true when omitted. 'none' is added only
    // when unsigned objects are accepted for Basic OP conformance compatibility.
    requestParameterSupported: true,
    requestUriParameterSupported: false,
    requestObjectSigningAlgValuesSupported: config.allowUnsignedRequestObject
      ? ['RS256', 'none']
      : ['RS256'],
    // OIDC Discovery 1.0 §3 / Core 1.0 §5.5: the claims request parameter is
    // implemented for both the ID Token and UserInfo.
    claimsParameterSupported: true,
    // RFC 9207 §3: every authorization response carries iss.
    authorizationResponseIssParameterSupported: true,
    // RFC 8414 — both endpoints require client authentication.
    introspectionEndpoint: `${issuer}/introspect`,
    introspectionEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
    ],
    revocationEndpoint: `${issuer}/revoke`,
    revocationEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
    ],
  });

  // RFC 8414 §3.2 / RFC 9111 §5.2: discovery metadata is cacheable; 3600s, the
  // same freshness lifetime as the JWKS endpoint.
  return Response.json(
    {
      ...metadata,
      // RFC 7636 / OAuth 2.1: not an OIDC Discovery field, so added here.
      code_challenge_methods_supported: ['S256'],
      // EXPERIMENTAL — RFC 8628 §4.
      device_authorization_endpoint: `${issuer}/device_authorization`,
      // EXPERIMENTAL — CIBA Core 1.0 §4. Only the poll delivery mode is offered.
      backchannel_token_delivery_modes_supported: ['poll'],
      backchannel_authentication_endpoint: `${issuer}/backchannel_authentication`,
    },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
