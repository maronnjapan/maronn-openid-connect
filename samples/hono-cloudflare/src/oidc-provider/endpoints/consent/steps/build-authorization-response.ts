import type { AuthTransaction } from '@maronn-openid-connect/core';
import { buildClearedTransactionCookie } from '../../../cookies.js';
import {
  plainQueryResponse,
  restoreResponseMode,
  type ResponseModeTransaction,
} from '../../authorize/response-mode.js';
import type { ConsentOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'build-authorization-response',
  endpoint: 'consent',
  kind: 'transform',
  label: '認可レスポンスを組み立てる',
  spec: 'RFC 9207 §2',
  function: 'buildConsentRedirect',
  consumes: ['transaction', 'responseParams', 'authCodeData', 'issuer'],
  produces: ['outcome'],
  removable: false,
});

/**
 * 認可レスポンスを、求められたレスポンスモードで作る。
 *
 * `/authorize` のステップが機能のレスポンスモードをトランザクションに記録していれば、その機能がレスポンスモードを復元して認可レスポンスを作る（endpoints/authorize/response-mode.ts の `restoreResponseMode()`）。
 * 例えば JARM では、パラメータを署名して 1 つの `response` クエリパラメータにまとめ、その `iss` クレームが RFC 9207 の発行者を示す（JARM §2.3.1）。
 * `form_post` のレスポンスモード（OAuth 2.0 Form Post Response Mode）では、パラメータを HTML のフォームから送る。
 * 記録がなければ、パラメータをリダイレクト URI のクエリに入れ、`iss` を加える（RFC 9207 §2）。
 * `iss` があると、クライアントはレスポンスを返した発行者が想定どおりかを確かめられる。
 *
 * 返す結果には、トランザクションの Cookie を消す `Set-Cookie` の値を付ける。
 *
 * @throws {Error} トランザクションに記録されたレスポンスモードを、有効などの機能も扱わないとき（トランザクションの途中で設定が変わったときなど）。
 * @spec RFC 9207 §2
 */
export async function buildConsentRedirect(
  c: any,
  transaction: AuthTransaction,
  redirectUri: string,
  parameters: Record<string, string | undefined>,
  issuer: string,
): Promise<ConsentOutcome> {
  const responseMode = restoreResponseMode(c, transaction as ResponseModeTransaction);
  const response = responseMode
    ? await responseMode.respond(redirectUri, parameters)
    : plainQueryResponse(redirectUri, parameters, issuer);
  return { kind: 'authorization_response', response, cookies: [buildClearedTransactionCookie()] };
}
