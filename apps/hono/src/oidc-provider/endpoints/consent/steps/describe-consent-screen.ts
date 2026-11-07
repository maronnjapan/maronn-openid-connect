import type { AuthTransaction } from '@maronn-openid-connect/core';
import { resolveClientDisplay } from '../../../client-display.js';
import { resolveGrantableScopes } from '../../../scopes.js';
import type { ConsentScreen } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'describe-consent-screen',
  endpoint: 'consent',
  kind: 'transform',
  label: '同意画面の表示内容を組み立てる',
  spec: 'OIDC Dynamic Client Registration 1.0 §2',
  function: 'describeConsentScreen',
  consumes: ['transactionId', 'transaction'],
  produces: ['screen'],
  removable: false,
});

/**
 * 同意フォームに表示する内容を返す。
 *
 * 内容は、トランザクションの `csrf_token`、クライアントの表示（`client_id` を含む）、エンドユーザーに許可を求めるスコープである。
 * クライアントの表示は、`clientResolver` で引いたクライアントの `client_name`、`logo_uri`、`policy_uri`、`tos_uri`、`client_uri` で、表示してよい URL だけに絞る（client-display.ts の `resolveClientDisplay()`、OIDC Dynamic Client Registration 1.0 §2 / §9.1）。
 * スコープは、要求されたもののうち、このエンドユーザーに許可できるものに絞る。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 */
export async function describeConsentScreen(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<ConsentScreen> {
  // 表示するスコープは、このエンドユーザーが実際に許可できるものに絞る（scopes.ts の `resolveGrantableScopes()`）。
  // サブジェクトは、`/login`（SSO でログイン画面を省いたときは `/authorize`）がこのトランザクションのために保存した認証セッションから読む。
  // 認証セッションがなければ絞り込みに使うサブジェクトがないので、要求されたスコープをそのまま表示する。
  // その場合は、`submitConsent()` が同じ認証セッションの欠落で処理を止める。
  const authSessionStore = c.get('authSessionStore');
  const consentSession = await authSessionStore.get(transactionId);
  const requestedScopes = transaction.scope.split(' ').filter(Boolean);
  const displayedScopes = consentSession
    ? await resolveGrantableScopes(requestedScopes, consentSession.subject)
    : requestedScopes;

  return {
    kind: 'screen',
    csrfToken: transaction.csrfToken,
    scopes: displayedScopes,
    client: await resolveClientDisplay(c.get('clientResolver'), c.get('config'), transaction.clientId),
  };
}
