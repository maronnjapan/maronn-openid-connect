import { defineFeature } from '../feature.js';
import './config.js';

/**
 * Request Objects passed by value (the request parameter, OIDC Core 1.0 §6.1)
 * and by reference (the request_uri parameter, §6.2). The
 * resolve-request-object block of endpoints/authorize/pipeline.ts verifies
 * the Request Object against the keys the client registered for
 * request_object and overlays its claims; a request_uri is first matched
 * against the request_uris the client registered (config
 * requireRequestUriRegistration) and fetched with a GET. Without the feature
 * both parameters are rejected with request_not_supported /
 * request_uri_not_supported (§6.3).
 */
export const requestObject = defineFeature({
  id: 'request-object',
  config: {
    // OIDC Core 1.0 §6.1: require signed Request Objects by default; enable only for
    // Basic OP conformance compatibility where the suite sends unsigned ones.
    allowUnsignedRequestObject: false,
    // OIDC Core 1.0 §6.2: fetch only the request_uri values a client registered,
    // so an authorization request cannot point the OP at an arbitrary URL.
    requireRequestUriRegistration: true,
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
  // The fetch a request_uri is retrieved with (OIDC Core 1.0 §6.2.3):
  // globalThis.fetch unless the requestUriFetch option replaces it.
  context: ({ options }) => (options.requestUriFetch === undefined ? {} : { requestUriFetch: options.requestUriFetch }),
});
