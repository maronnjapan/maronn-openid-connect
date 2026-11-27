import { defineEndpoint } from '../../_oidc-provider/endpoint';

/**
 * クライアントが JSON で送ったメタデータを検証してクライアントを登録し、201 で `client_id` と登録したすべてのメタデータを返す。
 * `client_secret` で認証する方式を登録したクライアントには、発行した `client_secret` も返す。
 * 設定で求めたときは、メタデータを検証する前に、初期アクセストークンとソフトウェアステートメントを設定の関数で検証する。
 *
 * 初期アクセストークンがないか拒否されたときは 401、ボディやメタデータの誤りとソフトウェアステートメントの拒否には 400、登録数が上限に達したときは 429 で応答する。
 * 署名鍵を読み込めないときは、503 で応答する。
 *
 * 実験的な機能で、`--enable dynamic-client-registration` を指定したときに生成される。
 * ここに並べるのは、`route.ts` のクライアント登録エンドポイントのステップである。
 *
 * @spec RFC 7591 §3
 */
export const endpoint = defineEndpoint({
  path: '/register',
  steps: [
    { id: 'verify-initial-access-token', consumes: [], produces: [] },
    { id: 'parse-request', consumes: [], produces: ['keys', 'registration'] },
    { id: 'verify-software-statement', consumes: ['registration'], produces: ['metadata'] },
    { id: 'validate-metadata', consumes: ['metadata', 'keys'], produces: ['client'] },
    { id: 'store-client', consumes: ['client'], produces: [] },
    { id: 'respond', consumes: ['client'], produces: [] },
    { id: 'respond-error', consumes: [], produces: [] },
  ],
});
