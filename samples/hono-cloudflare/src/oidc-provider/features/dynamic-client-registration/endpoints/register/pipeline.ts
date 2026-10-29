import { Hono } from 'hono';
import { parseRegistrationRequest } from './steps/parse-request.js';
import { respondRegistrationError } from './steps/respond-error.js';
import { respondRegistration } from './steps/respond.js';
import { storeRegisteredClient } from './steps/store-client.js';
import { validateRegistrationMetadata } from './steps/validate-metadata.js';
import { verifyRegistrationAccess } from './steps/verify-initial-access-token.js';
import { resolveRegistrationMetadata } from './steps/verify-software-statement.js';

/**
 * EXPERIMENTAL — Dynamic Client Registration (RFC 7591).
 *
 * This endpoint was generated because the OP was created with
 * `--enable dynamic-client-registration`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The client POSTs its metadata here as JSON — optionally bundled in a signed
 * software statement of a publisher this OP trusts — and receives a freshly
 * minted client_id (and, for confidential clients, a client_secret) that works
 * on /authorize and /token right away. Registration is open by default
 * (RFC 7591 §3.1 SHOULD) and a software_statement is ignored (§3.1.1); set
 * verifyInitialAccessToken / verifySoftwareStatement of ../../config.ts to
 * require them and verify them with functions of your own — this code
 * verifies neither. Metadata beyond the standard fields is accepted through
 * customClientMetadata of the same config.
 * Each block below calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint register`).
 *
 * NOTE (RFC 7591 §5): per-IP rate limiting is deliberately left to the
 * deployment layer (reverse proxy / platform); this endpoint only enforces the
 * inventory and body-size caps of config.ts. Open registration grants no trust:
 * what an issued client can do stays bounded by the same validation as a static
 * client (PKCE, exact redirect_uri match, client authentication).
 */
export const registerApp = new Hono<{ Variables: Record<string, any> }>();

registerApp.post('/', async (c) => {
  try {
    // [verify-initial-access-token] Check that the request may register — OIDC Dynamic Client Registration 1.0 §3 / RFC 6750 §3.1
    await verifyRegistrationAccess(c);

    // [parse-request] Read the JSON metadata — RFC 7591 §3.1
    const registration = await parseRegistrationRequest(c);

    // [verify-software-statement] Verify the software statement and apply the metadata it asserts — RFC 7591 §2.3 / §3.1.1
    const metadata = await resolveRegistrationMetadata(c, registration);

    // [validate-metadata] Validate the metadata and build the client — RFC 7591 §2 / §2.1
    const client = validateRegistrationMetadata(c, metadata);

    // [store-client] Enforce the inventory cap and store the client — RFC 7591 §5
    await storeRegisteredClient(c, client);

    // [respond] Respond 201 with the registration response — RFC 7591 §3.2.1
    return respondRegistration(c, client);
  } catch (error) {
    return respondRegistrationError(c, error);
  }
});
