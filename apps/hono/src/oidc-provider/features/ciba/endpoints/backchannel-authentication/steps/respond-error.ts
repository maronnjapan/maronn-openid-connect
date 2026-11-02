import { TokenError } from '@maronn-openid-connect/core';
import { BackchannelAuthenticationError } from '@maronn-openid-connect/experimental/ciba';
import { BackchannelAuthenticationEndpointError, noStore } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'backchannel-authentication',
  feature: 'ciba',
  kind: 'respond',
  label: 'Respond with the OAuth error',
  spec: 'CIBA Core 1.0 §13',
  function: 'respondBackchannelAuthenticationError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * エラーに応じた OAuth のエラーレスポンスで応答する。
 *
 * ボディは `error` と `error_description` を持つ JSON で、どの場合も `noStore()` でキャッシュを禁じる（CIBA §13、RFC 6749 §5.2）。
 * エラーの種類ごとに、次のように応答する。
 * - `BackchannelAuthenticationEndpointError`（ステップが決めた固定のレスポンス）: そのステータス、ヘッダー、ボディのまま返す。
 * - `BackchannelAuthenticationError`（experimental パッケージが拒否したリクエスト）: 400 で返す。
 * - `TokenError`（core のクライアント認証の失敗）: そのステータス（`invalid_client` なら 401）で返し、`WWW-Authenticate` の値があればヘッダーに付ける。
 * - それ以外: 500 の `server_error` を返す。
 *
 * @spec CIBA Core 1.0 §13
 * @spec RFC 6749 §5.2
 */
export function respondBackchannelAuthenticationError(c: any, error: unknown): Response {
  noStore(c);
  if (error instanceof BackchannelAuthenticationEndpointError) {
    for (const [name, value] of Object.entries(error.response.headers ?? {})) {
      c.header(name, value);
    }
    return c.json(error.response.body, error.response.status);
  }
  if (error instanceof BackchannelAuthenticationError) {
    return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
  }
  if (error instanceof TokenError) {
    if (error.wwwAuthenticate) {
      c.header('WWW-Authenticate', error.wwwAuthenticate);
    }
    return c.json({ error: error.error, error_description: error.errorDescription }, error.statusCode);
  }
  return c.json({ error: 'server_error' }, 500);
}
