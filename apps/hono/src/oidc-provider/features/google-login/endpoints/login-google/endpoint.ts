import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * Google から送られた ID トークンを検証し、OP のセッションを確立して同意画面へリダイレクトする。
 *
 * 「Google でログイン」の `login_uri` で、ログインを終えたブラウザから ID トークンが POST で届く。
 * 検証した Google アカウントは OP のユーザーに対応付け（既定では初回のログインでユーザーを作る）、そのユーザーでトランザクションのセッションを始める。
 *
 * 拡張機能なので、`--enable google-login` を付けて生成したときだけ含まれる。
 */
export const endpoint = defineEndpoint({
  id: 'login-google',
  order: 50,
  label: 'Google ログインのコールバック（login_uri）',
  path: '/login/google',
  methods: ['POST'],
  layer: 'browser',
  group: { id: 'google-login', label: 'Google でログイン（拡張）' },
  feature: 'google-login',
  rearrangeable: false,
  steps: [
    'verify-google-callback',
    'load-transaction',
    'discard-session-for-fresh-login',
    'establish-session',
    'hand-off-to-consent',
  ],
  edges: {
    chain: true,
  },
  journeys: [
    { from: 'login', to: 'login-google', label: 'Google でログイン', kind: 'flow', order: 60 },
    { from: 'login-google', to: 'consent', label: '認証済み', kind: 'flow', order: 70 },
  ],
});
