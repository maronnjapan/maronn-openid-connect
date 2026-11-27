import { UserInfoError } from '@maronn-openid-connect/core';
import { UserInfoEndpointError, userInfoChallengeHeader, type UserInfoChallenges } from '../response.js';
import { respondUserInfo } from './respond.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'userinfo',
  kind: 'respond',
  label: '受け付ける認証スキームのチャレンジで応答する',
  spec: 'RFC 6750 §3 / RFC 9449 §7.2',
  function: 'respondUserInfoError',
  consumes: ['challenges'],
  produces: [],
  removable: false,
});

/**
 * ステップの失敗に、種類に応じたエラーで応答する。
 *
 * エラーの種類ごとに、次のように応答する。
 * - `UserInfoEndpointError`: ステップが決めたレスポンスを返す。ステップがチャレンジを求めたときは、受け付ける認証スキームのチャレンジ（`WWW-Authenticate` ヘッダー）を付ける。
 * - `UserInfoError`: パイプラインが拒否したトークンに、受け付ける認証スキームのチャレンジとエラーの JSON で応答する（`invalid_token` なら 401、`insufficient_scope` なら 403）。
 *   エラーの情報は、リクエストがトークンを提示したスキーム（`challenges.scheme`）のチャレンジが伝える（RFC 6750 §3、RFC 9449 §7.2）。
 * - それ以外: 500 の `server_error` で応答する。
 *
 * チャレンジは `challenges` のスキームごとに一つで、機能を有効にしなければ `Bearer realm="UserInfo"` だけである。
 * どのレスポンスにも、キャッシュを禁じるヘッダーを付ける（`respondUserInfo()`）。
 *
 * @spec RFC 6750 §3
 * @spec RFC 9449 §7.2
 */
export function respondUserInfoError(c: any, error: unknown, challenges: UserInfoChallenges): Response {
  if (error instanceof UserInfoEndpointError) {
    if (error.challenge === undefined) {
      return respondUserInfo(c, error.response);
    }
    return respondUserInfo(c, {
      ...error.response,
      headers: { ...error.response.headers, 'WWW-Authenticate': userInfoChallengeHeader(challenges, error.challenge) },
    });
  }
  if (error instanceof UserInfoError) {
    return respondUserInfo(c, {
      status: error.statusCode,
      body: { error: error.error, error_description: error.errorDescription },
      headers: {
        'WWW-Authenticate': userInfoChallengeHeader(challenges, {
          error: error.error,
          errorDescription: error.errorDescription,
        }),
      },
    });
  }
  return respondUserInfo(c, { status: 500, body: { error: 'server_error' } });
}
