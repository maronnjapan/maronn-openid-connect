import {
  AuthorizationError,
  completeAuthTransaction,
  isHybridResponseType,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import { buildClearedTransactionCookie } from '../../../cookies.js';
import {
  restoreResponseMode,
  type AuthorizationResponseParameters,
  type ResponseModeTransaction,
} from '../../../endpoints/authorize/response-mode.js';
import type { ConsentOutcome } from '../../../endpoints/consent/screen.js';
import { recordConsentDecision } from '../../../endpoints/consent/steps/record-consent.js';
import { step } from '../../../endpoints/step.js';
import { resolveGrantableScopes } from '../../../scopes.js';
import type { AuthSessionInfo } from '../../../store.js';
import { createFragmentResponseMode } from '../../implicit-flow/response-mode.js';
import { issueHybridTokens } from '../tokens.js';

export const meta = step({
  id: 'issue-hybrid-response',
  endpoint: 'consent',
  feature: 'hybrid-flow',
  kind: 'dispatch',
  label: 'Hybrid Flow: issue the code together with the ID Token and/or the access token',
  spec: 'OIDC Core 1.0 §3.3.2.5',
  function: 'issueHybridConsentResponse',
  consumes: ['transactionId', 'transaction', 'session', 'issuer'],
  produces: ['outcome'],
  removable: false,
});

/**
 * 認可コードとトークンを発行し、認可レスポンスで返す。
 *
 * 対象は、エンドユーザーが同意したハイブリッドフローのリクエスト（`response_type` が `code id_token`、`code token`、`code id_token token`）である。
 * ほかのレスポンスタイプには `undefined` を返し、あとのステップ（認可コードの発行）に任せる。
 *
 * トランザクションを終え、同意されたスコープで認可コードと ID トークンかアクセストークン（または両方）を発行し、同意とグラントを記録する。
 * トークンの発行が `AuthorizationError` で失敗したときは、同意とグラントを記録せず、そのエラーを認可レスポンスで返す。
 *
 * 認可レスポンスは、トランザクションに保存したレスポンスモードで返し、保存がなければフラグメントで返す（OIDC Core 1.0 §3.3.2.5）。
 * クエリでは返さない。
 * 返す結果には、トランザクションの Cookie を消す `Set-Cookie` の値も含める。
 *
 * @throws {Error} トランザクションに保存したレスポンスモードを扱う機能が有効でないとき（`restoreResponseMode()`）。
 * @spec OIDC Core 1.0 §3.3.2.5
 */
export async function issueHybridConsentResponse(
  c: any,
  input: {
    transactionId: string;
    transaction: AuthTransaction;
    session: AuthSessionInfo;
    issuer: string;
  },
): Promise<ConsentOutcome | undefined> {
  const { transactionId, transaction, session, issuer } = input;
  if (!isHybridResponseType(transaction.responseType)) return undefined;

  const responseMode =
    restoreResponseMode(c, transaction as ResponseModeTransaction) ?? createFragmentResponseMode({ issuer });
  const answer = async (parameters: AuthorizationResponseParameters): Promise<ConsentOutcome> => ({
    kind: 'authorization_response',
    response: await responseMode.respond(transaction.redirectUri, parameters),
    // トランザクションは終わったので、それを指す Cookie を消す。
    cookies: [buildClearedTransactionCookie()],
  });

  const responseParams = await completeAuthTransaction(transactionId, transaction, c.get('transactionStore'));
  // 要求されたスコープを、このエンドユーザーに与えてよいものに絞る（`scopes.ts` の `resolveGrantableScopes()`）。
  // `issue-authorization-code` ステップが認可コードに対して行うのと同じ絞り込みである。
  // 取り除いたスコープはグラントに含めず、レスポンスの `scope` で実際のスコープを伝える（RFC 6749 §3.3）。
  const grantedScope = await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    session.subject,
  );

  let issued;
  try {
    issued = await issueHybridTokens(c, {
      responseType: transaction.responseType,
      responseParams,
      session,
      grantedScope,
    });
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return answer({ error: error.error, error_description: error.errorDescription, state: transaction.state });
  }

  // 同意とグラントを記録し、ログインのステップから引き継いだ情報を削除する。
  // 認可コードを発行したあとに `record-consent` ステップが行うのと同じ処理である。
  await recordConsentDecision(c, transactionId, transaction, session, issued, grantedScope);
  return answer(issued.parameters);
}
