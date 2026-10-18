import { JARM_SUPPORTED_RESPONSE_MODES } from '@maronn-openid-connect/experimental/jarm';
import { defineFeature } from '../../feature';
import { jarmResponseModeHandler } from './response-mode';

/**
 * JWT Secured Authorization Response Mode (JARM): the authorization endpoint
 * resolves response_mode=query.jwt in its (feature: jarm) block, and /consent
 * answers in that mode through the response mode handler.
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
