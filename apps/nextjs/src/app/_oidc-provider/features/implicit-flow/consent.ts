/**
 * The (feature: implicit-flow) block of consent/decision/route.ts: the
 * End-User approved a request of the Implicit Flow (response_type=id_token or
 * id_token token), which gets its tokens in place of the code.
 */
import {
  AuthorizationError,
  completeAuthTransaction,
  isImplicitResponseType,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import {
  respondToClient,
  type AuthorizationResponseMode,
  type AuthorizationResponseParameters,
} from '../../../authorize/response-mode';
import { buildClearedTransactionCookie } from '../../cookies';
import { redirectToErrorPage } from '../../http';
import { config, loadSigningKeys, resolvers, stores } from '../../provider';
import { resolveGrantableScopes } from '../../scopes';
import type { AuthSessionInfo } from '../../store';
import { implicitResponseModeOf } from './response-mode';
import { issueImplicitTokens } from './tokens';

/**
 * トークンを発行し、認可レスポンスで応答する。
 *
 * 対象は、エンドユーザーが同意したインプリシットフローのリクエスト（`response_type` が `id_token` か `id_token token`）である。
 * ほかのレスポンスタイプには `undefined` を返し、あとのブロック（ハイブリッドフローか認可コードの発行）に任せる。
 *
 * トランザクションを終え、同意されたスコープで ID トークン（`id_token token` ではアクセストークンも）を発行し、同意とグラントを記録する。
 * トークンの発行が `AuthorizationError` で失敗したときは、同意とグラントを記録せず、そのエラーを認可レスポンスで返す。
 * 署名鍵を読み込めないときは、トランザクションを終える前に、OP のエラーページへ `server_error` で 303 のリダイレクトをする。
 *
 * 認可レスポンスは `responseMode`（ルートハンドラがトランザクションから復元したもの）で返し、ないときはフラグメントで返す（OIDC Core 1.0 §3.2.2.5）。
 * クエリでは返さない。
 * 応答には、トランザクションの Cookie を消す `Set-Cookie` ヘッダーを付ける。
 *
 * @spec OIDC Core 1.0 §3.2.2.5
 */
export async function issueImplicitConsentResponse(input: {
  transactionId: string;
  transaction: AuthTransaction;
  session: AuthSessionInfo;
  responseMode: AuthorizationResponseMode | undefined;
}): Promise<Response | undefined> {
  const { transactionId, transaction, session } = input;
  if (!isImplicitResponseType(transaction.responseType)) return undefined;

  const responseMode = implicitResponseModeOf(input.responseMode, config.issuer);
  const answer = async (parameters: AuthorizationResponseParameters): Promise<Response> =>
    // トランザクションは終わったので、それを指す Cookie を消す。
    respondToClient(await responseMode.respond(transaction.redirectUri, parameters), [buildClearedTransactionCookie()]);

  // 何かを記録する前に、署名鍵を読み込む。
  // 読み込めないときは、レスポンスモードの復元に失敗したときと同じく、ここで止める。
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return redirectToErrorPage('server_error', 'Failed to load the signing keys');

  const responseParams = await completeAuthTransaction(transactionId, transaction, stores.transactionStore);
  // 要求されたスコープを、このエンドユーザーに与えてよいものに絞る（`scopes.ts` の `resolveGrantableScopes()`）。
  // 承認したときに `issue-authorization-code` のブロックが認可コードに対して行うのと同じ絞り込みである。
  // 取り除いたスコープはグラントに含めず、レスポンスの `scope` で実際のスコープを伝える（RFC 6749 §3.3）。
  const grantedScope = await resolveGrantableScopes(transaction.scope.split(' ').filter(Boolean), session.subject);

  let issued;
  try {
    issued = await issueImplicitTokens({
      responseType: transaction.responseType,
      responseParams,
      session,
      grantedScope,
      keys,
    });
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return answer({ error: error.error, error_description: error.errorDescription, state: transaction.state });
  }

  // 同意を記録し、あとの `prompt=none`（または SSO）のリクエストが画面なしで同意を確かめられるようにする（OIDC Core 1.0 §3.1.2.1、§3.1.2.4）。
  // グラントも記録し、その同意を取り消したときにアクセストークンが失効するようにする。
  // 削除するのはトランザクションごとの引き継ぎだけで、OP のセッションは SSO のために残す。
  await resolvers.consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await resolvers.consentResolver.recordGrant(session.subject, transaction.clientId, issued.grantId);
  await stores.authSessionStore.delete(transactionId);

  return answer(issued.parameters);
}
