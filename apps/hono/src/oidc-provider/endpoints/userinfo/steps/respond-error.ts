import { UserInfoError } from '@maronn-openid-connect/core';
import { UserInfoEndpointError } from '../response.js';
import { respondUserInfo } from './respond.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'userinfo',
  kind: 'respond',
  label: 'Respond with the Bearer challenge',
  spec: 'RFC 6750 §3',
  function: 'respondUserInfoError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * ステップの失敗に、種類に応じたエラーで応答する。
 *
 * エラーの種類ごとに、次のように応答する。
 * - `UserInfoEndpointError`: ステップが決めたレスポンスをそのまま返す。
 * - `UserInfoError`: パイプラインが拒否したトークンに、RFC 6750 §3 の `Bearer` のチャレンジ（`WWW-Authenticate` ヘッダー）とエラーの JSON で応答する（`invalid_token` なら 401、`insufficient_scope` なら 403）。
 * - それ以外: 500 の `server_error` で応答する。
 *
 * どのレスポンスにも、キャッシュを禁じるヘッダーを付ける（`respondUserInfo()`）。
 *
 * @spec RFC 6750 §3
 */
export function respondUserInfoError(c: any, error: unknown): Response {
  if (error instanceof UserInfoEndpointError) {
    return respondUserInfo(c, error.response);
  }
  if (error instanceof UserInfoError) {
    return respondUserInfo(c, {
      status: error.statusCode,
      body: { error: error.error, error_description: error.errorDescription },
      headers: {
        'WWW-Authenticate': `Bearer realm="UserInfo", error="${error.error}", error_description="${error.errorDescription}"`,
      },
    });
  }
  return respondUserInfo(c, { status: 500, body: { error: 'server_error' } });
}
