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
 * With the dpop extension, the (feature: dpop) block after client
 * authentication rejects a pushed dpop_jkt that is not a JWK Thumbprint (400
 * invalid_request, with or without a DPoP header), checks the DPoP proof of a
 * request that has a DPoP header and pushes the request with its key as
 * dpop_jkt, so the code issued for the request_uri is bound to that key
 * (RFC 9449 §10.1). Without the block the pushed parameters are validated and
 * stored as they came. With dpopNonceRequiredAtAuthorizationServer, the
 * (feature: dpop) block before client authentication gives every response to
 * a request with a DPoP header a new nonce of the authorization server
 * (DPoP-Nonce) and rejects a proof without a nonce it recently provided
 * (400 use_dpop_nonce).
 *
 * NOTE (RFC 9126 §2.3): request size limits (413) and rate limiting (429) are
 * deliberately left to the deployment layer (reverse proxy / platform), not
 * implemented here. This endpoint is unauthenticated until the client
 * credentials are checked, so put a rate limit in front of it in production.
 */
export const parApp = new Hono<{ Variables: Record<string, any> }>();

parApp.post('/', async (c) => {
  try {
    // [parse-request] プッシュされた認可リクエストを解析する — RFC 9126 §2.1 / RFC 6749 §3.1
    const { params, authorization } = await parsePushedAuthorizationRequest(c);

    // [authenticate-client] プッシュしたクライアントを認証する — RFC 9126 §2.1
    const { clientId, pushedParams } = await authenticatePushingClient(c, params, authorization);

    const dpopBoundParams = undefined;

    // [validate-request] /authorize と同じ規則でリクエストを検証する — RFC 9126 §2.1
    await validatePushedRequest(c, dpopBoundParams ?? pushedParams);

    // [store-request] 新しい request_uri でリクエストを保存する — RFC 9126 §2.2 / §7.1
    const parResponse = await storePushedRequest(c, clientId, dpopBoundParams ?? pushedParams);

    // [respond] 201 で応答する（no-store） — RFC 9126 §2.2
    return respondPar(c, parResponse);
  } catch (error) {
    return respondParError(c, error);
  }
});
