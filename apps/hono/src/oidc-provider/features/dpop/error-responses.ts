/**
 * EXTENSION (dpop): the response of the token endpoint to the failures of the
 * DPoP checks (DpopError of errors.ts).
 *
 * Kept apart from errors.ts, as in the Next.js template: the checks import
 * errors.ts alone, and only the steps need the endpoint responses.
 */
import { TokenEndpointError } from '../../endpoints/token/response.js';
import { isDpopError } from './errors.js';

/**
 * トークンエンドポイントでの DPoP の検査の失敗を、400 の OAuth のエラーレスポンスにして返す。
 *
 * `invalid_dpop_proof`（DPoP proof の不備）と `invalid_grant`（鍵に束縛した認可コードかリフレッシュトークンに、その鍵の DPoP proof が無い）は、どちらも 400 で応答する（RFC 9449 §5、RFC 6749 §5.2）。
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
