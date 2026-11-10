import {
  fetchRequestObjectByReference,
  isRequestUriError,
  resolveRequestUriParams,
} from '@maronn-openid-connect/core';
import type { ProviderConfig, RegisteredClient } from '../../../config.js';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'fetch-request-uri',
  endpoint: 'authorize',
  feature: 'request-object',
  kind: 'resolve',
  label: 'request_uri からリクエストオブジェクトを取得する',
  spec: 'OIDC Core 1.0 §6.2',
  function: 'fetchRequestUri',
  consumes: ['params', 'client'],
  produces: ['params'],
  removable: false,
});

/**
 * `request_uri` が指すリクエストオブジェクトを取得し、`request_uri` を `request` に置き換えたパラメータを返す。
 *
 * `request_uri` がないときと、`config.requestUriParameterSupported` が無効なときは、`params` をそのまま返す。
 * 無効なときに残った `request_uri` は、後の `validate-request` のステップが `request_uri_not_supported` で拒否する。
 * PAR の URN の `request_uri` は、前の `resolve-pushed-request` のステップが展開しているので、ここに来るのは URL だけである。
 *
 * 取得は core の `fetchRequestObjectByReference()` が、宛先を検査してから、フラグメントを除いた URL を、リダイレクトに従わず、タイムアウトと本文の上限を付けて 1 回だけ行う（設定の `requestUriTimeoutMs`、`requestUriMaxBytes`、`requestUriMaxLength`、`allowInsecureRequestUri`）。
 * fetch は `OidcProviderOptions.outboundFetch` で差し替えられる。
 * `config.requireRequestUriRegistration` が有効なら、クライアントが登録した `requestUris` と完全に一致しない `request_uri` を取得せずに拒否する。
 * 取得した JWT は、次の `resolve-request-object` のステップが、値で渡したリクエストオブジェクトと同じ規則（署名、alg、`allowUnsignedRequestObject`）で検証する。
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
export async function fetchRequestUri(
  c: any,
  params: AuthorizationRequestInput,
  client: RegisteredClient,
): Promise<AuthorizationRequestInput> {
  const config: ProviderConfig = c.get('config');
  if (params.request_uri === undefined || !config.requestUriParameterSupported) {
    return params;
  }
  const outboundFetch: typeof fetch | undefined = c.get('outboundFetch');
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
  return resolved as AuthorizationRequestInput;
}

/** ログに書くための `request_uri` のホストを返し、URL として読めなければ `(an invalid URL)` を返す。 */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return '(an invalid URL)';
  }
}
