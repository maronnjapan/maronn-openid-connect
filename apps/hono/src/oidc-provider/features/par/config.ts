import { assertParExpiresInSeconds } from '@maronn-openid-connect/experimental/par';

/**
 * PAR settings, read by the par endpoint and the resolve-pushed-request step
 * of the authorization endpoint.
 *
 * - expiresInSeconds: request_uri lifetime. RFC 9126 §2.2 recommends 5–600
 *   seconds; values outside that range fail fast at module load.
 * - requirePushedAuthorizationRequests: RFC 9126 §5. When true, /authorize
 *   rejects any request that did not go through this endpoint, and discovery
 *   advertises require_pushed_authorization_requests: true.
 */
export const parConfig = {
  expiresInSeconds: 60,
  requirePushedAuthorizationRequests: false,
};

assertParExpiresInSeconds(parConfig.expiresInSeconds);
