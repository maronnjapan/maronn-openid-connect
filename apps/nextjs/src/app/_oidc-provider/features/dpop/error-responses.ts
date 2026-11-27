/**
 * EXTENSION (dpop): the responses of the token, PAR and UserInfo endpoints to
 * the failures of the DPoP checks (DpopError of errors.ts), and the UserInfo
 * error of a request that sends its access token with both Bearer and DPoP.
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
 * `use_dpop_nonce`（DPoP proof に、認可サーバーが最近発行した nonce が無い）も 400 で応答する（RFC 9449 §8）。
 * RFC 6749 §5.2 のコードでもある `invalid_request` も 400 で応答する。
 * `invalid_token` は保護されたリソースだけが返すコード（RFC 6750 §3.1）なので、トークンエンドポイントのレスポンスにしない。
 * それと DPoP の失敗でないエラーには `undefined` を返し、呼び出し側がそのまま投げ直す。
 *
 * @spec RFC 9449 §5
 * @spec RFC 9449 §8
 * @spec RFC 6749 §5.2
 */
export function tokenEndpointRejectionOf(error: unknown): Response | undefined {
  if (!isDpopError(error) || error.error === 'invalid_token') return undefined;
  return oauthError(error.error, error.errorDescription, 400);
}

/** PAR エンドポイントが 400 で応答する DPoP の検査のエラーコード。 */
const PAR_DPOP_ERROR_CODES: readonly string[] = ['invalid_dpop_proof', 'invalid_request', 'use_dpop_nonce'];

/**
 * PAR エンドポイントでの DPoP の検査の失敗を、キャッシュさせない 400 の JSON のエラーレスポンスにして返す。
 *
 * `invalid_dpop_proof`（DPoP proof の不備と、プッシュした `dpop_jkt` が DPoP proof の鍵と違うこと）、`invalid_request`（`dpop_jkt` が JWK Thumbprint の形でない）、`use_dpop_nonce`（DPoP proof に、認可サーバーが最近発行した nonce が無い）を、PAR のエラーと同じ形（RFC 9126 §2.3）の 400 の JSON（`no-cache, no-store`）にする。
 * それ以外のコード（トークンエンドポイントだけの `invalid_grant`、保護されたリソースだけの `invalid_token`）と、DPoP の失敗でないエラーには `undefined` を返し、呼び出し側がそのまま投げ直す（PAR エンドポイントは 500 の `server_error` で応答する）。
 *
 * @spec RFC 9449 §8
 * @spec RFC 9449 §10.1
 * @spec RFC 9126 §2.3
 */
export function parEndpointRejectionOf(error: unknown): Response | undefined {
  if (!isDpopError(error) || !PAR_DPOP_ERROR_CODES.includes(error.error)) return undefined;
  return Response.json(
    { error: error.error, error_description: error.errorDescription },
    { status: 400, headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' } },
  );
}

/**
 * 保護されたリソース（UserInfo エンドポイント）での DPoP の検査の失敗を、UserInfo エンドポイントのエラーにして返す。
 *
 * `invalid_dpop_proof`（DPoP proof の不備）と `invalid_token`（提示の仕方に合った鍵に束縛されていないアクセストークン）は 401 で、`invalid_request`（`Authorization: DPoP` の形の誤り）は 400 で応答する（RFC 9449 §7.1、RFC 6750 §3.1）。
 * `use_dpop_nonce`（DPoP proof に、保護されたリソースが最近発行した nonce が無い）も 401 で応答する（RFC 9449 §9）。
 * エラーの情報は、レスポンスの JSON と、リクエストがトークンを提示したスキームのチャレンジ（`WWW-Authenticate`）に入れる（RFC 9449 §7.2）。
 * `invalid_grant` はトークンエンドポイントだけが返すコード（RFC 6749 §5.2）なので、UserInfo エンドポイントのエラーにしない。
 * それと DPoP の失敗でないエラーは、そのまま返す。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9449 §7.2
 * @spec RFC 9449 §9
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
