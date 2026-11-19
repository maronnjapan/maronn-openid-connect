/**
 * EXTENSION (dpop): the responses of the token and UserInfo endpoints to the
 * failures of the DPoP checks (DpopError of errors.ts).
 *
 * Kept apart from errors.ts, as in the Next.js template: the checks import
 * errors.ts alone, and only the steps need the endpoint responses.
 */
import { TokenEndpointError } from '../../endpoints/token/response.js';
import { UserInfoEndpointError } from '../../endpoints/userinfo/response.js';
import { isDpopError, type DpopError } from './errors.js';
import { buildDpopChallenge } from './resource.js';

/**
 * トークンエンドポイントでの DPoP の検査の失敗を、400 の OAuth のエラーレスポンスにして返す。
 *
 * `invalid_dpop_proof`（DPoP proof の不備）、`invalid_grant`（認可コードかリフレッシュトークンが別の鍵に束縛されている）、`invalid_request` は、どれも 400 で応答する（RFC 6749 §5.2）。
 * DPoP の失敗でないエラーは、そのまま返す。
 *
 * @spec RFC 9449 §5
 * @spec RFC 6749 §5.2
 */
export function tokenEndpointErrorOf(error: unknown): unknown {
  if (!isDpopError(error)) return error;
  return new TokenEndpointError({
    status: 400,
    body: { error: error.error, error_description: error.errorDescription },
  });
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
