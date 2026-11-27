/**
 * EXTENSION (dpop): the response of the token endpoint to the failures of the
 * DPoP checks (DpopError of errors.ts).
 *
 * Kept apart from errors.ts because it imports http.ts: errors.ts is loaded
 * with the feature list (config.ts imports jwk.ts, which throws DpopError), and
 * http.ts reads the feature list when it is loaded (see feature.ts).
 */
import { oauthError } from '../../http';
import { isDpopError } from './errors';

/**
 * トークンエンドポイントでの DPoP の検査の失敗を、キャッシュさせない 400 の OAuth のエラーレスポンスにして返す。
 *
 * `invalid_dpop_proof`（DPoP proof の不備）は、400 で応答する（RFC 9449 §5、RFC 6749 §5.2）。
 * DPoP の失敗でないエラーには `undefined` を返し、呼び出し側がそのまま投げ直す。
 *
 * @spec RFC 9449 §5
 * @spec RFC 6749 §5.2
 */
export function tokenEndpointRejectionOf(error: unknown): Response | undefined {
  if (!isDpopError(error)) return undefined;
  return oauthError(error.error, error.errorDescription, 400);
}
