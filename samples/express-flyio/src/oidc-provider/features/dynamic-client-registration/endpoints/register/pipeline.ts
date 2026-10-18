import { WebRouter } from '../../../../web-router.js';
import { parseRegistrationRequest } from './steps/parse-request.js';
import { respondRegistrationError } from './steps/respond-error.js';
import { respondRegistration } from './steps/respond.js';
import { storeRegisteredClient } from './steps/store-client.js';
import { validateRegistrationMetadata } from './steps/validate-metadata.js';
import { verifyRegistrationAccess } from './steps/verify-initial-access-token.js';

/**
 * EXPERIMENTAL — Dynamic Client Registration (RFC 7591).
 *
 * This endpoint was generated because the OP was created with
 * `--enable dynamic-client-registration`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The client POSTs its metadata here as JSON and receives a freshly minted
 * client_id (and, for confidential clients, a client_secret) that works on
 * /authorize and /token right away. Registration is open by default
 * (RFC 7591 §3.1 SHOULD); set initialAccessToken to require a Bearer token.
 * Each block below calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint register`).
 *
 * NOTE (RFC 7591 §5): per-IP rate limiting is deliberately left to the
 * deployment layer (reverse proxy / platform); this endpoint only enforces the
 * inventory and body-size caps of config.ts. Open registration grants no trust:
 * what an issued client can do stays bounded by the same validation as a static
 * client (PKCE, exact redirect_uri match, client authentication).
 */
export const registerApp = new WebRouter();

registerApp.post('/', async (c) => {
  try {
    // [verify-initial-access-token] Check the initial access token, if one is required — OIDC Dynamic Client Registration 1.0 §3 / RFC 6750 §3.1
    await verifyRegistrationAccess(c);

    // [parse-request] Read the JSON metadata — RFC 7591 §3.1
    const rawBody = await parseRegistrationRequest(c);

    // [validate-metadata] Validate the metadata and build the client — RFC 7591 §2 / §3.1
    const client = validateRegistrationMetadata(c, rawBody);

    // [store-client] Enforce the inventory cap and store the client — RFC 7591 §5
    await storeRegisteredClient(c, client);

    // [respond] Respond 201 with the registration response — RFC 7591 §3.2.1
    return respondRegistration(c, client);
  } catch (error) {
    return respondRegistrationError(c, error);
  }
});
