import { type TokenClientInfo, findUnregisteredClientScopes } from '@maronn-openid-connect/core';
import {
  DeviceAuthorizationError,
  applyOfflineAccessPolicy,
  validateDeviceAuthorizationScope,
  validateDeviceGrantAllowed,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { findUnsupportedScopes } from '../../../../../scopes.js';
import { features } from '../../../../enabled.js';
import { tokenGrantsOf } from '../../../../feature.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'validate-request',
  endpoint: 'device-authorization',
  feature: 'device-authorization-grant',
  kind: 'validate',
  label: 'Validate the grant registration and the scope',
  spec: 'RFC 8628 §3.1 / RFC 7591 §2 / OIDC Core 1.0 §11',
  function: 'validateDeviceAuthorizationRequest',
  consumes: ['params', 'client'],
  produces: ['scope'],
  removable: false,
});

/**
 * グラントの登録とスコープを検証し、記録するスコープを返す。
 *
 * 次の順に確かめ、最初に満たさなかったものの `DeviceAuthorizationError` を投げる。
 * - クライアントがデバイス認可グラントを登録している（`unauthorized_client`）。
 * - `scope` があり、`openid` を含む（`invalid_request` か `invalid_scope`）。
 * - スコープの一覧を登録したクライアントなら、一覧にあるスコープだけを要求している（`invalid_scope`）。
 * - OP が宣言したスコープだけを要求している（`invalid_scope`）。
 *
 * 最後の検証の前に、許可できない `offline_access` を取り除く（OIDC Core 1.0 §11）。
 * 返すのは、取り除いた後のスコープである。
 *
 * それぞれの検証は experimental パッケージか core の独立した関数なので、呼び出しを消せばその検証を外せ、間に独自の処理を入れることもできる。
 *
 * @spec RFC 8628 §3.1
 * @spec RFC 7591 §2
 * @spec OIDC Core 1.0 §11
 * @throws {DeviceAuthorizationError} `unauthorized_client`、`invalid_request`、`invalid_scope`: 上の検証のどれかを満たさないとき。
 */
export function validateDeviceAuthorizationRequest(
  params: Record<string, string>,
  client: TokenClientInfo,
): string[] {
  // RFC 6749 §5.2: the client must be registered for the device_code grant.
  validateDeviceGrantAllowed(client);

  // RFC 8628 §3.1 leaves scope OPTIONAL, but this OP requires scope and openid
  // everywhere (same rule as /authorize). Requests that omit scope — legal per
  // RFC 8628 — are therefore rejected: a known, deliberate profile restriction.
  const requestedScope = validateDeviceAuthorizationScope(params['scope']);

  // RFC 7591 §2: a client registered with a scope list (client.scope) may only
  // request those scopes, the same rule as /authorize.
  const unregisteredScopes = findUnregisteredClientScopes(requestedScope, client.scope);
  if (unregisteredScopes.length > 0) {
    throw new DeviceAuthorizationError(
      'invalid_scope',
      'Client is not registered for scope: ' + unregisteredScopes.join(' '),
    );
  }

  // OIDC Core 1.0 §11: drop offline_access when it could never be granted:
  // the client is not registered for refresh_token, or the provider has no
  // refresh_token grant (the refresh-token feature is not generated).
  const scope = applyOfflineAccessPolicy(requestedScope, {
    client,
    refreshTokenFeatureEnabled: tokenGrantsOf(features).includes('refresh_token'),
  });

  // RFC 6749 §3.3: reject a scope this OP never declared, the same way
  // /authorize does. Checked after applyOfflineAccessPolicy so an
  // offline_access that the policy already dropped stays ignored rather than
  // becoming invalid_scope (OIDC Core 1.0 §11).
  const unsupportedScopes = findUnsupportedScopes(scope);
  if (unsupportedScopes.length > 0) {
    throw new DeviceAuthorizationError(
      'invalid_scope',
      'Unsupported scope: ' + unsupportedScopes.join(' '),
    );
  }

  return scope;
}
