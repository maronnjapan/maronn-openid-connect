import { DEFAULT_REQUEST_URI_OPTIONS, SUPPORTED_REQUEST_OBJECT_SIGNING_ALGS } from '@maronn-openid-connect/core';
import { defineFeature } from '../feature.js';
import './config.js';

/**
 * Request Objects passed by value, the request parameter of the
 * authorization request (OIDC Core 1.0 §6.1 / §6.3.2), and by reference, the
 * request_uri parameter (§6.2). The fetch-request-uri block of
 * endpoints/authorize/pipeline.ts fetches the Request Object of a request_uri
 * that is a URL and puts it into request; the resolve-request-object block
 * then verifies it against the keys the client registered for request_object
 * (or publishes at its jwks_uri) and overlays its claims. A client that
 * registered request_object_signing_alg has its Request Objects signed with
 * that alg only. Without the feature the request parameter is rejected with
 * request_not_supported and request_uri with request_uri_not_supported.
 */
export const requestObject = defineFeature({
  id: 'request-object',
  config: {
    // OIDC Core 1.0 §6.1: require signed Request Objects by default; enable only for
    // Basic OP conformance compatibility where the suite sends unsigned ones.
    allowUnsignedRequestObject: false,
    // The algs core verifies (RFC 7518 §3.3 / §3.4), so a client may register
    // any of them as request_object_signing_alg.
    requestObjectSigningAlgValuesSupported: [...SUPPORTED_REQUEST_OBJECT_SIGNING_ALGS],
    // OIDC Core 1.0 §6.2: request_uri is fetched, from https URLs of public
    // hosts only, without requiring registered request_uris.
    requestUriParameterSupported: true,
    requireRequestUriRegistration: false,
    allowInsecureRequestUri: false,
    requestUriTimeoutMs: DEFAULT_REQUEST_URI_OPTIONS.timeoutMs,
    requestUriMaxBytes: DEFAULT_REQUEST_URI_OPTIONS.maxBytes,
    requestUriMaxLength: DEFAULT_REQUEST_URI_OPTIONS.maxLength,
  },
  // OIDC Core 1.0 §6.1 / OIDC Discovery 1.0 §3: signed Request Object by value is
  // supported (verified against the client's registered JWKS). 'none' is added
  // only when unsigned objects are accepted for Basic OP conformance compatibility.
  discovery: (_issuer, config) => ({
    request_parameter_supported: true,
    request_object_signing_alg_values_supported: [
      ...config.requestObjectSigningAlgValuesSupported,
      ...(config.allowUnsignedRequestObject ? ['none'] : []),
    ],
    // OIDC Discovery 1.0 §3: the base metadata advertises false for an OP
    // without the feature; this replaces it.
    request_uri_parameter_supported: config.requestUriParameterSupported,
    require_request_uri_registration: config.requireRequestUriRegistration,
  }),
});
