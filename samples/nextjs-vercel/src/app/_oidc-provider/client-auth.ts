/**
 * Client authentication with private_key_jwt (OIDC Core 1.0 §9 / RFC 7523 §3),
 * shared by every Route Handler that authenticates clients: /token,
 * /introspect, /revoke, and the PAR, device authorization and CIBA endpoints
 * when they are generated.
 *
 * The client signs a JWT with its own private key and sends it as
 * client_assertion. verifyPrivateKeyJwt() checks it against the public keys
 * the client registered (RegisteredClient.jwks, read from the client_jwks
 * table or record with --db on every request), then records its jti so the
 * same assertion is refused the second time.
 */
import {
  rejectReplayedClientAssertion,
  requireClientAssertion,
  verifyClientAssertion,
  type PresentedClientCredentials,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import { config, stores } from './provider';
import { clientAssertionJtiStore as defaultClientAssertionJtiStore } from './store';

/**
 * Verify the client assertion of a request that authenticates with
 * private_key_jwt. endpointPath is the path of the endpoint that received it
 * (for example '/token'): its URL is one of the audiences the assertion may
 * name.
 */
export async function verifyPrivateKeyJwt(
  client: TokenClientInfo,
  presented: Pick<PresentedClientCredentials, 'clientAssertion'>,
  endpointPath: string,
): Promise<void> {
  // OIDC Core 1.0 §9 / RFC 7523 §3: a signature by one of the client's keys,
  // iss and sub the client_id, aud this OP, exp / nbf / iat, and a jti.
  const verified = await verifyClientAssertion(requireClientAssertion(presented.clientAssertion), {
    clientId: client.clientId,
    jwks: client.jwks,
    audiences: clientAssertionAudiences(config.issuer, endpointPath),
  });

  // OIDC Core 1.0 §9: a client assertion MUST only be used once. Stores
  // without a clientAssertionJtiStore keep the jtis in memory.
  await rejectReplayedClientAssertion(stores.clientAssertionJtiStore ?? defaultClientAssertionJtiStore, {
    clientId: client.clientId,
    jti: verified.jti,
    expiresAt: verified.expiresAt,
  });
}

/**
 * The aud values a client assertion may carry: the issuer identifier, the
 * token endpoint URL and the URL of the endpoint that received the request.
 * Every value of aud has to be one of them.
 *
 * OIDC Core 1.0 §9 says the token endpoint URL SHOULD be the audience.
 * draft-ietf-oauth-rfc7523bis requires the issuer identifier as the only
 * audience and forbids the endpoint URLs (the fix for CVE-2025-27370). Return
 * [issuer] alone to follow the draft strictly; clients written to OIDC Core 1.0
 * that send the token endpoint URL are then refused.
 */
export function clientAssertionAudiences(issuer: string, endpointPath: string): string[] {
  return [...new Set([issuer, issuer + '/token', issuer + endpointPath])];
}
