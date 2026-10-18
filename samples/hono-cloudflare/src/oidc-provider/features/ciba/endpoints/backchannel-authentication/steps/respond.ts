import { noStore } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'backchannel-authentication',
  feature: 'ciba',
  kind: 'respond',
  label: 'Respond with auth_req_id (no-store)',
  spec: 'CIBA Core 1.0 §7.3',
  function: 'respondBackchannelAuthentication',
  consumes: ['cibaResponse'],
  produces: [],
  removable: false,
});

/**
 * CIBA Core 1.0 §7.3: the authentication request acknowledgement. auth_req_id
 * is a credential, so the response follows the token response rules of
 * RFC 6749 §5.1 (no-store).
 */
export function respondBackchannelAuthentication(c: any, response: object): Response {
  noStore(c);
  return c.json(response);
}
