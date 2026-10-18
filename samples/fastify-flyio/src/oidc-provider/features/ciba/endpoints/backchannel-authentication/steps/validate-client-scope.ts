import { type TokenClientInfo, findUnregisteredClientScopes } from '@maronn-openid-connect/core';
import { BackchannelAuthenticationError } from '@maronn-openid-connect/experimental/ciba';
import { findUnsupportedScopes } from '../../../../../scopes.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'validate-client-scope',
  endpoint: 'backchannel-authentication',
  feature: 'ciba',
  kind: 'validate',
  label: 'Check the requested scope against the registration',
  spec: 'RFC 7591 §2 / RFC 6749 §3.3',
  function: 'validateCibaClientScope',
  calls: ['findUnsupportedScopes', 'findUnregisteredClientScopes'],
  consumes: ['params', 'client'],
  produces: [],
  removable: false,
});

/**
 * RFC 7591 §2: a client registered with a scope list (client.scope) may only
 * request those scopes, the same rule as /authorize.
 */
export function validateCibaClientScope(params: Record<string, string>, client: TokenClientInfo): void {
  // RFC 6749 §3.3: reject a scope this OP never declared, the same allow list
  // /authorize uses (scopes.ts). Checked before the pipeline so a request for
  // an unknown scope never reaches the store. offline_access is left out of
  // the check: the pipeline applies its own policy and ignores it when it
  // cannot be granted (OIDC Core 1.0 §11), which must not become an error.
  const unsupportedScopes = findUnsupportedScopes(
    (params['scope'] ?? '')
      .split(' ')
      .filter((scope) => scope.length > 0 && scope !== 'offline_access'),
  );
  if (unsupportedScopes.length > 0) {
    throw new BackchannelAuthenticationError(
      'invalid_scope',
      'Unsupported scope: ' + unsupportedScopes.join(' '),
    );
  }

  const unregisteredScopes = findUnregisteredClientScopes(
    (params['scope'] ?? '').split(' ').filter((scope) => scope.length > 0),
    client.scope,
  );
  if (unregisteredScopes.length > 0) {
    throw new BackchannelAuthenticationError(
      'invalid_scope',
      'Client is not registered for scope: ' + unregisteredScopes.join(' '),
    );
  }
}
