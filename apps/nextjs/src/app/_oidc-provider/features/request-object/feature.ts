import { DEFAULT_REQUEST_URI_OPTIONS, SUPPORTED_REQUEST_OBJECT_SIGNING_ALGS } from '@maronn-openid-connect/core';
import { defineFeature } from '../../feature';
import './config';

/**
 * Signed Request Objects passed by value (OIDC Core 1.0 §6.1) and by reference
 * (request_uri, §6.2). The authorization endpoint calls them in its
 * (feature: request-object) blocks: fetch-request-uri puts the Request Object
 * of a request_uri that is a URL into request, and resolve-request-object
 * verifies it. A client that registered request_object_signing_alg has its
 * Request Objects signed with that alg only (OIDC Core 1.0 §6.3.2).
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
    // The algs core verifies (RFC 7518 §3.3 / §3.4), so a client may register
    // any of them as request_object_signing_alg.
    requestObjectSigningAlgValuesSupported: [...SUPPORTED_REQUEST_OBJECT_SIGNING_ALGS],
    // OIDC Core 1.0 §6.2: request_uri is fetched, from https URLs of public
    // hosts only, without requiring registered request_uris.
    // OIDC_ALLOW_INSECURE_REQUEST_URI=1 lets a request_uri use http and
    // loopback or private addresses (development only), and
    // OIDC_REQUIRE_REQUEST_URI_REGISTRATION=1 fetches only the request_uris a
    // client registered (OIDC Discovery 1.0 §3).
    requestUriParameterSupported: true,
    requireRequestUriRegistration: process.env.OIDC_REQUIRE_REQUEST_URI_REGISTRATION === '1',
    allowInsecureRequestUri: process.env.OIDC_ALLOW_INSECURE_REQUEST_URI === '1',
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
