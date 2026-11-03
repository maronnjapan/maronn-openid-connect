import { defineEndpoint } from '../step.js';

/**
 * GET ではトランザクションのログイン画面を描画し、POST ではエンドユーザーを認証する。
 * 認証情報が合えば新しい OP のセッションを確立して同意画面へリダイレクトし、誤っていれば失敗を 1 回数えてログイン画面を再表示する。
 *
 * 失敗の回数が上限に達したとき（429）、フォームが別オリジンから送られたとき、トランザクションが見つからないとき、`csrf_token` が一致しないときは、OP のエラーページで応答する。
 *
 * @spec OIDC Core 1.0 §3.1.2.3
 */
export const endpoint = defineEndpoint({
  id: 'login',
  order: 40,
  label: 'ログイン画面',
  path: '/login',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'authorization-code', label: '認可コードフロー' },
  spec: 'OIDC Core 1.0 §3.1.2.3',
  rearrangeable: false,
  steps: [
    'load-transaction',
    'describe-login-screen',
    'reject-cross-origin-post',
    'validate-csrf-token',
    'authenticate-user',
    'record-login-failure',
    'discard-session-for-fresh-login',
    'establish-session',
    'hand-off-to-consent',
  ],
  edges: {
    chain: false,
    extra: [
      { from: 'load-transaction', to: 'describe-login-screen', label: 'GET', kind: 'flow' },
      { from: 'reject-cross-origin-post', to: 'load-transaction', label: 'POST', kind: 'flow' },
      { from: 'load-transaction', to: 'validate-csrf-token', label: 'POST', kind: 'flow' },
      { from: 'validate-csrf-token', to: 'authenticate-user', kind: 'flow' },
      { from: 'authenticate-user', to: 'record-login-failure', label: '認証情報の誤り', kind: 'branch' },
      { from: 'record-login-failure', to: 'describe-login-screen', label: '再試行', kind: 'branch' },
      { from: 'authenticate-user', to: 'discard-session-for-fresh-login', label: '認証済み', kind: 'branch' },
      { from: 'discard-session-for-fresh-login', to: 'establish-session', kind: 'flow' },
      { from: 'establish-session', to: 'hand-off-to-consent', kind: 'flow' },
    ],
  },
  journeys: [
    { from: 'login', to: 'consent', label: '認証済み', kind: 'flow', order: 80 },
  ],
});
