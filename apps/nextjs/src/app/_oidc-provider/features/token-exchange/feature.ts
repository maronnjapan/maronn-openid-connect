import { TOKEN_EXCHANGE_GRANT_TYPE } from '@maronn-openid-connect/experimental/token-exchange';
import { defineFeature } from '../../feature';

/**
 * OAuth 2.0 Token Exchange (RFC 8693), answered by the (feature:
 * token-exchange) block of the token endpoint (grant.ts).
 */
export const tokenExchange = defineFeature({
  id: 'token-exchange',
  token: { grants: [TOKEN_EXCHANGE_GRANT_TYPE] },
});
