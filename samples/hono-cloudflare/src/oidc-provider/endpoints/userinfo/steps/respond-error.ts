import { UserInfoError } from '@maronn-openid-connect/core';
import { BEARER_CHALLENGE, UserInfoEndpointError, type UserInfoChallenge } from '../response.js';
import { respondUserInfo } from './respond.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'userinfo',
  kind: 'respond',
  label: 'Bearer のチャレンジで応答する',
  spec: 'RFC 6750 §3',
  function: 'respondUserInfoError',
  consumes: ['challenge'],
  optional: ['challenge'],
  produces: [],
  removable: false,
});

/**
 * ステップの失敗に、種類に応じたエラーで応答する。
 *
 * エラーの種類ごとに、次のように応答する。
 * - `UserInfoEndpointError`: ステップが決めたレスポンスをそのまま返す。
 * - `UserInfoError`: パイプラインが拒否したトークンに、RFC 6750 §3 のチャレンジ（`WWW-Authenticate` ヘッダー）とエラーの JSON で応答する（`invalid_token` なら 401、`insufficient_scope` なら 403）。
 *   チャレンジの認証スキームは `challenge` のもので、既定は `Bearer` である。
 *   機能（dpop）が DPoP スキームで提示されたトークンを読んだときは、DPoP のチャレンジ（受け付ける alg の `algs` 付き）で応答する（RFC 9449 §7.1）。
 * - それ以外: 500 の `server_error` で応答する。
 *
 * どのレスポンスにも、キャッシュを禁じるヘッダーを付ける（`respondUserInfo()`）。
 *
 * @spec RFC 6750 §3
 * @spec RFC 9449 §7.1
 */
export function respondUserInfoError(c: any, error: unknown, challenge: UserInfoChallenge = BEARER_CHALLENGE): Response {
  if (error instanceof UserInfoEndpointError) {
    return respondUserInfo(c, error.response);
  }
  if (error instanceof UserInfoError) {
    return respondUserInfo(c, {
      status: error.statusCode,
      body: { error: error.error, error_description: error.errorDescription },
      headers: {
        'WWW-Authenticate':
          `${challenge.scheme} realm="UserInfo", error="${error.error}", error_description="${error.errorDescription}"` +
          (challenge.parameters === undefined ? '' : `, ${challenge.parameters}`),
      },
    });
  }
  return respondUserInfo(c, { status: 500, body: { error: 'server_error' } });
}
