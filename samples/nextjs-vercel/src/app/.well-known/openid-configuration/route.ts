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
import { discoveryOf, responseTypesOf, tokenGrantsOf } from '../../_oidc-provider/feature';
import { features } from '../../_oidc-provider/features';
import { ADVERTISED_SCOPES } from '../../_oidc-provider/scopes';
import { SUPPORTED_SCOPES } from '../../_oidc-provider/scopes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return withCors(request, publicCors, await providerMetadata());
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, publicCors);
}

async function providerMetadata(): Promise<Response> {
  // [load-signing-keys] Load the signing keys — OIDC Core 1.0 §10.1
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  // [build-metadata] Build the provider metadata — OIDC Discovery 1.0 §3 / RFC 8414
  // Every endpoint URL is built on config.issuer. The members below are those
  // of every provider; each feature adds its own (its endpoint, the grants it
  // answers, the response modes it signs) through the discovery entry of its
  // feature.ts.
  const issuer = config.issuer;
  const metadata = buildProviderMetadata({
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    // code, and the response types the features answer (the Implicit Flow's
    // id_token and id_token token: authorize.responseTypes of its feature.ts).
    responseTypesSupported: ['code', ...responseTypesOf(features)],
    // OAuth 2.0 Multiple Response Type Encoding Practices §2.1 / OIDC Discovery
    // 1.0 §3: the code flow answers via query. A feature that answers in
    // another response mode (the fragment of the Implicit Flow, form_post,
    // JARM) adds it to this list.
    responseModesSupported: ['query'],
    subjectTypesSupported: ['public'],
    // OIDC Core 1.0 §15.1: id_token_signing_alg_values_supported is derived from
    // every registered ID Token key, so a mixed RS256 + ES256 set is advertised
    // as such (buildProviderMetadata enforces that RS256 is present).
    idTokenSigningKeys: keys.idToken.map((key) => key.privateKey),
    userinfoEndpoint: `${issuer}/userinfo`,
    scopesSupported: [...ADVERTISED_SCOPES],
    // OIDC Discovery 1.0 §3 / Core 1.0 §5.6: this OP produces Normal Claims only
    // (no _claim_names / _claim_sources).
    claimTypesSupported: ['normal'],
    claimsSupported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      // OIDC Core 1.0 §2 / §3.1.3.6: ID Token protocol claims the OP issues
      // (at_hash for the access token issued with the ID Token, §3.1.3.6 /
      // §3.2.2.10). c_hash is omitted on purpose: the Hybrid flow is not
      // implemented.
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
    // The authorization_code grant, and the grants the features answer at the
    // token endpoint (the token entry of their feature.ts). A feature that
    // answers a grant at the authorization endpoint (implicit) adds it
    // through the discovery entry of its feature.ts.
    grantTypesSupported: ['authorization_code', ...tokenGrantsOf(features)],
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
    // OIDC Core 1.0 §6.1 / §6.2 / OIDC Discovery 1.0 §3: Request Objects are
    // advertised by the request-object feature. request_uri is not supported,
    // so it is advertised as false explicitly: Discovery defaults
    // request_uri_parameter_supported to true when omitted.
    requestParameterSupported: false,
    requestUriParameterSupported: false,
    // OIDC Discovery 1.0 §3 / Core 1.0 §5.5: the claims request parameter is
    // implemented for both the ID Token and UserInfo.
    claimsParameterSupported: true,
    // RFC 9207 §3: every authorization response carries iss.
    authorizationResponseIssParameterSupported: true,
  });

  // [respond] Respond (cacheable) — RFC 8414 §3.2 / RFC 9111 §5.2
  // Discovery metadata is cacheable; 3600s, the same freshness lifetime as the
  // JWKS endpoint.
  return Response.json(
    discoveryOf(
      features,
      // RFC 7636 / OAuth 2.1: not an OIDC Discovery field, so added here.
      { ...metadata, code_challenge_methods_supported: ['S256'] },
      issuer,
      config,
    ),
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
