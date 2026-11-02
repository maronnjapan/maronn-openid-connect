import {
  type AuthorizationRequestParams,
  type ClientInfo,
  resolveAuthorizationRedirectUri,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-redirect-uri',
  endpoint: 'authorize',
  kind: 'resolve',
  label: 'redirect_uri を確定し、エラーの返し先を決める',
  spec: 'OIDC Core 1.0 §3.1.2.1 / RFC 6749 §4.1.2.1',
  function: 'resolveRedirectTarget',
  consumes: ['params', 'effectiveParams', 'client'],
  optional: ['effectiveParams'],
  produces: ['redirectUri', 'state'],
  removable: false,
});

/**
 * リダイレクト URI を確かめ、それと `state` を返す。
 *
 * リクエストに `redirect_uri` があれば、登録済みのリダイレクト URI のどれかと完全に一致することを確かめる（パブリッククライアントだけは、ループバックのアドレスでポートが違ってもよい）。
 * 無ければ、登録が一つのときはそれを使う。
 * ここで投げるエラーは、まだリダイレクト先を信頼できないので、OP で応答する。
 *
 * このステップより後のエラーはリダイレクトでき、リクエストの `state` と一緒にクライアントへ返す。
 * このステップより前のエラーは、すべて OP で応答する。
 *
 * @throws {AuthorizationError} `invalid_request`: `redirect_uri` がフラグメントを含むとき、登録されていないとき、または省略されたのに登録が複数あるとき。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec RFC 6749 §4.1.2.1
 */
export function resolveRedirectTarget(
  params: AuthorizationRequestParams,
  client: ClientInfo,
): { redirectUri: string; state: string | undefined } {
  const redirectUri = resolveAuthorizationRedirectUri(params, client);
  return { redirectUri, state: params.state };
}
