import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * エンドユーザーがデバイスに表示されたユーザーコードを入力し、そのデバイスのクライアントを承認または拒否する画面を HTML で返して、その決定を記録する。
 * `GET /device` はユーザーコードの入力フォームを返す。
 * `POST /device` はユーザーコードを照合してこのブラウザを結び付け、OP のセッションがあれば承認画面を、なければログインフォームを返す。
 * `POST /device/login` はユーザー名とパスワードを確かめて OP のセッションを作り、承認画面を返す。
 * `POST /device/approve` は承認か拒否をレコードに記録し、完了画面を返す。
 * デバイスは、その結果をトークンエンドポイントへのポーリングで受け取る。
 *
 * 実験的な機能であり、`--enable device-authorization-grant` を付けて生成したときだけ作られる。
 *
 * @spec RFC 8628 §3.3
 */
export const endpoint = defineEndpoint({
  id: 'device',
  order: 140,
  label: 'Device verification screens',
  path: '/device',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'device-authorization', label: 'Device Authorization Grant (RFC 8628)' },
  spec: 'RFC 8628 §3.3',
  feature: 'device-authorization-grant',
  rearrangeable: false,
  steps: [
    'submit-user-code',
    'submit-login',
    'submit-decision',
  ],
  edges: {
    chain: false,
    extra: [
      { from: 'submit-user-code', to: 'submit-login', label: 'no OP session', kind: 'branch' },
      { from: 'submit-user-code', to: 'submit-decision', label: 'OP session', kind: 'branch' },
      { from: 'submit-login', to: 'submit-decision', kind: 'flow' },
    ],
  },
});
