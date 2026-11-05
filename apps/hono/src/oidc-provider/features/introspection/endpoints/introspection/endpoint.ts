import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * 認証したコンフィデンシャルクライアントに、提示されたトークンが有効であるかどうかと、有効ならその内容（`scope`、`client_id`、`sub`、`exp` など）を JSON で返す。
 * 登録されていない、期限切れ、まだ有効になっていない、ローテーションで使用済みになったトークンには、`{ active: false }` だけを返す。
 * クライアントが `application/token-introspection+jwt` を求めたときは、同じ内容を署名付きの JWT で返す（`jwt-introspection-response` 機能）。
 * 失敗したときは OAuth のエラーレスポンスで応答し、イントロスペクションのレスポンスにもエラーレスポンスにも `Cache-Control: no-store` を付ける。
 *
 * @spec RFC 7662 §2
 */
export const endpoint = defineEndpoint({
  id: 'introspection',
  order: 90,
  label: 'トークンイントロスペクションエンドポイント',
  path: '/introspect',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'token-management', label: 'トークンの管理' },
  spec: 'RFC 7662 §2',
  feature: 'introspection',
  rearrangeable: true,
  steps: [
    'parse-request',
    'authenticate-client',
    'resolve-token',
    'build-response',
    'sign-response',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
    extra: [
      { from: 'sign-response', to: 'respond', label: 'application/token-introspection+jwt', kind: 'branch' },
    ],
  },
  journeys: [
    { from: 'token', to: 'introspection', label: 'token', kind: 'flow', order: 110 },
  ],
});
