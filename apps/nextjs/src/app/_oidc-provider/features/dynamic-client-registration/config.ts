/**
 * EXPERIMENTAL — Dynamic Client Registration settings (RFC 7591).
 *
 * Read by the registration endpoint (register/route.ts), so it lives in its
 * own module.
 *
 * - initialAccessToken: when set, POST /register requires
 *   `Authorization: Bearer <value>` (OIDC Dynamic Client Registration 1.0 §3).
 *   Unset means open registration (RFC 7591 §3.1 SHOULD). This is one static
 *   secret for PoC use — there is no issuance or rotation.
 * - maxRegisteredClients: inventory cap on dynamic registrations
 *   (RFC 7591 §5 DoS consideration). The cap answers 429, not
 *   invalid_client_metadata: nothing about the metadata is wrong, so a
 *   metadata-retry loop must not be invited.
 * - maxRegistrationBodyBytes: request body limit in UTF-8 bytes.
 */
import { shared } from '../../shared';

export const dynamicClientRegistrationConfig = shared('dynamicClientRegistrationConfig', () => ({
  initialAccessToken: undefined as string | undefined,
  maxRegisteredClients: 100,
  maxRegistrationBodyBytes: 16384,
}));
