import { defineFeature } from '../../feature';
import './config';

/**
 * Request Objects passed by value (the request parameter, OIDC Core 1.0 §6.1)
 * and by reference (the request_uri parameter, §6.2). The authorization
 * endpoint calls the feature in its (feature: request-object) block, which
 * verifies the Request Object against the keys the client registered for
 * request_object and overlays its claims; a request_uri is first matched
 * against the request_uris the client registered (config
 * requireRequestUriRegistration) and fetched with a GET.
 */
export const requestObject = defineFeature({
  id: 'request-object',
  config: {
    // OIDC Core 1.0 §6.1 / RFC 9101: accepting unsigned (alg:none) Request Objects
    // is a security relaxation used only for OIDF Basic OP conformance, where the
    // request object modules are skipped unless the OP advertises 'none' in
    // request_object_signing_alg_values_supported. Default off (signed-only):
    // set OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT=1 only for conformance runs.
    allowUnsignedRequestObject: process.env.OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT === '1',
    // OIDC Core 1.0 §6.2: fetch only the request_uri values a client registered,
    // so an authorization request cannot point the OP at an arbitrary URL. Set
    // OIDC_REQUIRE_REQUEST_URI_REGISTRATION=0 to fetch any https request_uri.
    requireRequestUriRegistration: process.env.OIDC_REQUIRE_REQUEST_URI_REGISTRATION !== '0',
  },
  // OIDC Core 1.0 §6.1 / §6.2 / OIDC Discovery 1.0 §3: Request Objects by value
  // and by reference are supported (verified against the client's registered
  // JWKS). RS256 is the required signing alg; 'none' is added only when
  // unsigned objects are accepted for Basic OP conformance compatibility.
  // require_request_uri_registration tells clients whether request_uri values
  // have to be pre-registered with request_uris.
  discovery: (_issuer, config) => ({
    request_parameter_supported: true,
    request_uri_parameter_supported: true,
    require_request_uri_registration: config.requireRequestUriRegistration,
    request_object_signing_alg_values_supported: config.allowUnsignedRequestObject
      ? ['RS256', 'none']
      : ['RS256'],
  }),
});
