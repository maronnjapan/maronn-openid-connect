import { ParError } from '@maronn-openid-connect/experimental/par';
import { ParEndpointError } from '../response.js';
import { respondPar } from './respond.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'par',
  feature: 'par',
  kind: 'respond',
  label: 'OAuth のエラーレスポンスで応答する',
  spec: 'RFC 9126 §2.3',
  function: 'respondParError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * ステップのエラーを、JSON のエラーレスポンスで返す。
 *
 * `ParEndpointError` には、前のステップが決めたレスポンス（400）をそのまま返す。
 * `ParError` には、そのステータスコード（`invalid_client` なら 401、それ以外は 400）で `error` と `error_description` を返し、`invalid_client` には `WWW-Authenticate` ヘッダーも付ける。
 * それ以外のエラーには、500 の `server_error` を返す。
 * エラーの形はトークンエンドポイントと同じで（RFC 9126 §2.3）、このエンドポイントはリダイレクトしない。
 *
 * @spec RFC 9126 §2.3
 */
export function respondParError(c: any, error: unknown): Response {
  if (error instanceof ParEndpointError) {
    return respondPar(c, error.response);
  }
  if (error instanceof ParError) {
    return respondPar(c, {
      status: error.statusCode,
      body: { error: error.code, error_description: error.errorDescription },
      headers: error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
    });
  }
  return respondPar(c, { status: 500, body: { error: 'server_error' } });
}
