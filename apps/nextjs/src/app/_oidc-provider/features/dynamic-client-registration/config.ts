/**
 * EXPERIMENTAL — Dynamic Client Registration settings (RFC 7591).
 *
 * Read by the registration endpoint (register/route.ts), so it lives in its
 * own module. Change the values here, or extend this object where the app
 * starts (instrumentation.ts) with extendDynamicClientRegistrationConfig()
 * below, as dev-data.ts does for the environment variables.
 *
 * - maxRegisteredClients: inventory cap on dynamic registrations
 *   (RFC 7591 §5 DoS consideration). The cap answers 429, not
 *   invalid_client_metadata: nothing about the metadata is wrong, so a
 *   metadata-retry loop must not be invited.
 * - maxRegistrationBodyBytes: request body limit in UTF-8 bytes.
 * - tokenEndpointAuthMethods: the token_endpoint_auth_method values a client may
 *   register (RFC 7591 §2). The three of core as generated; add private_key_jwt
 *   or another method here once token/route.ts verifies it. A method outside
 *   client_secret_basic / client_secret_post / client_secret_jwt registers a
 *   confidential client without a client_secret.
 * - grantTypes: the grant_type values a client may register, among those this
 *   provider answers (authorization_code, the grants of the generated features,
 *   implicit while a feature answers a token or id_token response type). A
 *   grant the provider does not answer is never registrable, whatever is listed
 *   here. Add the URN of an experimental grant (token exchange, device code,
 *   CIBA) to let dynamically registered clients use it.
 * - jwksPurposes: the ClientKeyResolver purposes the jwks of a registration
 *   serves — a registered key verifies signed Request Objects (request_object),
 *   and stands ready for private_key_jwt and DPoP once a project adds them.
 * - verifyInitialAccessToken: undefined as generated, which leaves registration
 *   open (RFC 7591 §3.1 SHOULD). Set a function to require an initial access
 *   token (OIDC Dynamic Client Registration 1.0 §3): POST /register then answers
 *   401 to a request without a Bearer token, and the function decides whether
 *   the presented token may register. The generated code verifies no token of
 *   its own — the token format, its issuance and its lookup are the function's.
 * - verifySoftwareStatement: undefined as generated, which ignores a
 *   software_statement (RFC 7591 §3.1.1 lets a server that does not support
 *   them do so). Set a function to accept software statements: POST /register
 *   then requires one (invalid_client_metadata without it), and the function
 *   verifies it and returns the metadata it asserts. The generated code
 *   verifies no statement of its own.
 * - customClientMetadata: metadata beyond the standard fields that a
 *   registration may carry (RFC 7591 §2 lets a provider understand more). Each
 *   entry names one field and validates its value: return the value to register
 *   (it is echoed in the 201 response and kept in
 *   RegisteredClient.registrationMetadata), return undefined to leave the field
 *   out, or throw ClientRegistrationError with invalid_client_metadata to reject
 *   the registration. The validator also runs when the field is absent, so it
 *   can return a default. Empty as generated: every field outside the standard
 *   ones is ignored (RFC 7591 §2 MUST). Example — a tenant identifier of at
 *   most 64 characters:
 *
 *     tenant_id: (value) => {
 *       if (value === undefined) return undefined;
 *       if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value)) {
 *         throw new ClientRegistrationError('invalid_client_metadata', 'tenant_id must be a lowercase identifier');
 *       }
 *       return value;
 *     },
 */
import type {
  CustomClientMetadataValidator,
  VerifiedSoftwareStatement,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { shared } from '../../shared';

/**
 * Decides whether a registration request may register, from the Bearer token
 * of its Authorization header (OIDC Dynamic Client Registration 1.0 §3; RFC
 * 6750 §2.1). true accepts the request; false answers 401 with
 * error="invalid_token" (RFC 6750 §3.1). A request without a Bearer token is
 * answered 401 with a bare challenge before this function runs.
 */
export type InitialAccessTokenVerifier = (
  token: string,
  config: DynamicClientRegistrationConfig,
) => Promise<boolean> | boolean;

/**
 * Verifies a software_statement (RFC 7591 §2.3) and returns the metadata it
 * asserts, which the register endpoint applies over the plain JSON values
 * (RFC 7591 §3.1.1). Throw ClientRegistrationError with
 * invalid_software_statement or unapproved_software_statement to reject it
 * (§3.2.2). RFC 7591 leaves the trust criteria to the server, so this function
 * alone decides them: which issuers it accepts, how it verifies the signature,
 * which claims it reads. Nothing in the generated code examines the statement.
 */
export type SoftwareStatementVerifier = (
  softwareStatement: string,
  config: DynamicClientRegistrationConfig,
) => Promise<VerifiedSoftwareStatement> | VerifiedSoftwareStatement;

export interface DynamicClientRegistrationConfig {
  maxRegisteredClients: number;
  maxRegistrationBodyBytes: number;
  tokenEndpointAuthMethods: readonly string[];
  grantTypes: readonly string[];
  jwksPurposes: readonly string[];
  verifyInitialAccessToken: InitialAccessTokenVerifier | undefined;
  verifySoftwareStatement: SoftwareStatementVerifier | undefined;
  customClientMetadata: Readonly<Record<string, CustomClientMetadataValidator>>;
}

export const dynamicClientRegistrationConfig = shared<DynamicClientRegistrationConfig>(
  'dynamicClientRegistrationConfig',
  () => ({
    maxRegisteredClients: 100,
    maxRegistrationBodyBytes: 16384,
    tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
    grantTypes: ['authorization_code', 'refresh_token', 'implicit'],
    jwksPurposes: ['request_object', 'private_key_jwt', 'dpop'],
    verifyInitialAccessToken: undefined,
    verifySoftwareStatement: undefined,
    customClientMetadata: {},
  }),
);

declare module '../../config' {
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

/**
 * Extend the settings of this process where the app starts (instrumentation.ts).
 *
 * The additions add to the lists and the table instead of replacing them, so a
 * deployment extends what the generated code allows without repeating it:
 * tokenEndpointAuthMethods, grantTypes and jwksPurposes gain the given values
 * (each once), and customClientMetadata gains the given validators (one with
 * the name of a generated validator replaces it). The scalar settings and the
 * verifier functions replace the defaults; a field left out or undefined keeps
 * them. To take a value out of a generated list, or to drop a verifier set
 * above, edit it above.
 */
export function extendDynamicClientRegistrationConfig(additions: Partial<DynamicClientRegistrationConfig>): void {
  const { tokenEndpointAuthMethods, grantTypes, jwksPurposes, customClientMetadata: customMetadata, ...replaced } = additions;
  const config = dynamicClientRegistrationConfig;
  for (const [name, value] of Object.entries(replaced)) {
    if (value !== undefined) (config as unknown as Record<string, unknown>)[name] = value;
  }
  config.tokenEndpointAuthMethods = [...new Set([...config.tokenEndpointAuthMethods, ...(tokenEndpointAuthMethods ?? [])])];
  config.grantTypes = [...new Set([...config.grantTypes, ...(grantTypes ?? [])])];
  config.jwksPurposes = [...new Set([...config.jwksPurposes, ...(jwksPurposes ?? [])])];
  config.customClientMetadata = { ...config.customClientMetadata, ...customMetadata };
}
