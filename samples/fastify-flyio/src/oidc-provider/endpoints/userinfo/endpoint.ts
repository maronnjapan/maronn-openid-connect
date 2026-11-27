import { defineEndpoint } from '../step.js';

/**
 * 提示されたアクセストークンのエンドユーザーについて、トークンのスコープと `claims` パラメータに応じたクレームを JSON で返す。
 * クライアントが `userinfo_signed_response_alg` を登録していれば、署名した JWT で返す。
 *
 * トークンがないとき、または不正なときは、受け付ける認証スキームのチャレンジ（機能を有効にしなければ `Bearer`）を付けたエラーで応答する。
 * レスポンスは、成功でもエラーでもキャッシュさせない（`Cache-Control: no-store`）。
 *
 * @spec OIDC Core 1.0 §5.3
 */
export const endpoint = defineEndpoint({
  id: 'userinfo',
  order: 80,
  label: 'UserInfo エンドポイント',
  path: '/userinfo',
  methods: ['GET', 'POST'],
  layer: 'api',
  group: { id: 'authorization-code', label: '認可コードフロー' },
  spec: 'OIDC Core 1.0 §5.3',
  rearrangeable: true,
  // Defined before the first step: the challenges of the schemes the
  // endpoint accepts (Bearer, and those of the features), so the error step
  // can read them whichever step failed.
  initial: ['challenges'],
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
