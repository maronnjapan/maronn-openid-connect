import {
  type ClientInfo,
  resolveRequestObjectParams,
  type ResolvedRequestObjectParams,
} from '@maronn-openid-connect/core';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'resolve-request-object',
  endpoint: 'authorize',
  feature: 'request-object',
  kind: 'resolve',
  label: 'Verify the Request Object and overlay its claims',
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
 * あれば、クライアントが `request_object` の用途に登録した鍵を取得し、その鍵でリクエストオブジェクトの署名を検証する。
 * 検証できたら、クレームでクエリの値を上書きしたパラメータ（`effectiveParams`）と、検証したクレーム（`requestObjectClaims`）を返す。
 * 上書きするのは `redirect_uri`、`scope`、`state`、`nonce` などの決まったパラメータで、`response_type` と `client_id` は上書きしない（core の `mergeRequestObjectParams()`）。
 * 以降のステップは `effectiveParams` を検証する。
 *
 * 署名のアルゴリズムは RS256 だけを受け付ける。
 * 署名のない `alg=none` は、`config.allowUnsignedRequestObject` を有効にしたときだけ受け付ける（OIDF の適合性テストとの互換のため）。
 *
 * @throws {AuthorizationError} `invalid_request_object`: リクエストオブジェクトの形式、`alg`、鍵、署名のどれかが正しくないとき（OIDC Core 1.0 §6.3）。
 *   検証できないリクエストオブジェクトの `redirect_uri` は信用できないので、このエラーはクライアントへリダイレクトしない。
 * @spec OIDC Core 1.0 §6.1
 * @spec OIDC Core 1.0 §6.3.2
 */
export async function resolveRequestObject(
  c: any,
  params: AuthorizationRequestInput,
  client: ClientInfo,
): Promise<ResolvedRequestObjectParams> {
  const config = c.get('config');
  const clientKeyResolver = c.get('clientKeyResolver');
  // クライアントの鍵は、リクエストオブジェクトを含むリクエストのときだけ取得する。
  const jwks = params.request === undefined
    ? undefined
    : await clientKeyResolver.findClientKeys(client.clientId, 'request_object');
  return resolveRequestObjectParams(params, { jwks, allowUnsigned: config.allowUnsignedRequestObject });
}
