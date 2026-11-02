import { TokenError } from '@maronn-openid-connect/core';
import { TokenEndpointError } from '../response.js';
import { respondToken } from './respond.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'token',
  kind: 'respond',
  label: 'Respond with the OAuth error',
  spec: 'RFC 6749 §5.2 / RFC 6750 §3',
  function: 'respondTokenError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * ステップの失敗に、OAuth のエラーレスポンスで応答する。
 *
 * 投げられた値によって、次のように応答する。
 * - `TokenEndpointError`: ステップが決めたレスポンス（400 の不正なリクエスト、500 のサーバーの設定の誤り、機能が扱うグラントのエラー）をそのまま返す。
 * - `TokenError`: そのステータスコード（`invalid_client` は 401、ほかは 400）と `error`、`error_description` で応答し、401 のときは `WWW-Authenticate` ヘッダーを付ける。
 * - それ以外: 500 の `server_error` で応答する。
 *
 * どのレスポンスにも `Cache-Control: no-store` を付ける。
 *
 * @spec RFC 6749 §5.2
 * @spec RFC 6750 §3
 * @spec OAuth 2.1 §5.2
 */
export function respondTokenError(c: any, error: unknown): Response {
  // ステップがレスポンス全体を決めたエラー（不正なリクエスト、サーバーの設定の誤り、機能が扱うグラントのエラー）には、そのレスポンスをそのまま返す。
  if (error instanceof TokenEndpointError) {
    return respondToken(c, error.response);
  }
  if (error instanceof TokenError) {
    // 401 のレスポンスには `WWW-Authenticate` ヘッダーを付ける（RFC 6750 §3、OAuth 2.1 §5.2）。
    return respondToken(c, {
      status: error.statusCode,
      body: { error: error.error, error_description: error.errorDescription },
      headers: error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
    });
  }
  // それ以外のエラーには 500 の `server_error` で応答し、このレスポンスもキャッシュさせない（RFC 6749 §5.2）。
  return respondToken(c, { status: 500, body: { error: 'server_error' } });
}
