import { TOKEN_EXCHANGE_GRANT_TYPE } from '@maronn-openid-connect/experimental/token-exchange';
import { defineFeature } from '../feature.js';

/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange (RFC 8693): the token endpoint
 * answers the urn:ietf:params:oauth:grant-type:token-exchange grant in the
 * dispatch-token-exchange block of endpoints/token/pipeline.ts, before the
 * grant_type validation would reject the URN. Settings are in config.ts.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it
 * may change in a breaking way between releases.
 */
export const tokenExchange = defineFeature({
  id: 'token-exchange',
  token: { grants: [TOKEN_EXCHANGE_GRANT_TYPE] },
});
