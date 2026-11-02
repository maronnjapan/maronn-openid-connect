import { AuthorizationError } from '@maronn-openid-connect/core';
import { type AuthorizationOutcome, buildErrorResponse } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'authorize',
  kind: 'respond',
  label: 'Map a failure to a redirectable or on-OP error',
  spec: 'OIDC Core 1.0 §3.1.2.6 / §3.1.2.2',
  function: 'authorizationErrorOutcome',
  consumes: ['responseMode'],
  optional: ['responseMode'],
  produces: [],
  removable: false,
});

/**
 * ステップが投げた例外を、処理結果に変えて返す。
 *
 * 例外は、次のように結果に変える。
 * - `redirectUri` がある `AuthorizationError`: `state` と `iss` を付けたエラーの認可レスポンス（RFC 9207 §2）
 * - `redirectUri` が無い `AuthorizationError`: OP で応答するエラー
 * - それ以外の例外: `server_error`
 *
 * `redirectUri` が無いのは、`redirect_uri` を確かめる前に投げたエラー（未知の `client_id`、登録されていない `redirect_uri`、フラグメントを含む `redirect_uri`）である（OIDC Core 1.0 §3.1.2.2）。
 *
 * リクエストが機能のレスポンスモードを求めていたときは、エラーもそのモードで返す。
 * 例えば JARM ではエラーのパラメータを一つの JWT に入れて署名し（JARM §2.1）、`form_post` のレスポンスモードではそれを HTML のフォームからブラウザに送らせる。
 * `response_mode` を読み取る前に投げたエラー（未知のクライアント、対応していない JWT のモードなど）では `responseMode` が `undefined` なので、そのエラーはレスポンスモードを使わずに返す。
 */
export async function authorizationErrorOutcome(
  c: any,
  error: unknown,
  responseMode: AuthorizationResponseMode | undefined,
): Promise<AuthorizationOutcome> {
  if (error instanceof AuthorizationError) {
    if (error.redirectUri) {
      return {
        kind: 'authorization_response',
        response: await buildErrorResponse(
          responseMode,
          error.redirectUri,
          error.error,
          error.state,
          error.errorDescription,
          c.get('config').issuer,
        ),
      };
    }
    // リダイレクトできないエラーは、リクエストの `redirect_uri` へリダイレクトせず、OP で応答する結果にする（OIDC Core 1.0 §3.1.2.2）。
    // `page.ts` は、`Accept: application/json` の呼び出し元には JSON の OAuth のエラーレスポンスで、ブラウザには OP のエラー画面で応答する。
    return { kind: 'error', error: error.error, errorDescription: error.errorDescription };
  }
  return { kind: 'server_error' };
}
