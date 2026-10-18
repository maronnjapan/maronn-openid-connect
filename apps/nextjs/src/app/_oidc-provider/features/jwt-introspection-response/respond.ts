import { selectSigningKeyByAlg, type IntrospectionResponse } from '@maronn-openid-connect/core';
import {
  TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,
  acceptsIntrospectionJwt,
  createIntrospectionResponseJwt,
  restrictIntrospectionResponseToCaller,
} from '@maronn-openid-connect/experimental/jwt-introspection-response';
import { config, type ProviderSigningKeys } from '../../provider';

/**
 * RFC 9701 §4 / §5: a caller whose Accept header names
 * application/token-introspection+jwt receives the introspection response as a
 * signed JWT; undefined for any other request (no Accept, application/json, a
 * wildcard), which is answered as JSON. The introspection endpoint calls it
 * AFTER client authentication and token resolution, so the Accept header can
 * never bypass either (§8.2 downgrade prevention).
 */
export async function respondIntrospectionJwt(
  request: Request,
  response: IntrospectionResponse,
  authenticatedClientId: string,
  keys: ProviderSigningKeys,
): Promise<Response | undefined> {
  if (!acceptsIntrospectionJwt(request.headers.get('Accept') ?? undefined)) return undefined;
  // RFC 9701 §3 / §5: before the response leaves as a signed assertion its
  // members are restricted to what the authenticated caller may see: a caller
  // that is neither the client the token was issued to nor in its aud gets
  // { active: false }, indistinguishable from an unknown token.
  const restrictedResponse = restrictIntrospectionResponseToCaller(response, authenticatedClientId);
  // RFC 9701 §6: alg is pinned to RS256 (the default for a client that
  // registered no introspection_signed_response_alg). The first key of the set
  // is not guaranteed to be RS256, so the key is picked by alg from the set;
  // its public half is published at /.well-known/jwks.json under the same kid.
  // No RS256 key surfaces as a server_error (a configuration mistake) rather
  // than as an unverifiable response.
  const responseJwt = await createIntrospectionResponseJwt({
    issuer: config.issuer,
    audience: authenticatedClientId,
    introspection: restrictedResponse,
    signingKey: selectSigningKeyByAlg(keys.general, 'RS256'),
  });
  // RFC 9701 §5: the success response is the compact JWS itself, under its
  // own media type.
  return new Response(responseJwt, {
    headers: {
      'Content-Type': TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}
