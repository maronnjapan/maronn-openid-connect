import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * デバイスからデバイス認可リクエストを受け付け、`device_code`、`user_code`、検証用の URI を JSON で返す。
 * クライアントを認証し、グラントタイプの登録とスコープを検証してから、保留中のレコードを保存する。
 * エンドユーザーは別のデバイスのブラウザで検証用の URI（`/device`）を開いてユーザーコードを入力し、デバイスは `device_code` でトークンエンドポイントをポーリングする。
 * 検証に失敗すると、OAuth のエラーレスポンスを返す。
 *
 * 実験的な機能であり、`--enable device-authorization-grant` を付けて生成したときだけ作られる。
 *
 * @spec RFC 8628 §3.1
 * @spec RFC 8628 §3.2
 */
export const endpoint = defineEndpoint({
  id: 'device-authorization',
  order: 130,
  label: 'デバイス認可エンドポイント',
  path: '/device_authorization',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'device-authorization', label: 'デバイス認可グラント（RFC 8628）' },
  spec: 'RFC 8628 §3.1 / §3.2',
  feature: 'device-authorization-grant',
  rearrangeable: true,
  steps: [
    'parse-request',
    'authenticate-client',
    'validate-request',
    'issue-device-code',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
  journeys: [
    { from: 'device-authorization', to: 'device', label: 'user_code（エンドユーザー）', kind: 'flow', order: 130 },
    { from: 'device-authorization', to: 'token', label: 'device_code（ポーリング）', kind: 'flow', order: 140 },
  ],
});
