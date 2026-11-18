import {
  AuthorizationError,
  AuthorizationErrorCode,
  type AuthorizationRequestParams,
  type ValidatedAuthorizationRequest,
} from '@maronn-openid-connect/core';
import { buildDpopConfirmation, isDpopError, parseDpopJkt } from '@maronn-openid-connect/dpop';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'validate-dpop-jkt',
  endpoint: 'authorize',
  feature: 'dpop',
  kind: 'validate',
  label: '認可コードを束縛する鍵（dpop_jkt）を確かめる',
  spec: 'RFC 9449 §10',
  function: 'validateDpopJktParameter',
  consumes: ['validatedRequest', 'params', 'effectiveParams'],
  optional: ['effectiveParams'],
  produces: ['codeConfirmation'],
  removable: false,
  after: ['validate-request'],
  before: ['create-transaction'],
});

/**
 * 認可リクエストの `dpop_jkt` を確かめ、認可コードを束縛する鍵の確認（`cnf`）を返す。
 *
 * `dpop_jkt` がなければ `undefined` を返し、認可コードは鍵に束縛しない。
 * `dpop_jkt` は DPoP の鍵の JWK Thumbprint（SHA-256 を base64url にした 43 文字）で、返した確認 `{ jkt }` はトランザクションから認可コードへ引き継がれる。
 * トークンエンドポイントは、その鍵の DPoP proof が付いた交換だけを受け付ける（RFC 9449 §10）。
 * PAR では、プッシュしたリクエストの `DPoP` ヘッダーの鍵が `dpop_jkt` として届く（RFC 9449 §10.1）。
 * Request Object の値は、クエリの値より優先する（OIDC Core 1.0 §6.1）。
 *
 * @spec RFC 9449 §10
 * @throws {AuthorizationError} `invalid_request`: `dpop_jkt` が JWK Thumbprint の形でないとき（クライアントへリダイレクトで返す）
 */
export function validateDpopJktParameter(
  validatedRequest: ValidatedAuthorizationRequest,
  params: AuthorizationRequestParams,
): Readonly<Record<string, string>> | undefined {
  try {
    const jkt = parseDpopJkt((params as { dpop_jkt?: unknown }).dpop_jkt);
    return jkt === undefined ? undefined : buildDpopConfirmation(jkt);
  } catch (error) {
    if (!isDpopError(error)) throw error;
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      error.errorDescription,
      validatedRequest.redirectUri,
      validatedRequest.state,
    );
  }
}
