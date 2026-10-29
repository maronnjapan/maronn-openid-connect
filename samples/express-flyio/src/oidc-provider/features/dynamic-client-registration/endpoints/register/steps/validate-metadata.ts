import { getJwaAlgorithm, responseTypeIncludes, type SigningKey } from '@maronn-openid-connect/core';
import {
  buildRegisteredClient,
  validateClientMetadata,
  type DynamicallyRegisteredClient,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { supportedResponseTypes } from '../../../../../endpoints/authorize/response-type.js';
import { step } from '../../../../../endpoints/step.js';
import { CUSTOM_SCOPES, STANDARD_SCOPES } from '../../../../../scopes.js';
import { features } from '../../../../enabled.js';
import { tokenGrantsOf } from '../../../../feature.js';
import type { DynamicClientRegistrationConfig } from '../../../config.js';

export const meta = step({
  id: 'validate-metadata',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'validate',
  label: 'Validate the metadata and build the client',
  spec: 'RFC 7591 §2 / §2.1',
  function: 'validateRegistrationMetadata',
  calls: ['supportedResponseTypes', 'tokenGrantsOf', 'getJwaAlgorithm', 'validateClientMetadata', 'buildRegisteredClient'],
  consumes: ['metadata'],
  produces: ['client'],
  removable: false,
});

/**
 * Allowlist-pick of the understood fields, value checks, the RFC 7591 §2 and
 * OIDC Dynamic Client Registration 1.0 §2 defaults (application_type web,
 * id_token_signed_response_alg RS256 — registered and returned, §3.2), the
 * redirect_uris constraints of the application type and the §2.1 consistency
 * of grant_types and response_types — pure functions from the experimental
 * package, bounded to what this provider answers:
 *
 * - token_endpoint_auth_method: the methods of the registration config
 * - grant_types: the grants of the config that this provider answers
 *   (authorization_code, the token grants of the generated features, implicit
 *   while a feature answers a token or id_token response type)
 * - response_types: code and the response types of the generated features,
 *   as discovery advertises them
 * - scope: any value until a custom scope is declared (scopes.ts), then the
 *   standard and the declared ones
 * - id_token_signed_response_alg / userinfo_signed_response_alg: the algs of
 *   the registered signing keys, as discovery advertises them
 * - the custom metadata of the registration config (config.ts)
 *
 * Unknown metadata is silently ignored (§2 MUST), and every error_description
 * is a fixed ASCII string that never reflects request values.
 */
export function validateRegistrationMetadata(
  c: any,
  metadata: Record<string, unknown>,
): DynamicallyRegisteredClient {
  const config: DynamicClientRegistrationConfig = c.get('dynamicClientRegistrationConfig');
  const responseTypes = supportedResponseTypes();
  const validated = validateClientMetadata(metadata, {
    tokenEndpointAuthMethods: config.tokenEndpointAuthMethods,
    grantTypes: registrableGrantTypes(config.grantTypes, responseTypes),
    responseTypes,
    scopes: registrableScopes(),
    idTokenSigningAlgValuesSupported: signingAlgsOf(c.get('idTokenSigningKeys')),
    userinfoSigningAlgValuesSupported: signingAlgsOf(c.get('userinfoSigningKeys')),
    customMetadata: config.customClientMetadata,
  });
  return buildRegisteredClient(validated);
}

/**
 * The grant_type values of the registration config that this provider answers
 * (RFC 7591 §2): authorization_code always, the grants the generated features
 * answer at the token endpoint, and implicit while a feature answers a token or
 * id_token response type at /authorize (OIDC Dynamic Client Registration 1.0 §2
 * pairs them). A grant the provider does not answer is never registrable: a
 * client registered for it could not use it.
 */
export function registrableGrantTypes(configured: readonly string[], responseTypes: readonly string[]): string[] {
  const offered = ['authorization_code', ...tokenGrantsOf(features)];
  const answersImplicit = responseTypes.some(
    (responseType) => responseTypeIncludes(responseType, 'token') || responseTypeIncludes(responseType, 'id_token'),
  );
  if (answersImplicit) offered.push('implicit');
  return configured.filter((grantType) => offered.includes(grantType));
}

/**
 * scopes.ts: once a custom scope is declared, a registration may name only the
 * standard and the declared scopes (what findUnsupportedScopes() accepts at
 * /authorize); without one there is no list, and any syntactically valid value
 * registers.
 */
export function registrableScopes(): readonly string[] | undefined {
  return CUSTOM_SCOPES.length === 0 ? undefined : [...STANDARD_SCOPES, ...CUSTOM_SCOPES];
}

/** The JWA algs of a registered signing key set, each once (what discovery advertises for it). */
function signingAlgsOf(keys: SigningKey[] | undefined): string[] {
  return [...new Set((keys ?? []).map((key) => getJwaAlgorithm(key.privateKey)))];
}
