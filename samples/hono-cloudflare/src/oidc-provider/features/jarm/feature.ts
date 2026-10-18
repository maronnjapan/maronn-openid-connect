import { JARM_SUPPORTED_RESPONSE_MODES } from '@maronn-openid-connect/experimental/jarm';
import { defineFeature } from '../feature.js';
import { jarmResponseModeHandler } from './response-mode.js';

/**
 * EXPERIMENTAL — JWT Secured Authorization Response Mode (JARM, OpenID
 * Foundation Final 2022-11-09): response_mode=query.jwt (and its `jwt`
 * shorthand) returns the authorization response as one signed JWT. The
 * resolve-jarm-response-mode block of endpoints/authorize/pipeline.ts reads
 * the request, and /consent answers in the same mode through
 * authorize.responseModes. A request that does not ask for a JWT response
 * mode is answered exactly as before. Settings are in config.ts.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it
 * may change in a breaking way between releases.
 */
export const jarm = defineFeature({
  id: 'jarm',
  authorize: { responseModes: [jarmResponseModeHandler] },
  discovery: () => ({
    // JARM §4: the JWT-secured query modes are advertised alongside query.
    response_modes_supported: [...JARM_SUPPORTED_RESPONSE_MODES],
    // JARM §4 metadata. The response JWT is always signed with RS256 (JARM §3:
    // the default for a client that registered no
    // authorization_signed_response_alg), so exactly one alg is advertised.
    authorization_signing_alg_values_supported: ['RS256'],
  }),
});
