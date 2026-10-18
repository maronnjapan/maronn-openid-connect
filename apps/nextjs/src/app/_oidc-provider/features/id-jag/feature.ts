import { JWT_BEARER_GRANT_TYPE, TOKEN_EXCHANGE_GRANT_TYPE } from '@maronn-openid-connect/experimental/id-jag';
import { defineFeature } from '../../feature';

/**
 * Identity Assertion Authorization Grant / Cross-App Access (ID-JAG): the
 * (feature: id-jag) blocks of the token endpoint issue an ID-JAG on token
 * exchange and redeem one on the jwt-bearer grant (grant.ts).
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
