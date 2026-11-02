import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * クライアントを認証し、そのクライアントに発行されたトークンを失効させて、ボディが空の 200 で応答する。
 * リフレッシュトークンを失効させるときは、同じグラントのアクセストークンも失効させる。
 * ストアにないトークンにも、同じ 200 で応答する。
 * ほかのクライアントに発行されたトークンや不正なリクエストには OAuth のエラーレスポンスで応答し、成功のレスポンスにもエラーレスポンスにも `Cache-Control: no-store` を付ける。
 *
 * @spec RFC 7009 §2
 */
export const endpoint = defineEndpoint({
  id: 'revocation',
  order: 100,
  label: 'Token revocation endpoint',
  path: '/revoke',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'token-management', label: 'Token management' },
  spec: 'RFC 7009 §2',
  feature: 'revocation',
  rearrangeable: true,
  steps: [
    'parse-request',
    'authenticate-client',
    'resolve-token',
    'revoke-token',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
  journeys: [
    { from: 'token', to: 'revocation', label: 'token', kind: 'flow', order: 120 },
  ],
});
