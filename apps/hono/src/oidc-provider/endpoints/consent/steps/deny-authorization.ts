import type { AuthTransaction } from '@maronn-openid-connect/core';
import type { ConsentOutcome } from '../screen.js';
import { buildConsentRedirect } from './build-authorization-response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'deny-authorization',
  endpoint: 'consent',
  kind: 'respond',
  label: 'Deny: answer access_denied',
  spec: 'OIDC Core 1.0 §3.1.2.6',
  function: 'denyAuthorizationRequest',
  consumes: ['transactionId', 'transaction', 'issuer'],
  produces: ['outcome'],
  removable: false,
});

/**
 * トランザクションを削除し、`access_denied` を返す。
 *
 * エンドユーザーが拒否したときに呼ぶ。
 * ストアからトランザクションと認証セッションを削除し、`error=access_denied` と `state` を含む認可レスポンスを返す。
 * 認可レスポンスには、トランザクションの Cookie を消す `Set-Cookie` の値を付ける。
 *
 * @spec OIDC Core 1.0 §3.1.2.6
 */
export async function denyAuthorizationRequest(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  issuer: string,
): Promise<ConsentOutcome> {
  const transactionStore = c.get('transactionStore');
  const authSessionStore = c.get('authSessionStore');
  await transactionStore.delete('auth_txn:' + transactionId);
  await authSessionStore.delete(transactionId);
  // エラーも、認可リクエストが求めたレスポンスモードで返す。
  // JARM ではエラーにも署名するので（JARM §2.1）、クライアントは、拒否したのが信頼している OP であることを検証できる。
  return buildConsentRedirect(c, transaction, transaction.redirectUri, {
    error: 'access_denied',
    state: transaction.state,
  }, issuer);
}
