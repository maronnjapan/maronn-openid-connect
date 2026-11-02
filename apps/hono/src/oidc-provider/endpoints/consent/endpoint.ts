import { defineEndpoint } from '../step.js';

/**
 * GET ではトランザクションの同意画面を描画し、POST ではエンドユーザーの決定に応じた認可レスポンスをクライアントへ返す。
 * 承認なら認可コード（インプリシットフローとハイブリッドフローでは ID トークンやアクセストークン）を発行して同意を記録し、拒否なら `access_denied` を返す。
 *
 * 認可レスポンスは、認可リクエストが求めたレスポンスモードで返す。
 * フォームが別オリジンから送られたとき、トランザクションが見つからないとき、`csrf_token` が一致しないとき、決定の値が `approve` でも `deny` でもないとき、ログインが済んでいないときは、クライアントへリダイレクトせず、OP のエラーページで応答する。
 *
 * @spec OIDC Core 1.0 §3.1.2.4
 */
export const endpoint = defineEndpoint({
  id: 'consent',
  order: 60,
  label: '同意画面',
  path: '/consent',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'authorization-code', label: '認可コードフロー' },
  spec: 'OIDC Core 1.0 §3.1.2.4',
  rearrangeable: false,
  steps: [
    'load-transaction',
    'describe-consent-screen',
    'reject-cross-origin-post',
    'validate-csrf-token',
    'deny-authorization',
    'validate-decision',
    'require-authenticated-subject',
    'issue-implicit-response',
    'issue-hybrid-response',
    'issue-authorization-code',
    'record-consent',
    'build-authorization-response',
  ],
  edges: {
    chain: false,
    extra: [
      { from: 'load-transaction', to: 'describe-consent-screen', label: 'GET', kind: 'flow' },
      { from: 'reject-cross-origin-post', to: 'load-transaction', label: 'POST', kind: 'flow' },
      { from: 'load-transaction', to: 'validate-csrf-token', label: 'POST', kind: 'flow' },
      { from: 'validate-csrf-token', to: 'deny-authorization', label: 'action=deny', kind: 'branch' },
      { from: 'validate-csrf-token', to: 'validate-decision', label: 'action=approve', kind: 'branch' },
      { from: 'validate-decision', to: 'require-authenticated-subject', kind: 'flow' },
      { from: 'require-authenticated-subject', to: 'issue-implicit-response', label: 'id_token / id_token token', kind: 'branch' },
      { from: 'require-authenticated-subject', to: 'issue-hybrid-response', label: 'code id_token / code token / code id_token token', kind: 'branch' },
      { from: 'require-authenticated-subject', to: 'issue-authorization-code', kind: 'flow' },
      { from: 'issue-authorization-code', to: 'record-consent', kind: 'flow' },
      { from: 'record-consent', to: 'build-authorization-response', kind: 'flow' },
    ],
  },
  journeys: [
    { from: 'consent', to: 'token', label: 'code', kind: 'flow', order: 90 },
  ],
});
