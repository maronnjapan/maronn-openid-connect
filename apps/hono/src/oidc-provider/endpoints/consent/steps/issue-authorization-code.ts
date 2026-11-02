import {
  completeAuthTransaction,
  createAuthorizationCode,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import type { AuthSessionInfo } from '../../../store.js';
import { resolveGrantableScopes } from '../../../scopes.js';
import type { ConsentedAuthorization } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'issue-authorization-code',
  endpoint: 'consent',
  kind: 'issue',
  label: '認可コードを発行する',
  spec: 'OIDC Core 1.0 §3.1.2.5 / §3.1.3.1',
  function: 'issueConsentedAuthorizationCode',
  consumes: ['transactionId', 'transaction', 'session'],
  produces: ['responseParams', 'authCodeData', 'grantedScope'],
  removable: false,
});

/**
 * 認可コードを発行してストアに保存する。
 *
 * まずトランザクションをストアから削除し（同じトランザクションで認可コードを二度発行しないため）、許可するスコープに対して認可コードを発行する。
 * 認可コードの有効期間は `config.authorizationCodeTtl` 秒（既定では 300 秒）である。
 * 認可レスポンスのパラメータ、認可コードのデータ、許可したスコープを返す。
 *
 * `transaction.scope` は、認可リクエストを検証したときに `applyOfflineAccessPolicy` を通っている。
 * `offline_access` を許可できるか（OIDC Core 1.0 §11 の `prompt=consent` と、クライアントが登録した `grant_types` に `refresh_token` があること）はそこで決まっているので、ここでは絞り直さない。
 *
 * @spec OIDC Core 1.0 §3.1.2.5
 * @spec OIDC Core 1.0 §3.1.3.1
 */
export async function issueConsentedAuthorizationCode(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  session: AuthSessionInfo,
): Promise<ConsentedAuthorization> {
  const config = c.get('config');
  const transactionStore = c.get('transactionStore');
  const authCodeStore = c.get('authCodeStore');
  const responseParams = await completeAuthTransaction(transactionId, transaction, transactionStore);
  // スコープの方針（エンドユーザーごとの絞り込みを書く scopes.ts の `resolveGrantableScopes()`）を適用する。
  // スコープを外しても、リクエストを失敗にはせず、許可するスコープを狭めるだけである。
  // 認可サーバーは要求より狭いスコープを発行してよく、許可したスコープはトークンレスポンスで伝わるためである（RFC 6749 §3.3）。
  const grantedScope = await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    session.subject,
  );
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // `offline_access` のない認可で発行するリフレッシュトークンを、このログインセッション（ログインのステップが認証セッションに載せた `sessionId`）に結び付ける。
    // ログアウトすると、そのリフレッシュトークンも使えなくなる。
    sessionId: session.sessionId,
    ttlSeconds: config.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);
  return { responseParams, authCodeData, grantedScope };
}
