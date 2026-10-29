import {
  verifyInitialAccessToken,
  verifySoftwareStatement,
  type CustomClientMetadataValidator,
  type VerifiedSoftwareStatement,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import type { DynamicClientRegistrationConfig } from './config.js';

/**
 * EXPERIMENTAL — the registration policy of POST /register (RFC 7591): who may
 * register, which software statements are trusted, and which metadata beyond
 * the standard fields is accepted.
 *
 * The three exports below are the defaults of dynamicClientRegistrationConfig
 * (config.ts). Edit them here, or pass your own functions through the
 * dynamicClientRegistration option of createApp() / applyOidc().
 */

/**
 * Decide whether a request may register, from its Authorization header
 * (OIDC Dynamic Client Registration 1.0 §3).
 *
 * As generated: open registration while initialAccessToken is unset (RFC 7591
 * §3.1 SHOULD); otherwise the Bearer token (RFC 6750 §2.1) must equal it, in
 * constant time. Replace the body to accept tokens of your own issuance — a
 * signed JWT, a one-time token looked up in a store — and return true for a
 * request that may register.
 */
export async function verifyRegistrationInitialAccessToken(
  authorization: string | undefined,
  config: DynamicClientRegistrationConfig,
): Promise<boolean> {
  if (config.initialAccessToken === undefined) return true;
  if (authorization === undefined) return false;
  return verifyInitialAccessToken(authorization, config.initialAccessToken);
}

/**
 * Verify a software_statement (RFC 7591 §2.3 / §3.1.1) and return the metadata
 * it asserts; the step then applies that metadata over the plain JSON values.
 *
 * As generated: the statement must be signed by one of
 * config.trustedSoftwarePublishers (RS256 or ES256 unless a publisher lists
 * other algorithms), carry its iss, and be within exp / nbf. Any other issuer
 * is unapproved_software_statement; a statement that does not verify is
 * invalid_software_statement (RFC 7591 §3.2.2). To look the publisher up
 * elsewhere (a database, a federation), replace the body and throw
 * ClientRegistrationError with one of those two codes to reject.
 */
export async function verifyRegistrationSoftwareStatement(
  softwareStatement: string,
  config: DynamicClientRegistrationConfig,
): Promise<VerifiedSoftwareStatement> {
  return verifySoftwareStatement(softwareStatement, { publishers: config.trustedSoftwarePublishers });
}

/**
 * Metadata beyond the standard fields that a registration may carry (RFC 7591
 * §2 lets a provider understand more). Each entry names one field and
 * validates its value: return the value to register (it is echoed in the 201
 * response and kept in RegisteredClient.registrationMetadata), return
 * undefined to leave the field out, or throw ClientRegistrationError with
 * invalid_client_metadata to reject the registration. The validator also runs
 * when the field is absent, so it can return a default.
 *
 * Empty as generated: every field outside the standard ones is ignored
 * (RFC 7591 §2 MUST). Example — a tenant identifier of at most 64 characters:
 *
 *   tenant_id: (value) => {
 *     if (value === undefined) return undefined;
 *     if (typeof value !== 'string' || value.length > 64 || !/^[a-z0-9-]+$/.test(value)) {
 *       throw new ClientRegistrationError('invalid_client_metadata', 'tenant_id must be a lowercase identifier');
 *     }
 *     return value;
 *   },
 */
export const customClientMetadata: Record<string, CustomClientMetadataValidator> = {};
