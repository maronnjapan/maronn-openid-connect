import {
  type IntrospectionResponse,
  selectSigningKeyByAlg,
  type SigningKey,
} from '@maronn-openid-connect/core';
import {
  TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,
  acceptsIntrospectionJwt,
  createIntrospectionResponseJwt,
  restrictIntrospectionResponseToCaller,
} from '@maronn-openid-connect/experimental/jwt-introspection-response';
import { respondIntrospection } from '../../introspection/endpoints/introspection/steps/respond.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'sign-response',
  endpoint: 'introspection',
  feature: 'jwt-introspection-response',
  kind: 'dispatch',
  label: 'Answer as a signed JWT when asked for one',
  spec: 'RFC 9701 §4 / §5',
  function: 'signIntrospectionResponse',
  calls: ['acceptsIntrospectionJwt', 'restrictIntrospectionResponseToCaller', 'selectSigningKeyByAlg', 'createIntrospectionResponseJwt'],
  consumes: ['introspection', 'authenticatedClientId'],
  produces: [],
  removable: false,
  after: ['build-response'],
});

/**
 * EXPERIMENTAL — RFC 9701 §4 / §5: a caller whose Accept header names
 * application/token-introspection+jwt receives the introspection response as
 * a signed JWT. Any other request (no Accept, application/json, a wildcard)
 * returns undefined and is answered as before. The step sits AFTER client
 * authentication and token resolution so the Accept header can never bypass
 * either (§8.2 downgrade prevention).
 */
export async function signIntrospectionResponse(
  c: any,
  introspection: IntrospectionResponse,
  authenticatedClientId: string,
): Promise<Response | undefined> {
  if (!acceptsIntrospectionJwt(c.req.header('Accept'))) return undefined;

  // RFC 9701 §3 / §5: before the response leaves as a signed assertion its
  // members are restricted to what the authenticated caller may see — a
  // caller that is neither the client the token was issued to nor listed in
  // its aud gets { active: false }, indistinguishable from an unknown token.
  const restrictedResponse = restrictIntrospectionResponseToCaller(
    introspection,
    authenticatedClientId,
  );
  // RFC 9701 §6: alg is pinned to RS256 (the default for a client that
  // registered no introspection_signed_response_alg). The first key of the
  // general-purpose set is not guaranteed to be RS256 — a SigningKeyProvider
  // may legitimately put an ES256 key first in an RS256 + ES256 set — so the
  // key is picked by alg from the set. Its public half is published at
  // /.well-known/jwks.json under the same kid. selectSigningKeyByAlg throws
  // when no RS256 key is registered, which surfaces as a server_error
  // (a configuration mistake) rather than as an unverifiable introspection
  // response.
  const introspectionSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
  const introspectionSigningKey = selectSigningKeyByAlg(introspectionSigningKeys, 'RS256');
  const responseJwt = await createIntrospectionResponseJwt({
    issuer: c.get('config').issuer,
    audience: authenticatedClientId,
    introspection: restrictedResponse,
    signingKey: introspectionSigningKey,
  });
  // RFC 9701 §5: the success response is the compact JWS itself under its
  // own media type.
  return respondIntrospection(c, {
    status: 200,
    text: responseJwt,
    headers: { 'Content-Type': TOKEN_INTROSPECTION_JWT_MEDIA_TYPE },
  });
}
