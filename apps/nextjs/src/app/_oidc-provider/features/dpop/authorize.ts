/**
 * EXTENSION (dpop): the block of authorize/route.ts (RFC 9449 §10).
 *
 * The authorization endpoint calls validateDpopJktParameter() in its
 * [validate-dpop-jkt] block, after the request is validated and before the
 * transaction is created. The confirmation it returns goes into the
 * transaction as its cnf, and every code issued from the transaction (SSO,
 * consent, hybrid) carries it to the token endpoint.
 */
import {
  AuthorizationError,
  AuthorizationErrorCode,
  type AuthorizationRequestParams,
} from '@maronn-openid-connect/core';
import { buildDpopConfirmation, parseDpopJkt } from './binding';
import { isDpopError } from './errors';

/**
 * 認可リクエストの `dpop_jkt` を確かめ、認可コードを束縛する鍵の確認（`cnf`）を返す。
 *
 * `dpop_jkt` がない（または値が空の）ときは `undefined` を返し、認可コードは鍵に束縛しない。
 * `dpop_jkt` は DPoP の鍵の JWK Thumbprint（SHA-256 を base64url にした 43 文字）で、返した確認 `{ jkt }` はトランザクションから認可コードへ引き継がれる。
 * トークンエンドポイントは、その認可コードを、同じ鍵の DPoP proof を送った交換でだけ受け付ける（RFC 9449 §10）。
 * `requestParams` は、PAR でプッシュしたリクエストなら、プッシュしたパラメータを展開した後のものなので、PAR のボディの `dpop_jkt` もここで読む。
 * 検証したリクエストオブジェクトに `dpop_jkt` のクレームがあれば、クエリの値より優先する（OIDC Core 1.0 §6.1）。
 * core がリクエストオブジェクトのクレームで上書きするパラメータ（`requestParams`）は決まった名前だけなので、`dpop_jkt` はリクエストオブジェクトのクレーム（`requestObjectClaims`）から読む。
 *
 * @spec RFC 9449 §10
 * @spec OIDC Core 1.0 §6.1
 * @throws {AuthorizationError} `invalid_request`: `dpop_jkt` が JWK Thumbprint の形でないとき（クライアントへリダイレクトで返す）
 */
export function validateDpopJktParameter(
  request: { redirectUri: string; state: string | undefined },
  requestParams: AuthorizationRequestParams,
  requestObjectClaims: Record<string, unknown> | undefined,
): Readonly<Record<string, string>> | undefined {
  try {
    const value =
      requestObjectClaims !== undefined && 'dpop_jkt' in requestObjectClaims
        ? requestObjectClaims['dpop_jkt']
        : (requestParams as { dpop_jkt?: unknown }).dpop_jkt;
    const jkt = parseDpopJkt(value);
    return jkt === undefined ? undefined : buildDpopConfirmation(jkt);
  } catch (error) {
    if (!isDpopError(error)) throw error;
    throw new AuthorizationError(AuthorizationErrorCode.InvalidRequest, error.errorDescription, request.redirectUri, request.state);
  }
}
