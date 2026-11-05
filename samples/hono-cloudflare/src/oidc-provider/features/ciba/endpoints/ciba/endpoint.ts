import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * エンドユーザーが自分宛ての CIBA の認証リクエストを承認または拒否する画面（CIBA の認証デバイス）を HTML で返し、その決定を記録する。
 * `GET /ciba` は、OP のセッションがあれば保留中のリクエストの一覧を、なければログインフォームを返す。
 * `POST /ciba/login` はユーザー名とパスワードを確かめて OP のセッションを作り、一覧を返す。
 * `POST /ciba/approve` は承認か拒否をリクエストに記録し、完了画面を返す。
 * ポーリングしているクライアントは、その結果をトークンエンドポイントで受け取る。
 *
 * 実験的な機能であり、`--enable ciba` を付けて生成したときだけ作られる。
 *
 * @spec CIBA Core 1.0 §7.1
 */
export const endpoint = defineEndpoint({
  id: 'ciba',
  order: 160,
  label: 'CIBA の認証デバイス画面',
  path: '/ciba',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'backchannel-authentication', label: 'CIBA（ポーリングモード）' },
  spec: 'CIBA Core 1.0 §7.1',
  feature: 'ciba',
  rearrangeable: false,
  steps: [
    'prepare-device',
    'submit-login',
    'submit-decision',
  ],
  edges: {
    chain: false,
    extra: [
      { from: 'prepare-device', to: 'submit-login', label: 'OP のセッションなし', kind: 'branch' },
      { from: 'prepare-device', to: 'submit-decision', label: 'OP のセッションあり', kind: 'branch' },
      { from: 'submit-login', to: 'submit-decision', kind: 'flow' },
    ],
  },
});
