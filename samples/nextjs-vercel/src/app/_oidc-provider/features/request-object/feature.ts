import { defineFeature } from '../../feature';
import './config';

/**
 * Signed Request Objects passed by value (OIDC Core 1.0 §6.1). The
 * authorization endpoint calls it in its (feature: request-object) block.
 */
export const requestObject = defineFeature({
  id: 'request-object',
  // OIDC Core 1.0 §6.1 / RFC 9101: accepting unsigned (alg:none) Request Objects
  // is a security relaxation used only for OIDF Basic OP conformance, where the
  // request object modules are skipped unless the OP advertises 'none' in
  // request_object_signing_alg_values_supported. Default off (signed-only):
  // set OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT=1 only for conformance runs.
  config: { allowUnsignedRequestObject: process.env.OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT === '1' },
  // OIDC Core 1.0 §6.1 / OIDC Discovery 1.0 §3: signed Request Object by value is
  // supported (verified against the client's registered JWKS). RS256 is the
  // required signing alg; 'none' is added only when unsigned objects are
  // accepted for Basic OP conformance compatibility.
  discovery: (_issuer, config) => ({
    request_parameter_supported: true,
    request_object_signing_alg_values_supported: config.allowUnsignedRequestObject
      ? ['RS256', 'none']
      : ['RS256'],
  }),
});
