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
  consumes: ['params', 'client'],
  produces: ['cibaResponse'],
  removable: false,
});

/**
 * 認証リクエストを検証して保存し、`auth_req_id` を返す。
 *
 * 検証と保存は、experimental パッケージの `processBackchannelAuthenticationRequest()` が行う。
 * 検証は CIBA §7.1 の順に進む。
 * クライアント（パブリッククライアントでないこと、CIBA のグラントタイプの登録、トークンの配信モード）、`request` パラメータがないこと、ヒントがちょうど 1 つであること、`scope`、`binding_message`、`requested_expiry`、`login_hint` からのユーザーの特定、ユーザーごとの保留中のリクエスト数の上限の順に確かめ、最初に満たさなかった検証の `BackchannelAuthenticationError` を投げる。
 * すべて通ると、状態が `pending` のレコードをストアに保存し、成功レスポンスのボディ（`auth_req_id`、`expires_in`、`interval`）を返す。
 *
 * `login_hint` からユーザーを特定する処理は、OP を導入する側が差し替える箇所である。
 * 既定の処理（`features/ciba/feature.ts` のコンテキストの項目）は、ヒントをユーザーストアのユーザー名として扱う。
 * メールアドレス、電話番号、独自の ID でユーザーを特定するには、`createApp()` か `applyOidc()` に `cibaUserResolver` を渡す。
 *
 * `auth_req_id`（有効な間はトークンの取得に使える値）と `login_hint`（個人情報。CIBA §15）は、ログに出さない。
 *
 * @spec CIBA Core 1.0 §7.1
 * @spec CIBA Core 1.0 §7.2
 * @spec CIBA Core 1.0 §7.3
 * @throws {BackchannelAuthenticationError} `invalid_request`、`invalid_scope`、`invalid_binding_message`、`unknown_user_id`、`unauthorized_client`: リクエストかクライアントが検証を満たさないとき。
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
    // `false`（`refresh-token` 機能を生成しておらず、`refresh_token` グラントがない）なら、`offline_access` は無視される（OIDC Core 1.0 §11）。
    refreshTokenFeatureEnabled: tokenGrantsOf(features).includes('refresh_token'),
    resolveUser,
  });
}
