/**
 * Client authentication with private_key_jwt (OIDC Core 1.0 §9 / RFC 7523 §3),
 * shared by every endpoint that authenticates clients: /token, /introspect,
 * /revoke, and the PAR, device authorization and CIBA endpoints when they are
 * generated.
 *
 * The client signs a JWT with its own private key and sends it as
 * client_assertion. verifyPrivateKeyJwt() checks it against the public keys
 * the client registered for the private_key_jwt purpose (the ClientKeyResolver
 * of the app: the client_jwks table or records with --db, read for each
 * request), then records its jti so the same assertion is refused the second
 * time.
 */
import {
  rejectReplayedClientAssertion,
  requireClientAssertion,
  verifyClientAssertion,
  type PresentedClientCredentials,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import { clientKeyResolver as defaultClientKeyResolver } from './resolvers.js';
import { clientAssertionJtiStore as defaultClientAssertionJtiStore } from './store.js';

/**
 * Verify the client assertion of a request that authenticates with
 * private_key_jwt. endpointPath is the path of the endpoint that received it
 * (for example '/token'): its URL is one of the audiences the assertion may
 * name.
 */
export async function verifyPrivateKeyJwt(
  c: any,
  client: TokenClientInfo,
  presented: Pick<PresentedClientCredentials, 'clientAssertion'>,
  endpointPath: string,
): Promise<void> {
  const { issuer } = c.get('config');
  const clientKeyResolver = c.get('clientKeyResolver') ?? defaultClientKeyResolver;
  // Storage without a clientAssertionJtiStore keeps the jtis in memory.
  const jtiStore = c.get('clientAssertionJtiStore') ?? defaultClientAssertionJtiStore;

  // OIDC Core 1.0 §9 / RFC 7523 §3: a signature by one of the keys the client
  // registered for private_key_jwt, iss and sub the client_id, aud this OP,
  // exp / nbf / iat, and a jti.
  const verified = await verifyClientAssertion(requireClientAssertion(presented.clientAssertion), {
    clientId: client.clientId,
    jwks: await clientKeyResolver.findClientKeys(client.clientId, 'private_key_jwt'),
    audiences: clientAssertionAudiences(issuer, endpointPath),
  });

  // OIDC Core 1.0 §9: a client assertion MUST only be used once.
  await rejectReplayedClientAssertion(jtiStore, {
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
