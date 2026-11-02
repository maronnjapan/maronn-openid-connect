import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * クライアントが JSON で送ったメタデータを検証してクライアントを登録し、201 で `client_id` と登録したすべてのメタデータを返す。
 * `client_secret` で認証する方式を登録したクライアントには、発行した `client_secret` も返す。
 * 設定で求めたときは、メタデータを検証する前に、初期アクセストークンとソフトウェアステートメントを設定の関数で検証する。
 *
 * 初期アクセストークンがないか拒否されたときは 401、ボディやメタデータの誤りとソフトウェアステートメントの拒否には 400、登録数が上限に達したときは 429 で応答する。
 *
 * 実験的な機能で、`--enable dynamic-client-registration` を指定したときに生成される。
 *
 * @spec RFC 7591 §3
 */
export const endpoint = defineEndpoint({
  id: 'register',
  order: 120,
  label: 'Client registration endpoint',
  path: '/register',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'client-registration', label: 'Dynamic Client Registration (RFC 7591)' },
  spec: 'RFC 7591 §3',
  feature: 'dynamic-client-registration',
  rearrangeable: true,
  steps: [
    'verify-initial-access-token',
    'parse-request',
    'verify-software-statement',
    'validate-metadata',
    'store-client',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
  journeys: [
    { from: 'register', to: 'authorize', label: 'client_id', kind: 'flow', order: 20 },
  ],
});
