import { Hono } from 'hono';
import { authenticatePushingClient } from './steps/authenticate-client.js';
import { parsePushedAuthorizationRequest } from './steps/parse-request.js';
import { respondParError } from './steps/respond-error.js';
import { respondPar } from './steps/respond.js';
import { storePushedRequest } from './steps/store-request.js';
import { validatePushedRequest } from './steps/validate-request.js';

/**
 * EXPERIMENTAL — Pushed Authorization Requests (RFC 9126).
 *
 * This endpoint was generated because the OP was created with `--enable par`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The client POSTs the authorization request parameters here (back channel,
 * authenticated) and receives a short-lived `request_uri` reference that it
 * then passes to /authorize. Each block below calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint par`).
 *
 * NOTE (RFC 9126 §2.3): request size limits (413) and rate limiting (429) are
 * deliberately left to the deployment layer (reverse proxy / platform), not
 * implemented here. This endpoint is unauthenticated until the client
 * credentials are checked, so put a rate limit in front of it in production.
 */
export const parApp = new Hono<{ Variables: Record<string, any> }>();

parApp.post('/', async (c) => {
  try {
    // [parse-request] Parse the pushed authorization request — RFC 9126 §2.1 / RFC 6749 §3.1
    const { params, authorization } = await parsePushedAuthorizationRequest(c);

    // [authenticate-client] Authenticate the pushing client — RFC 9126 §2.1
    const { clientId, pushedParams } = await authenticatePushingClient(c, params, authorization);

    // [validate-request] Validate the request as /authorize would — RFC 9126 §2.1
    await validatePushedRequest(c, pushedParams);

    // [store-request] Store the request under a fresh request_uri — RFC 9126 §2.2 / §7.1
    const parResponse = await storePushedRequest(c, clientId, pushedParams);

    // [respond] Respond 201 (no-store) — RFC 9126 §2.2
    return respondPar(c, parResponse);
  } catch (error) {
    return respondParError(c, error);
  }
});
