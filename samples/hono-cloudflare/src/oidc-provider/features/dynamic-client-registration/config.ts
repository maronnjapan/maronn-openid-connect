import type {
  CustomClientMetadataValidator,
  SoftwareStatementPublisher,
  VerifiedSoftwareStatement,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import {
  customClientMetadata,
  verifyRegistrationInitialAccessToken,
  verifyRegistrationSoftwareStatement,
} from './policy.js';

/**
 * Decides whether a registration request may register, from its Authorization
 * header (OIDC Dynamic Client Registration 1.0 §3). true accepts the request;
 * false answers 401 (a bare Bearer challenge without a header, error="invalid_token"
 * with one; RFC 6750 §3.1).
 */
export type InitialAccessTokenVerifier = (
  authorization: string | undefined,
  config: DynamicClientRegistrationConfig,
) => Promise<boolean> | boolean;

/**
 * Verifies a software_statement (RFC 7591 §2.3) and returns the metadata it
 * asserts. Throw ClientRegistrationError with invalid_software_statement or
 * unapproved_software_statement to reject it (RFC 7591 §3.2.2).
 */
export type SoftwareStatementVerifier = (
  softwareStatement: string,
  config: DynamicClientRegistrationConfig,
) => Promise<VerifiedSoftwareStatement> | VerifiedSoftwareStatement;

/**
 * Dynamic client registration settings. The dynamicClientRegistration option of
 * createApp() / applyOidc() extends these defaults (feature.ts,
 * extendDynamicClientRegistrationConfig below), so change them here or per
 * deployment there — the policy functions included.
 *
 * - initialAccessToken: when set, POST /register requires
 *   `Authorization: Bearer <value>` (OIDC Dynamic Client Registration 1.0 §3).
 *   Unset means open registration (RFC 7591 §3.1 SHOULD). This is one static
 *   secret for PoC use — there is no issuance or rotation. verifyInitialAccessToken
 *   (policy.ts) is the function that reads it; replace it to check tokens of
 *   your own issuance.
 * - maxRegisteredClients: inventory cap on dynamic registrations
 *   (RFC 7591 §5 DoS consideration). The cap answers 429, not
 *   invalid_client_metadata: nothing about the metadata is wrong, so a
 *   metadata-retry loop must not be invited.
 * - maxRegistrationBodyBytes: request body limit in UTF-8 bytes.
 * - tokenEndpointAuthMethods: the token_endpoint_auth_method values a client may
 *   register (RFC 7591 §2). The three of core as generated; add private_key_jwt
 *   or another method here once the authenticate-client step of endpoints/token/
 *   verifies it. A method outside client_secret_basic / client_secret_post /
 *   client_secret_jwt registers a confidential client without a client_secret.
 * - grantTypes: the grant_type values a client may register, among those this
 *   provider answers (authorization_code, the grants of the generated features,
 *   implicit while a feature answers a token or id_token response type). A
 *   grant the provider does not answer is never registrable, whatever is listed
 *   here. Add the URN of an experimental grant (token exchange, device code,
 *   CIBA) to let dynamically registered clients use it.
 * - jwksPurposes: the ClientKeyResolver purposes the jwks of a registration
 *   serves — a registered key verifies signed Request Objects (request_object),
 *   and stands ready for private_key_jwt and DPoP once a project adds them.
 * - trustedSoftwarePublishers: the issuers whose software statements
 *   (RFC 7591 §2.3) are accepted, with the public keys that verify them.
 *   Empty as generated (fail safe): a software_statement is then answered with
 *   unapproved_software_statement.
 * - verifyInitialAccessToken / verifySoftwareStatement / customClientMetadata:
 *   the registration policy, generated into policy.ts. Edit the functions
 *   there, or pass your own through the dynamicClientRegistration option.
 */
export interface DynamicClientRegistrationConfig {
  initialAccessToken: string | undefined;
  maxRegisteredClients: number;
  maxRegistrationBodyBytes: number;
  tokenEndpointAuthMethods: readonly string[];
  grantTypes: readonly string[];
  jwksPurposes: readonly string[];
  trustedSoftwarePublishers: readonly SoftwareStatementPublisher[];
  verifyInitialAccessToken: InitialAccessTokenVerifier;
  verifySoftwareStatement: SoftwareStatementVerifier;
  customClientMetadata: Readonly<Record<string, CustomClientMetadataValidator>>;
}

export const dynamicClientRegistrationConfig: DynamicClientRegistrationConfig = {
  initialAccessToken: undefined,
  maxRegisteredClients: 100,
  maxRegistrationBodyBytes: 16384,
  tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
  grantTypes: ['authorization_code', 'refresh_token', 'implicit'],
  jwksPurposes: ['request_object', 'private_key_jwt', 'dpop'],
  trustedSoftwarePublishers: [],
  verifyInitialAccessToken: verifyRegistrationInitialAccessToken,
  verifySoftwareStatement: verifyRegistrationSoftwareStatement,
  customClientMetadata,
};

/**
 * The settings of a deployment: the generated defaults with the
 * dynamicClientRegistration option of createApp() / applyOidc() applied.
 *
 * The option adds to the lists and the table instead of replacing them, so a
 * deployment extends what the generated code allows without repeating it:
 * tokenEndpointAuthMethods, grantTypes and jwksPurposes gain the given values
 * (each once), trustedSoftwarePublishers gains the given publishers (one
 * with the issuer of a generated publisher replaces it), and
 * customClientMetadata gains the given validators (one with the name of a
 * generated validator replaces it). The scalar settings and the policy
 * functions replace the defaults; a field left out or undefined keeps them.
 * To take a value out of a generated list, edit it in config.ts.
 */
export function extendDynamicClientRegistrationConfig(
  base: DynamicClientRegistrationConfig,
  additions: Partial<DynamicClientRegistrationConfig> = {},
): DynamicClientRegistrationConfig {
  const {
    tokenEndpointAuthMethods,
    grantTypes,
    jwksPurposes,
    trustedSoftwarePublishers,
    customClientMetadata: customMetadata,
    ...replaced
  } = additions;
  const config: DynamicClientRegistrationConfig = { ...base };
  for (const [name, value] of Object.entries(replaced)) {
    if (value !== undefined) (config as unknown as Record<string, unknown>)[name] = value;
  }
  config.tokenEndpointAuthMethods = [...new Set([...base.tokenEndpointAuthMethods, ...(tokenEndpointAuthMethods ?? [])])];
  config.grantTypes = [...new Set([...base.grantTypes, ...(grantTypes ?? [])])];
  config.jwksPurposes = [...new Set([...base.jwksPurposes, ...(jwksPurposes ?? [])])];
  const added = trustedSoftwarePublishers ?? [];
  config.trustedSoftwarePublishers = [
    ...base.trustedSoftwarePublishers.filter((publisher) => !added.some((entry) => entry.issuer === publisher.issuer)),
    ...added,
  ];
  config.customClientMetadata = { ...base.customClientMetadata, ...customMetadata };
  return config;
}

declare module '../../app.js' {
  interface OidcProviderOptions {
    /**
     * EXPERIMENTAL (RFC 7591): extend the dynamic client registration
     * settings (dynamicClientRegistrationConfig in
     * features/dynamic-client-registration/config.ts) per deployment — for
     * example from environment variables — without editing the generated
     * file (extendDynamicClientRegistrationConfig). The lists and the custom
     * metadata table gain the given values, the scalar settings and the
     * policy functions (verifyInitialAccessToken, verifySoftwareStatement)
     * replace the generated ones, and an unset field keeps them.
     */
    dynamicClientRegistration?: Partial<DynamicClientRegistrationConfig>;
  }
}

declare module '../../config.js' {
  interface RegisteredClient {
    /**
     * EXPERIMENTAL (RFC 7591): every metadata value a dynamic registration
     * registered, in the wire form of the registration response (defaults
     * applied, custom metadata included), so a project's own code can read
     * client_name, logo_uri or a custom field of the client. Absent for the
     * clients of db/.
     */
    registrationMetadata?: Readonly<Record<string, unknown>>;
  }
}
