import { IntrospectionError, TokenError } from '@maronn-openid-connect/core';
import { IntrospectionEndpointError } from '../response.js';
import { respondIntrospection } from './respond.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'introspection',
  feature: 'introspection',
  kind: 'respond',
  label: 'OAuth のエラーレスポンスで応答する',
  spec: 'RFC 7662 §2.3',
  function: 'respondIntrospectionError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * ステップの失敗に、OAuth のエラーレスポンスで応答する。
 *
 * 投げられた値によって、次のように応答する。
 * - `IntrospectionEndpointError`: ステップが決めたレスポンス（400 の不正なリクエスト）をそのまま返す。
 * - `TokenError` と `IntrospectionError`: そのステータスコード（`invalid_client` は 401、ほかは 400）と `error`、`error_description` で応答し、401 のときは `WWW-Authenticate` ヘッダーを付ける。
 * - それ以外: 500 の `server_error` で応答する。
 *
 * どのレスポンスにも `Cache-Control: no-store` を付ける。
 *
 * @spec RFC 7662 §2.3
 * @spec RFC 6749 §5.2
 */
export function respondIntrospectionError(c: any, error: unknown): Response {
  if (error instanceof IntrospectionEndpointError) {
    return respondIntrospection(c, error.response);
  }
  if (error instanceof TokenError || error instanceof IntrospectionError) {
    return respondIntrospection(c, {
      status: error.statusCode,
      body: { error: error.error, error_description: error.errorDescription },
      headers: error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
    });
  }
  return respondIntrospection(c, { status: 500, body: { error: 'server_error' } });
}
