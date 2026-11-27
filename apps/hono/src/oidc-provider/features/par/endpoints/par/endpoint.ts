import { defineEndpoint } from '../../../../endpoints/step.js';

/**
 * 認証したクライアントが送った認可リクエストのパラメータを、認可エンドポイントと同じ規則で検証して保存する。
 * 201 で、`/authorize` に渡す `request_uri` とその有効期間（`expires_in`）を返す。
 *
 * 失敗したときはトークンエンドポイントと同じ形の JSON のエラーで応答し（クライアントの認証の失敗は 401、それ以外は 400）、リダイレクトはしない。
 * DPoP の機能があれば、プッシュされた `dpop_jkt` の形を `DPoP` ヘッダーの有無にかかわらず確かめ（JWK Thumbprint の形でなければ 400 の `invalid_request`）、リクエストに `DPoP` ヘッダーがあれば、その鍵を `dpop_jkt` として保存するリクエストに入れる。
 * DPoP の機能があり、設定が認可サーバーに DPoP の nonce を求めるときは、`DPoP` ヘッダーのあるリクエストには、リクエストを解析した後のどのレスポンスにも次の nonce（`DPoP-Nonce`）を付け、認可サーバーが最近発行した nonce の無い DPoP proof を 400 の `use_dpop_nonce` で拒否する。
 *
 * 実験的な機能で、`--enable par` を指定したときに生成される。
 *
 * @spec RFC 9126 §2
 */
export const endpoint = defineEndpoint({
  id: 'par',
  order: 110,
  label: 'PAR エンドポイント',
  path: '/par',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'pushed-authorization', label: 'PAR（RFC 9126）' },
  spec: 'RFC 9126 §2',
  feature: 'par',
  rearrangeable: true,
  steps: [
    'parse-request',
    'require-pushed-dpop-nonce',
    'authenticate-client',
    'bind-pushed-dpop-key',
    'validate-request',
    'store-request',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
  journeys: [
    { from: 'par', to: 'authorize', label: 'request_uri', kind: 'flow', order: 10 },
  ],
});
