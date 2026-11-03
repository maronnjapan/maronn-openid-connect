import {
  isHybridResponseType,
  requireHybridNonce,
  validateHybridResponseMode,
  type AuthorizationRequestParams,
  type ValidatedAuthorizationRequest,
} from '@maronn-openid-connect/core';
import type { AuthorizationResponseMode } from '../../../endpoints/authorize/response-mode.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'validate-hybrid-request',
  endpoint: 'authorize',
  feature: 'hybrid-flow',
  kind: 'validate',
  label: 'ハイブリッドフローのリクエストを検証する',
  spec: 'OIDC Core 1.0 §3.3.2.1 / §3.3.2.11 / OAuth 2.0 Multiple Response Type Encoding Practices §5',
  function: 'validateHybridRequest',
  consumes: ['validatedRequest', 'params', 'effectiveParams', 'responseMode'],
  optional: ['effectiveParams', 'responseMode'],
  produces: [],
  removable: false,
});

/**
 * ハイブリッドフローに固有の条件を検証する。
 *
 * `response_type` がハイブリッドフローのもの（`code id_token`、`code token`、`code id_token token`）でなければ、何もしない。
 * 検証はトランザクションを作る前に行い、次の条件をそれぞれ core の関数で確かめる。
 * - トークンをクエリに含めないよう、`response_mode=query` を拒否する（OAuth 2.0 Multiple Response Type Encoding Practices §5、§7）。
 * - OP がこのリクエストに使うレスポンスモード（`responseMode`）と異なる `response_mode`（JARM の `query.jwt` や未知の値）も、フラグメントに置き換えずに拒否する。
 * - 認可エンドポイントが ID トークンを返す `code id_token` と `code id_token token` では `nonce` を必須とし、`code token` では認可コードフローと同じく任意とする（OIDC Core 1.0 §3.3.2.11）。
 *
 * 違反には、リダイレクトで返せる `invalid_request` を投げる。
 * パイプラインは、このエラーをリクエストのレスポンスモード（既定はフラグメント）でクライアントへ返す（OIDC Core 1.0 §3.3.2.6）。
 *
 * `redirect_uri` と PKCE はここでは検証しない。
 * `redirect_uri` の規則は認可コードフローと同じであり（OIDC Core 1.0 §3.3.2.1 が §3.1.2.1 を参照する）、PKCE のパラメータは `validate-request` ステップが検証済みだからである。
 *
 * @throws {AuthorizationError} `invalid_request`: 上のどれかの条件に違反するとき。
 * @spec OIDC Core 1.0 §3.3.2.11
 */
export function validateHybridRequest(
  validatedRequest: ValidatedAuthorizationRequest,
  params: AuthorizationRequestParams,
  responseMode: AuthorizationResponseMode | undefined,
): void {
  if (!isHybridResponseType(validatedRequest.responseType)) return;
  const { redirectUri, state } = validatedRequest;

  const requested = (params as { response_mode?: unknown }).response_mode;
  validateHybridResponseMode(
    typeof requested === 'string' ? requested : undefined,
    responseMode === undefined ? [] : [responseMode.name],
    redirectUri,
    state,
  );
  requireHybridNonce(validatedRequest.responseType, validatedRequest.nonce, redirectUri, state);
}
