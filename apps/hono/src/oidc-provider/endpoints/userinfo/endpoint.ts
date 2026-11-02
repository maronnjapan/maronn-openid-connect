import { defineEndpoint } from '../step.js';

/**
 * 提示されたアクセストークンのエンドユーザーについて、トークンのスコープと `claims` パラメータが許すクレームを JSON で返す。
 * クライアントが `userinfo_signed_response_alg` を登録していれば、署名した JWT で返す。
 *
 * トークンがないとき、または不正なときは、`Bearer` のエラーで応答する。
 * レスポンスは、成功でもエラーでもキャッシュさせない（`Cache-Control: no-store`）。
 *
 * @spec OIDC Core 1.0 §5.3
 */
export const endpoint = defineEndpoint({
  id: 'userinfo',
  order: 80,
  label: 'UserInfo endpoint',
  path: '/userinfo',
  methods: ['GET', 'POST'],
  layer: 'api',
  group: { id: 'authorization-code', label: 'Authorization Code Flow' },
  spec: 'OIDC Core 1.0 §5.3',
  rearrangeable: true,
  steps: [
    'parse-access-token',
    'resolve-access-token',
    'resolve-claims',
    'build-response',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
});
