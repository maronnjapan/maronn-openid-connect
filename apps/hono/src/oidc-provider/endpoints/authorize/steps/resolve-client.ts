import {
  resolveClientForAuthorization,
  validateRegisteredRedirectUris,
  type ClientInfo,
} from '@maronn-openid-connect/core';
import type { AuthorizationRequestInput } from '../outcome.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-client',
  endpoint: 'authorize',
  kind: 'resolve',
  label: 'クライアントを特定する',
  spec: 'OAuth 2.1 §4.1.2.1 / RFC 8252 §8',
  function: 'resolveAuthorizationClient',
  consumes: ['params'],
  produces: ['client'],
  removable: false,
});

/**
 * `client_id` の登録済みクライアントを取得して返す。
 *
 * 取得したクライアントの登録済みのリダイレクト URI に設定の誤り（フラグメント、`javascript:` などの危険なスキーム、ループバック以外の `http`）があれば、この時点で失敗させる。
 *
 * ここで投げるエラーはリダイレクトできない。
 * OP にはまだ信頼できる `redirect_uri` が無いので、エラーは OP で応答する（OIDC Core 1.0 §3.1.2.2）。
 *
 * @throws {AuthorizationError} `invalid_request`: `client_id` が無いとき、または登録されていないとき。
 * @throws {AuthorizationError} `server_error`: クライアントリゾルバが別の `client_id` のクライアントを返したとき、または登録済みのリダイレクト URI に設定の誤りがあるとき。
 *
 * @spec OAuth 2.1 §4.1.2.1
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec RFC 8252 §8
 */
export async function resolveAuthorizationClient(
  c: any,
  params: AuthorizationRequestInput,
): Promise<ClientInfo> {
  const clientResolver = c.get('clientResolver');
  const client = await resolveClientForAuthorization(params, clientResolver);
  validateRegisteredRedirectUris(client.redirectUris);
  return client;
}
