import { defineEndpoint } from '../../_oidc-provider/endpoint';

/**
 * 同意フォームから送られたエンドユーザーの決定を受け取り、認可レスポンスをクライアントへ返す。
 * 承認なら認可コード（インプリシットフローとハイブリッドフローでは ID トークンやアクセストークン）を発行して同意を記録し、拒否なら `access_denied` を返す。
 *
 * 認可レスポンスは認可リクエストが求めたレスポンスモードで返し、トランザクションの Cookie を消す。
 * フォームが別オリジンから送られたとき、トランザクションが見つからないとき、`csrf_token` が一致しないとき、決定の値が `approve` でも `deny` でもないとき、レスポンスモードの署名鍵を読み込めないときは、OP のエラーページへリダイレクトする。
 * ログインが済んでいないときは `/login` へリダイレクトする。
 *
 * @spec OIDC Core 1.0 §3.1.2.4
 */
export const endpoint = defineEndpoint({
  path: '/consent/decision',
  steps: [
    { id: 'reject-cross-origin-post', consumes: [], produces: [] },
    { id: 'load-transaction', consumes: [], produces: ['form', 'action', 'transactionId', 'transaction'] },
    { id: 'validate-csrf-token', consumes: ['form', 'transaction'], produces: [] },
    { id: 'restore-response-mode', consumes: ['transaction'], produces: ['responseMode'] },
    { id: 'deny-authorization', consumes: ['action', 'transactionId', 'transaction', 'responseMode'], produces: [] },
    { id: 'validate-decision', consumes: ['action'], produces: [] },
    { id: 'require-authenticated-subject', consumes: ['transactionId'], produces: ['session'] },
    { id: 'issue-implicit-response', feature: 'implicit-flow', consumes: ['transactionId', 'transaction', 'session', 'responseMode'], produces: [] },
    { id: 'issue-hybrid-response', feature: 'hybrid-flow', consumes: ['transactionId', 'transaction', 'session', 'responseMode'], produces: [] },
    { id: 'issue-authorization-code', consumes: ['transactionId', 'transaction', 'session'], produces: ['responseParams', 'grantedScope', 'authCodeData'] },
    { id: 'record-granted-details', feature: 'rar', consumes: ['transactionId', 'authCodeData'], produces: [] },
    { id: 'record-consent', consumes: ['transactionId', 'transaction', 'session', 'grantedScope', 'authCodeData'], produces: [] },
    { id: 'build-authorization-response', consumes: ['transaction', 'responseParams', 'authCodeData', 'responseMode'], produces: [] },
  ],
});
