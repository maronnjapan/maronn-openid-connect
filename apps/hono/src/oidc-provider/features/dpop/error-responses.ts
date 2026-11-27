/**
 * EXTENSION (dpop): the responses of the token and UserInfo endpoints to the
 * failures of the DPoP checks (DpopError of errors.ts), and the UserInfo error
 * of a request that sends its access token with both Bearer and DPoP.
 *
 * Kept apart from errors.ts, as in the Next.js template: the checks import
 * errors.ts alone, and only the steps need the endpoint responses.
 */
import { TokenEndpointError } from '../../endpoints/token/response.js';
import { UserInfoEndpointError } from '../../endpoints/userinfo/response.js';
import { isDpopError } from './errors.js';

/**
 * トークンエンドポイントでの DPoP の検査の失敗を、400 の OAuth のエラーレスポンスにして返す。
 *
 * `invalid_dpop_proof`（DPoP proof の不備）と `invalid_grant`（鍵に束縛した認可コードかリフレッシュトークンに、その鍵の DPoP proof が無い）は、どちらも 400 で応答する（RFC 9449 §5、RFC 6749 §5.2）。
 * RFC 6749 §5.2 のコードでもある `invalid_request` も 400 で応答する。
 * `invalid_token` は保護されたリソースだけが返すコード（RFC 6750 §3.1）なので、トークンエンドポイントのエラーにしない。
 * それと DPoP の失敗でないエラーは、そのまま返す。
 *
 * @spec RFC 9449 §5
 * @spec RFC 6749 §5.2
 */
export function tokenEndpointErrorOf(error: unknown): unknown {
  if (!isDpopError(error) || error.error === 'invalid_token') return error;
  return new TokenEndpointError({
    status: 400,
    body: { error: error.error, error_description: error.errorDescription },
  });
}

/**
 * 保護されたリソース（UserInfo エンドポイント）での DPoP の検査の失敗を、UserInfo エンドポイントのエラーにして返す。
 *
 * `invalid_dpop_proof`（DPoP proof の不備）と `invalid_token`（提示の仕方に合った鍵に束縛されていないアクセストークン）は 401 で、`invalid_request`（`Authorization: DPoP` の形の誤り）は 400 で応答する（RFC 9449 §7.1、RFC 6750 §3.1）。
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

/** Bearer と DPoP の両方でアクセストークンを送ったリクエストへのエラーの説明（Bearer の二つの方法を使ったリクエストへの JSON と同じ文）。 */
const MULTIPLE_METHODS_DESCRIPTION = 'Multiple access token methods are not allowed';

/**
 * Bearer と DPoP の両方の認証スキームでアクセストークンを送った UserInfo のリクエストへの、400 の `invalid_request` のエラーを返す。
 *
 * 両方とは、`Authorization` に二つのスキームを並べた（二つのフィールドを送った）リクエストと、`Authorization: DPoP` とフォームのボディの `access_token`（Bearer の方法、RFC 6750 §2.2）の両方でトークンを送ったリクエストである。
 * どちらのスキームで認証しようとしたのか決まらないので、受け付けるどのスキームのチャレンジにも、エラーの情報を入れる（`everyScheme`、RFC 9449 §7.2 Figure 19）。
 *
 * @spec RFC 9449 §7.2
 * @spec RFC 6750 §2
 */
export function ambiguousUserInfoRequestError(): UserInfoEndpointError {
  return new UserInfoEndpointError(
    { status: 400, body: { error: 'invalid_request', error_description: MULTIPLE_METHODS_DESCRIPTION } },
    { error: 'invalid_request', errorDescription: MULTIPLE_METHODS_DESCRIPTION, everyScheme: true },
  );
}
