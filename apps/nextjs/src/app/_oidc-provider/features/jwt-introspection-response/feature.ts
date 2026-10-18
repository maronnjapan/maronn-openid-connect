import { defineFeature } from '../../feature';

/**
 * JWT Response for Token Introspection (RFC 9701): the (feature:
 * jwt-introspection-response) block of the introspection endpoint answers a
 * caller that asks for application/token-introspection+jwt with a signed JWT.
 */
export const jwtIntrospectionResponse = defineFeature({
  id: 'jwt-introspection-response',
  // RFC 9701 §7 metadata. The introspection response JWT is always signed with
  // RS256 (§6: the default for a client that registered no
  // introspection_signed_response_alg), so exactly one alg is advertised.
  discovery: () => ({ introspection_signing_alg_values_supported: ['RS256'] }),
});
