import {
  fetchRequestObjectByReference,
  isRequestUriError,
  resolveRequestObjectParams,
  resolveRequestUriParams,
  type AuthorizationRequestParams,
  type ResolvedRequestObjectParams,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../config';
import { getClientKeyResolver, config, outboundFetch } from '../../provider';

/**
 * リクエストオブジェクトを検証し、値をクエリに反映する。
 *
 * `request` パラメータがなければ、クエリのパラメータの複製を `effectiveParams` として返す。
 * あれば、クライアントが `request_object` の用途に登録した鍵で、リクエストオブジェクトの署名を検証する。
 * 検証できたら、クレームでクエリの値を上書きしたパラメータ（`effectiveParams`）と、検証したクレーム（`requestObjectClaims`）を返す。
 * 上書きするのは `redirect_uri`、`scope`、`state`、`nonce` などの決まったパラメータで、`response_type` と `client_id` は上書きしない（core の `mergeRequestObjectParams()`）。
 * 以降のブロックは `effectiveParams` を検証する。
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
  params: AuthorizationRequestParams,
  client: RegisteredClient,
): Promise<ResolvedRequestObjectParams> {
  const clientKeyResolver = getClientKeyResolver();
  // 鍵は、resolveRequestObjectParams() がヘッダーの `alg` を確かめた後でだけ読む（loadJwks）。
  // そのため、検証しないリクエストオブジェクトのために鍵や `jwks_uri` を読むことはない。
  return resolveRequestObjectParams(params, {
    loadJwks: ({ kid }) => clientKeyResolver.findClientKeys(client.clientId, 'request_object', { kid }),
    supportedSigningAlgs: [...config.requestObjectSigningAlgValuesSupported],
    allowUnsigned: config.allowUnsignedRequestObject,
    requestObjectSigningAlg: client.requestObjectSigningAlg,
  });
}

/**
 * `request_uri` が指すリクエストオブジェクトを取得し、`request_uri` を `request` に置き換えたパラメータを返す。
 *
 * `request_uri` がないときと、`config.requestUriParameterSupported` が無効なときは、`params` をそのまま返す。
 * 無効なときに残った `request_uri` は、後の `validate-request` のブロックが `request_uri_not_supported` で拒否する。
 * PAR の URN の `request_uri` は、前の `resolve-pushed-request` のブロックが展開しているので、ここに来るのは URL だけである。
 *
 * 取得は core の `fetchRequestObjectByReference()` が、宛先を検査してから、フラグメントを除いた URL を、リダイレクトに従わず、タイムアウトと本文の上限を付けて 1 回だけ行う（設定の `requestUriTimeoutMs`、`requestUriMaxBytes`、`requestUriMaxLength`、`allowInsecureRequestUri`）。
 * fetch は provider.ts の `outboundFetch` で差し替えられる。
 * `config.requireRequestUriRegistration` が有効なら、クライアントが登録した `requestUris` と完全に一致しない `request_uri` を取得せずに拒否する。
 * 取得した JWT は、次の `resolve-request-object` のブロックが、値で渡したリクエストオブジェクトと同じ規則（署名、alg、`allowUnsignedRequestObject`）で検証する。
 *
 * 取得できない `request_uri` は、ホストと理由を `console.warn` に書き、理由を含まない固定の `error_description` で拒否する。
 * どのエラーも、検証前のリクエストオブジェクトの `redirect_uri` を信用できない段階のものなので、クライアントへリダイレクトせず、OP のエラーページか JSON で返す。
 *
 * @spec OIDC Core 1.0 §6.2
 * @spec RFC 9101 §5.2
 * @spec RFC 9101 §10.4
 * @throws {AuthorizationError} `invalid_request`: `request` と `request_uri` を両方含むとき
 * @throws {AuthorizationError} `invalid_request_uri`: 登録されていない `request_uri` のとき（`requireRequestUriRegistration`）、または取得できないとき
 */
export async function fetchRequestUri<Params extends AuthorizationRequestParams>(
  params: Params,
  client: RegisteredClient,
): Promise<Params> {
  if (params.request_uri === undefined || !config.requestUriParameterSupported) {
    return params;
  }
  const resolved = await resolveRequestUriParams(params, {
    ...(config.requireRequestUriRegistration ? { registeredRequestUris: client.requestUris ?? [] } : {}),
    async load(uri) {
      try {
        return await fetchRequestObjectByReference(uri, {
          ...(outboundFetch === undefined ? {} : { fetch: outboundFetch }),
          timeoutMs: config.requestUriTimeoutMs,
          maxBytes: config.requestUriMaxBytes,
          policy: { allowInsecure: config.allowInsecureRequestUri, maxLength: config.requestUriMaxLength },
        });
      } catch (error) {
        // クラスではなく形で見分ける（isRequestUriError）。
        if (isRequestUriError(error)) {
          console.warn(`[oidc-provider] could not fetch the request_uri at ${hostOf(uri)}: ${error.message}`);
        }
        throw error;
      }
    },
  });
  // `request_uri` を `request` に置き換えただけなので、ほかのパラメータの型は変わらない。
  return resolved as Params;
}

/** ログに書くための `request_uri` のホストを返し、URL として読めなければ `(an invalid URL)` を返す。 */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return '(an invalid URL)';
  }
}
