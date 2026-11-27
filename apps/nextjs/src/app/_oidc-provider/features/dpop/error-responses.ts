/**
 * EXTENSION (dpop): the responses of the token and UserInfo endpoints to the
 * failures of the DPoP checks (DpopError of errors.ts).
 *
 * Kept apart from errors.ts because it imports http.ts: errors.ts is loaded
 * with the feature list (config.ts imports jwk.ts, which throws DpopError), and
 * http.ts reads the feature list when it is loaded (see feature.ts).
 */
import { UserInfoEndpointError } from '../../../userinfo/response';
import { oauthError } from '../../http';
import { isDpopError } from './errors';

/**
 * トークンエンドポイントでの DPoP の検査の失敗を、キャッシュさせない 400 の OAuth のエラーレスポンスにして返す。
 *
 * `invalid_dpop_proof`（DPoP proof の不備）と `invalid_grant`（鍵に束縛した認可コードかリフレッシュトークンに、その鍵の DPoP proof が無い）は、どちらも 400 で応答する（RFC 9449 §5、RFC 6749 §5.2）。
 * DPoP の失敗でないエラーには `undefined` を返し、呼び出し側がそのまま投げ直す。
 *
 * @spec RFC 9449 §5
 * @spec RFC 6749 §5.2
 */
export function tokenEndpointRejectionOf(error: unknown): Response | undefined {
  if (!isDpopError(error)) return undefined;
  return oauthError(error.error, error.errorDescription, 400);
}

/**
 * 保護されたリソース（UserInfo エンドポイント）での DPoP の検査の失敗を、UserInfo エンドポイントのエラーにして返す。
 *
 * `invalid_dpop_proof`（DPoP proof の不備）と `invalid_token`（提示の仕方に合った鍵に束縛されていないアクセストークン）は 401 で、`invalid_request`（`Authorization: DPoP` の形の誤り、二つの方法で送ったトークン）は 400 で応答する（RFC 9449 §7.1、RFC 6750 §3.1）。
 * エラーの情報は、レスポンスの JSON と、リクエストがトークンを提示したスキームのチャレンジ（`WWW-Authenticate`）に入れる（RFC 9449 §7.2）。
 * `invalid_grant` はトークンエンドポイントだけが返すコード（RFC 6749 §5.2）なので、UserInfo エンドポイントのエラーにしない。
 * それと DPoP の失敗でないエラーは、そのまま返す。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9449 §7.2
 * @spec RFC 6750 §3.1
 */
export function userInfoEndpointErrorOf(error: unknown): unknown {
  if (!isDpopError(error) || error.error === 'invalid_grant') return error;
  return new UserInfoEndpointError(
    {
      status: error.error === 'invalid_request' ? 400 : 401,
      body: { error: error.error, error_description: error.errorDescription },
    },
    { error: error.error, errorDescription: error.errorDescription },
  );
}
