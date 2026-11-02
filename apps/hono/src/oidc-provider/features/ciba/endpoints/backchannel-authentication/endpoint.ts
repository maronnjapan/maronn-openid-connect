import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * クライアントから CIBA の認証リクエスト（ポーリングモード）を受け付け、`auth_req_id` を JSON で返す。
 * クライアントを認証し、要求されたスコープとパラメータを検証してから、`login_hint` で示されたユーザー宛ての保留中のリクエストを保存する。
 * クライアントは `auth_req_id` でトークンエンドポイントをポーリングし、エンドユーザーが `/ciba` の画面で承認するとトークンを受け取る。
 * 検証に失敗すると、OAuth のエラーレスポンスを返す。
 *
 * 実験的な機能であり、`--enable ciba` を付けて生成したときだけ作られる。
 *
 * @spec CIBA Core 1.0 §7
 */
export const endpoint = defineEndpoint({
  id: 'backchannel-authentication',
  order: 150,
  label: 'バックチャネル認証エンドポイント',
  path: '/backchannel_authentication',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'backchannel-authentication', label: 'CIBA（ポーリングモード）' },
  spec: 'CIBA Core 1.0 §7',
  feature: 'ciba',
  rearrangeable: true,
  steps: [
    'parse-request',
    'authenticate-client',
    'validate-client-scope',
    'create-request',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
  journeys: [
    { from: 'backchannel-authentication', to: 'ciba', label: 'エンドユーザーが承認', kind: 'flow', order: 150 },
    { from: 'backchannel-authentication', to: 'token', label: 'auth_req_id（ポーリング）', kind: 'flow', order: 160 },
  ],
});
