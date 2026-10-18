import type { TokenClientInfo } from '@maronn-openid-connect/core';
import { processBackchannelAuthenticationRequest, type CibaClientInfo } from '@maronn-openid-connect/experimental/ciba';
import { step } from '../../../../../endpoints/step.js';
import { features } from '../../../../enabled.js';
import { tokenGrantsOf } from '../../../../feature.js';
import { cibaConfig } from '../../../config.js';

export const meta = step({
  id: 'create-request',
  endpoint: 'backchannel-authentication',
  feature: 'ciba',
  kind: 'issue',
  label: 'Resolve the login_hint and create the pending request',
  spec: 'CIBA Core 1.0 §7.1 - §7.3',
  function: 'createBackchannelAuthenticationRequest',
  calls: ['processBackchannelAuthenticationRequest'],
  consumes: ['params', 'client'],
  produces: ['cibaResponse'],
  removable: false,
});

/**
 * Resolve the login_hint and create the pending authentication request.
 * CIBA Core 1.0 §7.1 - §7.3
 *
 * Validation runs in CIBA §7.1 order inside the experimental package:
 * client checks (public client / grant registration / delivery mode) →
 * request parameter rejection → the one-and-only-one hint rule → scope →
 * binding_message → requested_expiry → login_hint resolution → the
 * per-subject pending cap → record creation.
 *
 * login_hint → subject resolution is the deployment's swap point: the
 * default (the context entry of features/ciba/feature.ts) treats the hint as
 * a username of the configured user store. Pass cibaUserResolver to
 * createApp() / applyOidc() to resolve email addresses, phone numbers, or
 * your own ids.
 *
 * Never log auth_req_id (a live credential) or login_hint (PII, CIBA §15).
 */
export async function createBackchannelAuthenticationRequest(
  c: any,
  params: Record<string, string>,
  client: TokenClientInfo,
): Promise<object> {
  const cibaStore = c.get('cibaAuthenticationRequestStore');
  const resolveUser = c.get('cibaUserResolver');
  return processBackchannelAuthenticationRequest({
    params,
    client: client as CibaClientInfo,
    store: cibaStore,
    config: cibaConfig,
    // OIDC Core 1.0 §11: offline_access is ignored when the provider has no
    // refresh_token grant (the refresh-token feature is not generated).
    refreshTokenFeatureEnabled: tokenGrantsOf(features).includes('refresh_token'),
    resolveUser,
  });
}
