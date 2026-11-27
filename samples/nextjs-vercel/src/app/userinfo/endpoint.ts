import { defineEndpoint } from '../_oidc-provider/endpoint';

/**
 * 提示されたアクセストークンのエンドユーザーについて、トークンのスコープと `claims` パラメータに応じたクレームを JSON で返す。
 * クライアントが `userinfo_signed_response_alg` を登録していれば、署名した JWT で返す。
 *
 * トークンがないとき、または不正なときは、受け付ける認証スキームのチャレンジ（機能を有効にしなければ `Bearer`）を付けたエラーで応答する。
 * DPoP の機能があり、設定が保護されたリソースに DPoP の nonce を求めるときは、DPoP スキーム（`Authorization: DPoP`）のリクエストには、そのスキームを読んだ後のどのレスポンスにも次の nonce（`DPoP-Nonce`）を付け、保護されたリソースが最近発行した nonce の無い DPoP proof を 401 の `use_dpop_nonce` で拒否する。
 * レスポンスは、成功でもエラーでもキャッシュさせない（`Cache-Control: no-store`）。
 * 署名鍵を読み込めないときは、503 で応答する。
 *
 * ここに並べるのは、`route.ts` の UserInfo エンドポイントのステップである。
 * `respond-error` が読む `challenges`（受け付ける認証スキームのチャレンジ）は、`route.ts` が最初のブロックの前で宣言する。
 *
 * @spec OIDC Core 1.0 §5.3
 */
export const endpoint = defineEndpoint({
  path: '/userinfo',
  steps: [
    { id: 'load-signing-keys', consumes: [], produces: ['keys'] },
    { id: 'parse-access-token', consumes: ['dpopAccessToken'], produces: ['accessToken'] },
    { id: 'resolve-access-token', consumes: ['accessToken'], produces: ['tokenInfo'] },
    { id: 'resolve-claims', consumes: ['tokenInfo'], produces: ['claims'] },
    { id: 'build-response', consumes: ['tokenInfo', 'claims', 'keys'], produces: ['userInfoResponse'] },
    { id: 'respond', consumes: ['userInfoResponse'], produces: [] },
    { id: 'respond-error', consumes: ['challenges'], produces: [] },
  ],
});
