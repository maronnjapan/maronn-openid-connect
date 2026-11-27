import { defineEndpoint } from '../step.js';

/**
 * 提示されたアクセストークンのエンドユーザーについて、トークンのスコープと `claims` パラメータに応じたクレームを JSON で返す。
 * クライアントが `userinfo_signed_response_alg` を登録していれば、署名した JWT で返す。
 *
 * トークンがないとき、または不正なときは、受け付ける認証スキームのチャレンジ（機能を有効にしなければ `Bearer`）を付けたエラーで応答する。
 * DPoP の機能があり、設定が保護されたリソースに DPoP の nonce を求めるときは、DPoP スキーム（`Authorization: DPoP`）のリクエストには、そのスキームを読んだ後のどのレスポンスにも次の nonce（`DPoP-Nonce`）を付け、保護されたリソースが最近発行した nonce の無い DPoP proof を 401 の `use_dpop_nonce` で拒否する。
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
    'read-dpop-access-token',
    'parse-access-token',
    'resolve-access-token',
    'verify-dpop-access-token',
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
