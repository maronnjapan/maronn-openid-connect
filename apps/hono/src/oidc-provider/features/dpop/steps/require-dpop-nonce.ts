import { step } from '../../../endpoints/step.js';
import { tokenEndpointErrorOf } from '../error-responses.js';
import { authorizationServerNonceOf, requireDpopNonce } from '../server-nonce.js';

export const meta = step({
  id: 'require-dpop-nonce',
  endpoint: 'token',
  feature: 'dpop',
  kind: 'validate',
  label: 'DPoP proof に認可サーバーの nonce を求め、次の nonce を渡す',
  spec: 'RFC 9449 §8 / §8.2 / §11.3',
  function: 'requireTokenDpopNonce',
  consumes: [],
  produces: [],
  removable: false,
  after: ['parse-request'],
  before: ['authenticate-client'],
});

/**
 * 設定が認可サーバーに DPoP の nonce を求めるとき、`DPoP` ヘッダーのあるトークンリクエストへのレスポンスに次の nonce を付け、DPoP proof の nonce を確かめる。
 *
 * 設定の `dpopNonceRequiredAtAuthorizationServer` が false なら何もしない（nonce を渡さず、DPoP proof の `nonce` も確かめない）。
 * true なら、`DPoP` ヘッダーが一つの値のリクエストには、このブロックから後のどのレスポンス（トークンレスポンスもエラーレスポンスも）にも認可サーバーの新しい nonce を `DPoP-Nonce` ヘッダーで付け、DPoP proof に `nonce` が無いか、認可サーバーが最近発行した nonce でなければ拒否する（`requireDpopNonce()`。RFC 9449 §8 / §8.2 / §11.3）。
 * `nonce` を読むために DPoP proof を署名を確かめずに分解するので、`DPoP` ヘッダーが一つの DPoP proof の形でない（JWS のコンパクト形式でない、JOSE ヘッダーの `typ` が `dpop+jwt` でない、`alg` か `jwk` が無い、`crit` がある）リクエストも、ここで拒否する。
 * クライアントの認証の前に実行するので、nonce で拒否したリクエストのクライアントアサーション（`private_key_jwt`）の `jti` は消費しない。
 * クライアントは、同じクライアントアサーションと、渡された nonce を入れた DPoP proof でやり直せる。
 * DPoP proof の署名とほかのクレームは、クライアントの認証の後の DPoP proof の検査（`verifyDpopTokenRequest()`）が、`nonce` と一緒に確かめる。
 *
 * @spec RFC 9449 §8
 * @spec RFC 9449 §8.2
 * @spec RFC 9449 §11.3
 * @throws {TokenEndpointError} 400 の `use_dpop_nonce`: DPoP proof の `nonce` を受け付けないとき。400 の `invalid_dpop_proof`: `DPoP` ヘッダーが一つの DPoP proof の形でないとき
 * @throws {Error} 秘密が 32 バイトより短いとき、設定の `dpopNonceLifetimeSeconds` が 0 以上の有限の数でないとき（設定の誤り。500 の `server_error` で応答する）
 */
export async function requireTokenDpopNonce(c: any): Promise<void> {
  const server = authorizationServerNonceOf(c.get('config'));
  if (server === undefined) return;
  try {
    await requireDpopNonce(c, server);
  } catch (error) {
    throw tokenEndpointErrorOf(error);
  }
}
