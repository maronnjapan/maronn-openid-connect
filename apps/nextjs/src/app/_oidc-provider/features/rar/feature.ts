import { defineFeature } from '../../feature';
import { resolveRarTypes } from './config';
import { describeTransactionAuthorizationDetails } from './consent';

/**
 * EXPERIMENTAL — Rich Authorization Requests (RFC 9396): the
 * authorization_details parameter of the authorization endpoint, its rows on
 * the consent screen, and the approved details on the token response and
 * introspection. Settings are in config.ts; the accepted types are injected
 * through ProviderConfig.rarTypes.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it
 * may change in a breaking way between releases.
 */
export const rar = defineFeature({
  id: 'rar',
  // RFC 9396 §10 metadata. Only advertised while type definitions are
  // registered: a client must not send RAR to an OP that does not advertise
  // the member, and this OP rejects every request while the list is empty.
  discovery: (_issuer, config) => {
    const rarTypes = resolveRarTypes(config);
    return rarTypes !== undefined && rarTypes.length > 0
      ? { authorization_details_types_supported: rarTypes.map((definition) => definition.type) }
      : {};
  },
  consent: {
    describeTransaction: (transactionId, config) =>
      describeTransactionAuthorizationDetails(transactionId, resolveRarTypes(config)),
  },
});
