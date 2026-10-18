import { WebRouter } from '../../../../web-router.js';
import { authenticateDeviceClient } from './steps/authenticate-client.js';
import { issueDeviceCodes } from './steps/issue-device-code.js';
import { parseDeviceAuthorizationRequest } from './steps/parse-request.js';
import { respondDeviceAuthorizationError } from './steps/respond-error.js';
import { respondDeviceAuthorization } from './steps/respond.js';
import { validateDeviceAuthorizationRequest } from './steps/validate-request.js';

/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * This endpoint was generated because the OP was created with
 * `--enable device-authorization-grant`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The device (a TV app, a CLI, an IoT box) POSTs here — back channel,
 * client-authenticated — and receives a device_code it polls the token endpoint
 * with, plus a short user_code the end user types into /device on another
 * device's browser. Each block below calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint device-authorization`).
 *
 * NOTE (RFC 8628 §5.1): rate limiting the user_code guess surface is deliberately
 * left to the deployment layer (reverse proxy / platform), not implemented here.
 * An in-process counter cannot work on runtimes without shared memory between
 * instances (Cloudflare Workers and friends), so putting one here would give a
 * false sense of protection. The in-band defenses are the 20^8 user_code
 * entropy, the short TTL, and answering every failed match identically.
 */
export const deviceAuthorizationApp = new WebRouter();

deviceAuthorizationApp.post('/', async (c) => {
  try {
    // [parse-request] Parse the device authorization request — RFC 8628 §3.1
    const { params, authorization } = await parseDeviceAuthorizationRequest(c);

    // [authenticate-client] Authenticate the client — RFC 8628 §3.1 / RFC 6749 §3.2.1
    const client = await authenticateDeviceClient(c, params, authorization);

    // [validate-request] Validate the grant registration and the scope — RFC 8628 §3.1 / RFC 7591 §2 / OIDC Core 1.0 §11
    const scope = validateDeviceAuthorizationRequest(params, client);

    // [issue-device-code] Mint the device_code and user_code — RFC 8628 §3.2 / §5.2
    const record = await issueDeviceCodes(c, client, scope);

    // [respond] Respond with the device authorization response (no-store) — RFC 8628 §3.2
    return respondDeviceAuthorization(c, record);
  } catch (error) {
    return respondDeviceAuthorizationError(c, error);
  }
});
