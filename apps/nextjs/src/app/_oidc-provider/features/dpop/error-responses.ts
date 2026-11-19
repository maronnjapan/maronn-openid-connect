/**
 * EXTENSION (dpop): the responses of the failures of the DPoP checks
 * (DpopError of errors.ts) at each endpoint.
 *
 * Kept apart from errors.ts because it imports http.ts: errors.ts is loaded
 * with the feature list (config.ts imports jwk.ts, which throws DpopError), and
 * http.ts reads the feature list when it is loaded (see feature.ts).
 */
import { UserInfoEndpointError } from '../../../userinfo/response';
import { oauthError } from '../../http';
import { isDpopError, type DpopError } from './errors';
import { buildDpopChallenge } from './resource';

/**
 * トークンエンドポイントでの DPoP の検査の失敗を、キャッシュさせない 400 の OAuth のエラーレスポンスにして返す。
 *
 * `invalid_dpop_proof`（DPoP proof の不備）、`invalid_grant`（認可コードかリフレッシュトークンが別の鍵に束縛されている）、`invalid_request` は、どれも 400 で応答する（RFC 6749 §5.2）。
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
 * 保護されたリソース（UserInfo エンドポイント）での DPoP の検査の失敗を、DPoP のチャレンジ付きのエラーレスポンスにして返す。
 *
 * `invalid_dpop_proof` と `invalid_token` は 401 で、`WWW-Authenticate: DPoP` のチャレンジに `error`、`error_description`、受け付ける alg（`algs`）を入れる（RFC 9449 §7.1）。
 * `invalid_request`（`Authorization: DPoP` にトークンがない、複数の方法でトークンを送った）は 400 で応答する（RFC 6750 §3.1）。
 * DPoP の失敗でないエラーは、そのまま返す。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 6750 §3.1
 */
export function userInfoEndpointErrorOf(error: unknown, algs: readonly string[]): unknown {
  if (!isDpopError(error)) return error;
  return userInfoDpopError(error, algs);
}

/**
 * DPoP の検査の失敗から、UserInfo エンドポイントの DPoP のチャレンジ付きのエラーレスポンスを作って返す。
 *
 * @spec RFC 9449 §7.1
 */
function userInfoDpopError(error: DpopError, algs: readonly string[]): UserInfoEndpointError {
  return new UserInfoEndpointError({
    status: error.error === 'invalid_request' ? 400 : 401,
    body: { error: error.error, error_description: error.errorDescription },
    headers: {
      'WWW-Authenticate': buildDpopChallenge({ algs, error: error.error, errorDescription: error.errorDescription }),
    },
  });
}
