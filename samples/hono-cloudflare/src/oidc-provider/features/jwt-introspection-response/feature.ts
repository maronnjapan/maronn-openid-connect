import { defineFeature } from '../feature.js';

/**
 * EXPERIMENTAL — JWT Response for OAuth Token Introspection (RFC 9701): the
 * introspection endpoint answers a request whose Accept header names
 * application/token-introspection+jwt with a signed JWT, in the
 * sign-response block of the introspection pipeline. It needs the
 * introspection feature, whose endpoint carries the response. A request
 * that does not name that media type is answered exactly as before.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it
 * may change in a breaking way between releases.
 */
export const jwtIntrospectionResponse = defineFeature({
  id: 'jwt-introspection-response',
  // RFC 9701 §7 metadata. The introspection response JWT is always signed with
  // RS256 (§6: the default for a client that registered no
  // introspection_signed_response_alg), so exactly one alg is advertised.
  discovery: () => ({ introspection_signing_alg_values_supported: ['RS256'] }),
});
