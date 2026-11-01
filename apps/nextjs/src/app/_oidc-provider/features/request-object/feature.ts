import { SUPPORTED_REQUEST_OBJECT_SIGNING_ALGS } from '@maronn-openid-connect/core';
import { defineFeature } from '../../feature';
import './config';

/**
 * Signed Request Objects passed by value (OIDC Core 1.0 §6.1). The
 * authorization endpoint calls it in its (feature: request-object) block. A
 * client that registered request_object_signing_alg has its Request Objects
 * signed with that alg only (OIDC Core 1.0 §6.3.2).
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
  }),
});
