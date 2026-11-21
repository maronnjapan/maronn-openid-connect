import { defineEndpoint } from '../_oidc-provider/endpoint';

/**
 * 提示されたアクセストークンのエンドユーザーについて、トークンのスコープと `claims` パラメータに応じたクレームを JSON で返す。
 * クライアントが `userinfo_signed_response_alg` を登録していれば、署名した JWT で返す。
 *
 * トークンがないとき、または不正なときは、`Bearer` のエラーで応答する（DPoP の機能があり、トークンを DPoP スキームで提示したときは `DPoP` のエラー）。
 * レスポンスは、成功でもエラーでもキャッシュさせない（`Cache-Control: no-store`）。
 * 署名鍵を読み込めないときは、503 で応答する。
 *
 * ここに並べるのは、`route.ts` の UserInfo エンドポイントのステップである。
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
    { id: 'respond-error', consumes: ['challenge'], produces: [] },
  ],
});
