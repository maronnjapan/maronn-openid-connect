import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * クライアントからの要求でエンドユーザーのセッションを終了し、`post_logout_redirect_uri` へリダイレクトするか、ログアウトの完了画面を表示する。
 *
 * `id_token_hint` が現在のセッションのエンドユーザーを示すときはすぐにログアウトし、そうでなければ先に確認画面でエンドユーザーに確かめる。
 *
 * 実験的な機能なので、`--enable rp-initiated-logout` を付けて生成したときだけ含まれる。
 *
 * @spec RP-Initiated Logout 1.0 §2
 */
export const endpoint = defineEndpoint({
  id: 'logout',
  order: 170,
  label: 'End session endpoint',
  path: '/logout',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'logout', label: 'RP-Initiated Logout 1.0' },
  spec: 'RP-Initiated Logout 1.0 §2',
  feature: 'rp-initiated-logout',
  rearrangeable: false,
  steps: [
    'process-end-session-request',
    'approve-logout',
  ],
  edges: {
    chain: false,
    extra: [
      { from: 'process-end-session-request', to: 'approve-logout', label: 'confirmation screen', kind: 'branch' },
    ],
  },
  journeys: [
    { from: 'token', to: 'logout', label: 'id_token_hint', kind: 'flow', order: 170 },
  ],
});
