import {
  isImplicitResponseType,
  requireNonce,
  validateImplicitRedirectUri,
  validateImplicitResponseMode,
  type AuthorizationRequestParams,
  type ClientInfo,
  type ValidatedAuthorizationRequest,
} from '@maronn-openid-connect/core';
import type { AuthorizationResponseMode } from '../../../endpoints/authorize/response-mode.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'validate-implicit-request',
  endpoint: 'authorize',
  feature: 'implicit-flow',
  kind: 'validate',
  label: 'インプリシットフローのリクエストを検証する',
  spec: 'OIDC Core 1.0 §3.2.2.1 / OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5',
  function: 'validateImplicitRequest',
  consumes: ['validatedRequest', 'params', 'effectiveParams', 'client', 'responseMode'],
  optional: ['effectiveParams', 'responseMode'],
  produces: [],
  removable: false,
});

/**
 * インプリシットフローに固有の条件を検証する。
 *
 * `response_type` がインプリシットフローのもの（`id_token` か `id_token token`）でなければ、何もしない。
 * 検証はトランザクションを作る前に行い、次の条件をそれぞれ core の関数で確かめる。
 * - トークンをクエリに含めないよう、`response_mode=query` を拒否する（OAuth 2.0 Multiple Response Type Encoding Practices §3、§5、§7）。
 * - OP がこのリクエストに使うレスポンスモード（`responseMode`）と異なる `response_mode`（JARM の `query.jwt` や未知の値）も、フラグメントに置き換えずに拒否する。
 * - `nonce` を必須とする（OIDC Core 1.0 §3.2.2.1）。
 * - `redirect_uri` に `http` のスキームを使えるのは、パブリック（ネイティブ）クライアントがループバックのホストを指定したときだけとする（OIDC Core 1.0 §3.2.2.1）。
 *
 * 違反には、リダイレクトで返せる `invalid_request` を投げる。
 * パイプラインは、このエラーをリクエストのレスポンスモード（既定はフラグメント）でクライアントへ返す（OIDC Core 1.0 §3.2.2.6）。
 *
 * @throws {AuthorizationError} `invalid_request`: 上のどれかの条件に違反するとき。
 * @spec OIDC Core 1.0 §3.2.2.1
 */
export function validateImplicitRequest(
  validatedRequest: ValidatedAuthorizationRequest,
  params: AuthorizationRequestParams,
  client: ClientInfo,
  responseMode: AuthorizationResponseMode | undefined,
): void {
  if (!isImplicitResponseType(validatedRequest.responseType)) return;
  const { redirectUri, state } = validatedRequest;

  const requested = (params as { response_mode?: unknown }).response_mode;
  validateImplicitResponseMode(
    typeof requested === 'string' ? requested : undefined,
    responseMode === undefined ? [] : [responseMode.name],
    redirectUri,
    state,
  );
  requireNonce(validatedRequest.nonce, redirectUri, state);
  validateImplicitRedirectUri(redirectUri, client.clientType, state);
}
