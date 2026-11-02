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
  label: 'Google login callback (login_uri)',
  path: '/login/google',
  methods: ['POST'],
  layer: 'browser',
  group: { id: 'google-login', label: 'Sign in with Google (extension)' },
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
    { from: 'login', to: 'login-google', label: 'Sign in with Google', kind: 'flow', order: 60 },
    { from: 'login-google', to: 'consent', label: 'authenticated', kind: 'flow', order: 70 },
  ],
});
