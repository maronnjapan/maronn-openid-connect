import { WebRouter } from '../../../../web-router.js';
import { authenticateCibaClient } from './steps/authenticate-client.js';
import { createBackchannelAuthenticationRequest } from './steps/create-request.js';
import { parseBackchannelAuthenticationRequest } from './steps/parse-request.js';
import { respondBackchannelAuthenticationError } from './steps/respond-error.js';
import { respondBackchannelAuthentication } from './steps/respond.js';
import { validateCibaClientScope } from './steps/validate-client-scope.js';

/**
 * EXPERIMENTAL — OpenID Connect Client-Initiated Backchannel Authentication
 * (CIBA Core 1.0), poll mode.
 *
 * This endpoint was generated because the OP was created with `--enable ciba`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The consumption device (a call-center console, a kiosk, a smart speaker
 * backend) POSTs here — back channel, client-authenticated — with a login_hint
 * naming the user, and receives an auth_req_id it polls the token endpoint
 * with. The user approves or denies on their own browser at /ciba. Each block
 * below calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint backchannel-authentication`).
 *
 * NOTE (CIBA §15): the login_hint is a user identifier and therefore PII.
 * Never log it, and never echo it in an error_description. Rate limiting the
 * endpoint as a whole is deliberately left to the deployment layer (reverse
 * proxy / platform): an in-process counter cannot work on runtimes without
 * shared memory between instances. The in-band defenses are mandatory client
 * authentication, the fixed unknown_user_id wording, and the per-subject
 * pending-request cap (cibaConfig in config.ts).
 */
export const backchannelAuthenticationApp = new WebRouter();

backchannelAuthenticationApp.post('/', async (c) => {
  try {
    // [parse-request] Parse the backchannel authentication request — CIBA Core 1.0 §7.1
    const { params, authorization } = await parseBackchannelAuthenticationRequest(c);

    // [authenticate-client] Authenticate the client — CIBA Core 1.0 §7.1
    const client = await authenticateCibaClient(c, params, authorization);

    // [validate-client-scope] Check the requested scope against the registration — RFC 7591 §2 / RFC 6749 §3.3
    validateCibaClientScope(params, client);

    // [create-request] Resolve the login_hint and create the pending request — CIBA Core 1.0 §7.1 - §7.3
    const cibaResponse = await createBackchannelAuthenticationRequest(c, params, client);

    // [respond] Respond with auth_req_id (no-store) — CIBA Core 1.0 §7.3
    return respondBackchannelAuthentication(c, cibaResponse);
  } catch (error) {
    return respondBackchannelAuthenticationError(c, error);
  }
});
