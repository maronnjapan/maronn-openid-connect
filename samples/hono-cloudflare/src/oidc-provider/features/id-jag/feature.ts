import { JWT_BEARER_GRANT_TYPE, TOKEN_EXCHANGE_GRANT_TYPE } from '@maronn-openid-connect/experimental/id-jag';
import { defineFeature } from '../feature.js';

/**
 * EXPERIMENTAL — Cross-App Access / Identity Assertion Authorization Grant
 * (draft-ietf-oauth-identity-assertion-authz-grant-04): the token endpoint
 * issues ID-JAGs on the token-exchange grant (requested_token_type id-jag)
 * and redeems the ID-JAGs of trusted identity providers on the jwt-bearer
 * grant, in the dispatch-id-jag-* blocks of endpoints/token/pipeline.ts.
 * Both trust lists are empty by default (config.ts), so nothing is issued
 * or accepted until you configure them.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it
 * may change in a breaking way between releases. The underlying
 * specification is an IETF draft and may itself change.
 */
export const idJag = defineFeature({
  id: 'id-jag',
  token: { grants: [TOKEN_EXCHANGE_GRANT_TYPE, JWT_BEARER_GRANT_TYPE] },
  discovery: () => ({
    // ID-JAG draft §7.1: this OP can issue an ID-JAG via token exchange
    // (identity-chaining requested token type).
    identity_chaining_requested_token_types_supported: ['urn:ietf:params:oauth:token-type:id-jag'],
    // ID-JAG draft §7.2: this OP can process the ID-JAG grant profile on the
    // jwt-bearer grant. Which issuers are actually trusted is local policy and
    // is not disclosed here (draft §9.4).
    authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],
  }),
});
