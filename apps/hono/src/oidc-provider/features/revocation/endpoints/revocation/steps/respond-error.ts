import { RevocationError, TokenError } from '@maronn-openid-connect/core';
import { RevocationEndpointError, noStore } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'revocation',
  feature: 'revocation',
  kind: 'respond',
  label: 'Respond with the OAuth error',
  spec: 'RFC 7009 §2.2.1',
  function: 'respondRevocationError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * ステップの失敗に、OAuth のエラーレスポンスで応答する。
 *
 * 投げられた値によって、次のように応答する。
 * - `RevocationEndpointError`: ステップが決めたレスポンス（400 の不正なリクエスト）を、そのヘッダーとともにそのまま返す。
 * - `TokenError` と `RevocationError`: そのステータスコード（`invalid_client` は 401、ほかは 400）と `error`、`error_description` で応答し、401 のときは `WWW-Authenticate` ヘッダーを付ける。
 * - それ以外: 500 の `server_error` で応答する。
 *
 * どのレスポンスにも `Cache-Control: no-store` を付ける。
 *
 * @spec RFC 7009 §2.2.1
 * @spec RFC 6749 §5.2
 */
export function respondRevocationError(c: any, error: unknown): Response {
  noStore(c);
  if (error instanceof RevocationEndpointError) {
    for (const [name, value] of Object.entries(error.response.headers ?? {})) {
      c.header(name, value);
    }
    return c.json(error.response.body, error.response.status);
  }
  if (error instanceof TokenError || error instanceof RevocationError) {
    if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
    return c.json(
      { error: error.error, error_description: error.errorDescription },
      error.statusCode,
    );
  }
  return c.json({ error: 'server_error' }, 500);
}
