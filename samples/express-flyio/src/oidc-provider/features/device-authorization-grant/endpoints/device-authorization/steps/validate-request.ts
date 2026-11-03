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
  label: '登録済みのグラントとスコープを検証する',
  spec: 'RFC 8628 §3.1 / RFC 7591 §2 / OIDC Core 1.0 §11',
  function: 'validateDeviceAuthorizationRequest',
  consumes: ['params', 'client'],
  produces: ['scope'],
  removable: false,
});

/**
 * グラントの登録とスコープを検証し、スコープを返す。
 *
 * 次の順に確かめ、最初に満たさなかったものの `DeviceAuthorizationError` を投げる。
 * - クライアントがデバイス認可グラントを登録している（`unauthorized_client`）。
 * - `scope` があり、`openid` を含む（`invalid_request` か `invalid_scope`）。
 * - スコープの一覧を登録したクライアントなら、一覧にあるスコープだけを要求している（`invalid_scope`）。
 * - OP が宣言したスコープだけを要求している（`invalid_scope`）。
 *
 * 最後の検証の前に、許可できない `offline_access` を取り除く（OIDC Core 1.0 §11）。
 * 返すのは、取り除いた後のスコープ（レコードに記録する値）である。
 *
 * それぞれの検証は experimental パッケージか core の独立した関数なので、呼び出しを消せばその検証を外せ、呼び出しの間に独自の処理を入れることもできる。
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
  // クライアントがデバイス認可グラントを登録していることを確かめる（RFC 6749 §5.2）。
  validateDeviceGrantAllowed(client);

  // `scope` があり、`openid` を含むことを確かめる。
  // RFC 8628 §3.1 では `scope` を省略してよい（OPTIONAL）が、この OP はどこでも `scope` と `openid` を必須にしている（`/authorize` と同じ規則）。
  // そのため、`scope` のないリクエストは、RFC 8628 では正しくても拒否する。
  // これは意図して設けた、既知の制限である。
  const requestedScope = validateDeviceAuthorizationScope(params['scope']);

  // スコープの一覧（`client.scope`）を登録したクライアントが、一覧にないスコープを要求していれば拒否する（RFC 7591 §2）。
  // `/authorize` と同じ規則である。
  const unregisteredScopes = findUnregisteredClientScopes(requestedScope, client.scope);
  if (unregisteredScopes.length > 0) {
    throw new DeviceAuthorizationError(
      'invalid_scope',
      'Client is not registered for scope: ' + unregisteredScopes.join(' '),
    );
  }

  // 許可できない `offline_access` を取り除く（OIDC Core 1.0 §11）。
  // 許可できないのは、クライアントが `refresh_token` を登録していないときと、OP に `refresh_token` グラントがない（`refresh-token` 機能を生成していない）ときである。
  const scope = applyOfflineAccessPolicy(requestedScope, {
    client,
    refreshTokenFeatureEnabled: tokenGrantsOf(features).includes('refresh_token'),
  });

  // OP が宣言していないスコープを、`/authorize` と同じように拒否する（RFC 6749 §3.3）。
  // `applyOfflineAccessPolicy()` の後で確かめるので、方針で取り除いた `offline_access` は `invalid_scope` にならず、無視されたままになる（OIDC Core 1.0 §11）。
  const unsupportedScopes = findUnsupportedScopes(scope);
  if (unsupportedScopes.length > 0) {
    throw new DeviceAuthorizationError(
      'invalid_scope',
      'Unsupported scope: ' + unsupportedScopes.join(' '),
    );
  }

  return scope;
}
