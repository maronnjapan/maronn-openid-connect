import { defineEndpoint } from '../_oidc-provider/endpoint';

/**
 * クライアントを認証し、提示されたグラント（認可コード、リフレッシュトークン、有効にした機能が扱うグラント）を検証して、トークンレスポンスで応答する。
 * レスポンスには、アクセストークンと、`openid` スコープが許可されたときの ID トークンと、発行したときのリフレッシュトークンを含める。
 * DPoP の機能があり、リクエストが DPoP proof を送ったときは、アクセストークンとパブリッククライアントのリフレッシュトークンをその鍵に束縛し、`token_type` を `DPoP` にする。
 * 鍵に束縛した認可コードかリフレッシュトークンは、同じ鍵の DPoP proof を送ったリクエストだけが使える。
 * DPoP の機能があれば、`dpop_bound_access_tokens` を登録したクライアントは、DPoP proof を送ったリクエストでだけトークンを得られる。
 * DPoP の機能があり、設定が認可サーバーに DPoP の nonce を求めるときは、`DPoP` ヘッダーのあるリクエストには、リクエストを解析した後のどのレスポンスにも次の nonce（`DPoP-Nonce`）を付け、認可サーバーが最近発行した nonce の無い DPoP proof を 400 の `use_dpop_nonce` で拒否する。
 * 失敗したときは OAuth のエラーレスポンスで応答し、トークンレスポンスにもエラーレスポンスにも `Cache-Control: no-store` を付ける。
 * 署名鍵を読み込めないときは、503 で応答する。
 *
 * ここに並べるのは、`route.ts` のトークンエンドポイントのステップである。
 *
 * @spec OIDC Core 1.0 §3.1.3
 */
export const endpoint = defineEndpoint({
  path: '/token',
  steps: [
    { id: 'load-signing-keys', consumes: [], produces: ['keys'] },
    { id: 'parse-request', consumes: [], produces: ['params'] },
    { id: 'authenticate-client', consumes: ['params'], produces: ['tokenClient', 'authenticatedClientId'] },
    { id: 'dispatch-client-credentials', feature: 'client-credentials', consumes: ['params', 'tokenClient', 'keys', 'tokenBinding'], produces: [] },
    { id: 'dispatch-device-code', feature: 'device-authorization-grant', consumes: ['params', 'tokenClient', 'keys', 'tokenBinding'], produces: [] },
    { id: 'dispatch-ciba', feature: 'ciba', consumes: ['params', 'tokenClient', 'keys', 'tokenBinding'], produces: [] },
    { id: 'validate-grant-type', consumes: ['params', 'tokenClient'], produces: ['grantType'] },
    { id: 'validate-refresh-token-grant', feature: 'refresh-token', consumes: ['params', 'authenticatedClientId', 'grantType'], produces: ['refreshTokenRequest'] },
    { id: 'validate-authorization-code-grant', consumes: ['refreshTokenRequest', 'params', 'authenticatedClientId'], produces: ['validatedRequest'] },
    { id: 'select-signing-keys', consumes: ['tokenClient', 'keys'], produces: ['idTokenKey'] },
    { id: 'resolve-subject', consumes: ['validatedRequest'], produces: ['subject', 'authTime', 'nonce', 'effectiveAudience'] },
    { id: 'decide-refresh-token-issuance', feature: 'refresh-token', consumes: ['tokenClient', 'validatedRequest'], produces: ['refreshTokenDecision'] },
    { id: 'resolve-acr-amr', consumes: ['subject', 'validatedRequest'], produces: ['acr', 'amr'] },
    { id: 'issue-access-token', consumes: ['subject', 'validatedRequest', 'effectiveAudience', 'acr', 'keys', 'tokenBinding'], produces: ['issuedAt', 'accessTokenPayload', 'accessToken'] },
    { id: 'issue-id-token', consumes: ['accessToken', 'idTokenKey', 'subject', 'validatedRequest', 'issuedAt', 'nonce', 'authTime', 'acr', 'amr'], produces: ['idToken'] },
    { id: 'persist-access-token', consumes: ['accessToken', 'accessTokenPayload', 'subject', 'validatedRequest', 'issuedAt', 'effectiveAudience', 'acr', 'tokenBinding'], produces: [] },
    { id: 'issue-refresh-token', feature: 'refresh-token', consumes: ['refreshTokenDecision', 'subject', 'authTime', 'nonce', 'validatedRequest', 'issuedAt', 'effectiveAudience', 'acr', 'amr', 'tokenBinding'], produces: ['refreshToken'] },
    { id: 'revoke-rotated-refresh-token', feature: 'refresh-token', consumes: ['params', 'validatedRequest'], produces: [] },
    { id: 'build-token-response', consumes: ['accessToken', 'idToken', 'refreshToken', 'validatedRequest', 'tokenBinding'], produces: ['tokenResponse'] },
    { id: 'respond', consumes: ['tokenResponse'], produces: [] },
    { id: 'respond-error', consumes: [], produces: [] },
  ],
});
