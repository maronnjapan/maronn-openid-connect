import { step } from '../../../endpoints/step.js';
import { parEndpointRejectionOf } from '../error-responses.js';
import { authorizationServerNonceOf, requireDpopNonce } from '../server-nonce.js';

export const meta = step({
  id: 'require-pushed-dpop-nonce',
  endpoint: 'par',
  feature: 'dpop',
  kind: 'validate',
  label: 'プッシュする DPoP proof に認可サーバーの nonce を求め、次の nonce を渡す',
  spec: 'RFC 9449 §8 / §8.2 / §11.3',
  function: 'requirePushedDpopNonce',
  consumes: [],
  produces: ['dpopNonceRejection'],
  removable: false,
  after: ['parse-request'],
  before: ['authenticate-client'],
});

/**
 * 設定が認可サーバーに DPoP の nonce を求めるとき、`DPoP` ヘッダーのある PAR のリクエストへのレスポンスに次の nonce を付け、DPoP proof の nonce を確かめる。
 *
 * 設定の `dpopNonceRequiredAtAuthorizationServer` が false なら何もしない（nonce を渡さず、DPoP proof の `nonce` も確かめない）。
 * true なら、`DPoP` ヘッダーのあるリクエストへのどのレスポンス（201 もエラーも）にも認可サーバーの新しい nonce を `DPoP-Nonce` ヘッダーで付け、DPoP proof に `nonce` が無いか、認可サーバーが最近発行した nonce でなければ拒否する（`requireDpopNonce()`。RFC 9449 §8 / §8.2 / §11.3）。
 * 認可サーバーの nonce なので、トークンエンドポイントで渡された nonce もここで使え、ここで渡された nonce もトークンエンドポイントで使える。
 * クライアントの認証の前に実行するので、nonce で拒否したリクエストのクライアントアサーション（`private_key_jwt`）の `jti` は消費しない。
 * DPoP proof の署名とほかのクレームは、クライアントの認証の後のブロック（`bindPushedDpopKey()`）が、`nonce` と一緒に確かめる。
 *
 * 拒否するときは、PAR のエラーと同じ形（RFC 9126 §2.3）の 400 の JSON のレスポンス（`no-cache, no-store`）を `dpopNonceRejection` に入れて返す（`parEndpointRejectionOf()`）。
 * `error` は、nonce を受け付けないときは `use_dpop_nonce`、`DPoP` ヘッダーが複数あるときと一つの JWT でないときは `invalid_dpop_proof` である。
 * DPoP の機能が PAR の機能なしでも生成されるので、PAR の機能のエラーの型は使わない（そのときもこのファイルは生成されるが、PAR エンドポイントがないので、どこからも呼ばれない）。
 *
 * @spec RFC 9449 §8
 * @spec RFC 9449 §8.2
 * @spec RFC 9449 §11.3
 * @spec RFC 9126 §2.3
 * @throws {Error} 秘密が 32 バイトより短いとき、設定の `dpopNonceLifetimeSeconds` が 0 以上の有限の数でないとき（設定の誤り。PAR エンドポイントは 500 の `server_error` で応答する）
 */
export async function requirePushedDpopNonce(c: any): Promise<{ dpopNonceRejection?: Response }> {
  const server = authorizationServerNonceOf(c.get('config'));
  if (server === undefined) return {};
  try {
    await requireDpopNonce(c, server);
    return {};
  } catch (error) {
    const dpopNonceRejection = parEndpointRejectionOf(c, error);
    if (dpopNonceRejection === undefined) throw error;
    return { dpopNonceRejection };
  }
}
