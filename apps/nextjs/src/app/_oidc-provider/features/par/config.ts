/**
 * EXPERIMENTAL — Pushed Authorization Requests settings (RFC 9126).
 *
 * Read by the PAR endpoint (par/route.ts), the authorization endpoint and
 * discovery, so it lives in its own module.
 *
 * - expiresInSeconds: request_uri lifetime. RFC 9126 §2.2 recommends 5–600
 *   seconds; values outside that range fail fast at module load.
 * - requirePushedAuthorizationRequests: RFC 9126 §5. When true, /authorize
 *   rejects any request that did not go through /par, and discovery
 *   advertises require_pushed_authorization_requests: true.
 */
import { assertParExpiresInSeconds } from '@maronn-openid-connect/experimental/par';
import { shared } from '../../shared';

export const parConfig = shared('parConfig', () => ({
  expiresInSeconds: 60,
  requirePushedAuthorizationRequests: false,
}));

assertParExpiresInSeconds(parConfig.expiresInSeconds);
