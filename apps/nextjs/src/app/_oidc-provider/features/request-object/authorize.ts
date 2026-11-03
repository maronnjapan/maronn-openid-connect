import {
  resolveRequestObjectParams,
  type AuthorizationRequestParams,
  type ClientInfo,
  type ResolvedRequestObjectParams,
} from '@maronn-openid-connect/core';
import { clientKeyResolver, config } from '../../provider';

/**
 * リクエストオブジェクトを検証し、値をクエリに反映する。
 *
 * `request` パラメータがなければ、クエリのパラメータの複製を `effectiveParams` として返す。
 * あれば、クライアントが `request_object` の用途に登録した鍵を取得し、その鍵でリクエストオブジェクトの署名を検証する。
 * 検証できたら、クレームでクエリの値を上書きしたパラメータ（`effectiveParams`）と、検証したクレーム（`requestObjectClaims`）を返す。
 * 上書きするのは `redirect_uri`、`scope`、`state`、`nonce` などの決まったパラメータで、`response_type` と `client_id` は上書きしない（core の `mergeRequestObjectParams()`）。
 * 以降のブロックは `effectiveParams` を検証する。
 *
 * 署名のアルゴリズムは RS256 だけを受け付ける。
 * 署名のない `alg=none` は、`config.allowUnsignedRequestObject` を有効にしたときだけ受け付ける（OIDF の適合性テストとの互換のため）。
 *
 * @throws {AuthorizationError} `invalid_request_object`: リクエストオブジェクトの形式、`alg`、鍵、署名のどれかが正しくないとき（OIDC Core 1.0 §6.3）。
 *   検証できないリクエストオブジェクトの `redirect_uri` は信用できないので、このエラーはクライアントへリダイレクトせず、OP のエラーページか JSON で返す。
 * @spec OIDC Core 1.0 §6.1
 * @spec OIDC Core 1.0 §6.3.2
 */
export async function resolveRequestObject(
  params: AuthorizationRequestParams,
  client: ClientInfo,
): Promise<ResolvedRequestObjectParams> {
  const jwks = params.request === undefined
    ? undefined
    : await clientKeyResolver.findClientKeys(client.clientId, 'request_object');
  return resolveRequestObjectParams(params, { jwks, allowUnsigned: config.allowUnsignedRequestObject });
}
