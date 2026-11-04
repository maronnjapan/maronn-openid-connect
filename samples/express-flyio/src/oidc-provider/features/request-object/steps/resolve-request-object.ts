import {
  resolveRequestObjectParams,
  type ResolvedRequestObjectParams,
} from '@maronn-openid-connect/core';
import { getClientKeyResolver } from '../../../client-jwks-uri.js';
import type { RegisteredClient } from '../../../config.js';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'resolve-request-object',
  endpoint: 'authorize',
  feature: 'request-object',
  kind: 'resolve',
  label: 'リクエストオブジェクトを検証し、その値で上書きする',
  spec: 'OIDC Core 1.0 §6.1',
  function: 'resolveRequestObject',
  consumes: ['params', 'client'],
  produces: ['effectiveParams', 'requestObjectClaims'],
  removable: false,
});

/**
 * リクエストオブジェクトを検証し、値をクエリに反映する。
 *
 * `request` パラメータがなければ、クエリのパラメータの複製を `effectiveParams` として返す。
 * あれば、クライアントが `request_object` の用途に登録した鍵で、リクエストオブジェクトの署名を検証する。
 * 検証できたら、クレームでクエリの値を上書きしたパラメータ（`effectiveParams`）と、検証したクレーム（`requestObjectClaims`）を返す。
 * 上書きするのは `redirect_uri`、`scope`、`state`、`nonce` などの決まったパラメータで、`response_type` と `client_id` は上書きしない（core の `mergeRequestObjectParams()`）。
 * 以降のステップは `effectiveParams` を検証する。
 *
 * 署名のアルゴリズムは `config.requestObjectSigningAlgValuesSupported` にあるものだけを受け付け、クライアントが `requestObjectSigningAlg` を登録していれば、その alg だけを受け付ける（OIDC Core 1.0 §6.3.2）。
 * 署名のない `alg=none` は、`config.allowUnsignedRequestObject` を有効にしたときだけ受け付ける（OIDF の適合性テストとの互換のため）。
 * 鍵は、ヘッダーの `alg` がこれらの確認を通った後でだけ、ヘッダーの `kid` を手がかりに取得する。
 * そのため、`jwks_uri` を登録したクライアントが鍵を足したときは、見慣れない `kid` で `jwks_uri` を取り直し（OIDC Core 1.0 §10.1.1）、拒否するリクエストオブジェクトのために `jwks_uri` を取得することはない。
 *
 * @throws {AuthorizationError} `invalid_request_object`: リクエストオブジェクトの形式、`alg`、鍵、署名のどれかが正しくないとき、または `jwks_uri` から鍵を取得できないとき（OIDC Core 1.0 §6.3）。
 *   検証できないリクエストオブジェクトの `redirect_uri` は信用できないので、このエラーはクライアントへリダイレクトせず、OP のエラーページか JSON で返す。
 * @spec OIDC Core 1.0 §6.1
 * @spec OIDC Core 1.0 §6.3.2
 * @spec OIDC Core 1.0 §10.1.1
 */
export async function resolveRequestObject(
  c: any,
  params: AuthorizationRequestInput,
  client: RegisteredClient,
): Promise<ResolvedRequestObjectParams> {
  const config = c.get('config');
  const clientKeyResolver = getClientKeyResolver(c);
  // 鍵は、resolveRequestObjectParams() がヘッダーの `alg` を確かめた後でだけ読む（loadJwks）。
  // そのため、検証しないリクエストオブジェクトのために鍵や `jwks_uri` を読むことはない。
  return resolveRequestObjectParams(params, {
    loadJwks: ({ kid }) => clientKeyResolver.findClientKeys(client.clientId, 'request_object', { kid }),
    supportedSigningAlgs: [...config.requestObjectSigningAlgValuesSupported],
    allowUnsigned: config.allowUnsignedRequestObject,
    requestObjectSigningAlg: client.requestObjectSigningAlg,
  });
}
