import { defineEndpoint } from '../../_oidc-provider/endpoint';

/**
 * 認証したコンフィデンシャルクライアントに、提示されたトークンが有効であるかどうかと、有効ならその内容（`scope`、`client_id`、`sub`、`exp` など）を JSON で返す。
 * 登録されていない、期限切れ、まだ有効になっていない、ローテーションで使用済みになったトークンには、`{ active: false }` だけを返す。
 * クライアントが `application/token-introspection+jwt` を求めたときは、同じ内容を署名付きの JWT で返す（`jwt-introspection-response` 機能）。
 * 失敗したときは OAuth のエラーレスポンスで応答し、イントロスペクションのレスポンスにもエラーレスポンスにも `Cache-Control: no-store` を付ける。
 * 署名鍵を読み込めないときは、503 で応答する。
 *
 * ここに並べるのは、`route.ts` のイントロスペクションエンドポイントのステップである。
 *
 * @spec RFC 7662 §2
 */
export const endpoint = defineEndpoint({
  path: '/introspect',
  steps: [
    { id: 'load-signing-keys', consumes: [], produces: ['keys'] },
    { id: 'parse-request', consumes: [], produces: ['params'] },
    { id: 'authenticate-client', consumes: ['params'], produces: ['authenticatedClientId'] },
    { id: 'resolve-token', consumes: ['params', 'authenticatedClientId'], produces: ['resolved'] },
    { id: 'build-response', consumes: ['resolved'], produces: ['response'] },
    { id: 'respond-jwt', feature: 'jwt-introspection-response', consumes: ['response', 'authenticatedClientId', 'keys'], produces: [] },
    { id: 'respond', consumes: ['response'], produces: [] },
    { id: 'respond-error', consumes: [], produces: [] },
  ],
});
