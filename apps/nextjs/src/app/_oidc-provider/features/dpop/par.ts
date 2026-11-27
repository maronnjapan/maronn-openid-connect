/**
 * EXTENSION (dpop): the blocks of (par)/par/route.ts (RFC 9449 §8 / §10.1).
 *
 * The PAR endpoint calls requirePushedDpopNonce() in its
 * [require-pushed-dpop-nonce] block, right before client authentication, and
 * bindPushedDpopKey() in its [bind-pushed-dpop-key] block, right after it.
 * This feature requires no other feature (packages/cli/src/registry.ts), so
 * it uses no error type of the par feature: a rejection is a ready-made
 * Response the block returns. Without par this file is generated all the
 * same, and nothing imports it.
 */
import { config } from '../../provider';
import { parseDpopJkt, resolvePushedDpopJkt } from './binding';
import { parEndpointRejectionOf } from './error-responses';
import { readDpopProofHeader, verifyDpopRequestProof } from './proof';
import { authorizationServerNonceOf, requireDpopNonce } from './server-nonce';

/** What bindPushedDpopKey() decided. */
export interface PushedDpopBinding {
  /** The pushed parameters with dpop_jkt set to the key of the DPoP proof; undefined when the request had no DPoP header. */
  dpopBoundParams?: Record<string, string>;
  /** The error response to answer with when the DPoP proof or dpop_jkt was rejected. */
  dpopRejection?: Response;
}

/**
 * 設定が認可サーバーに DPoP の nonce を求めるとき、`DPoP` ヘッダーのある PAR のリクエストへのレスポンスに次の nonce を付け、DPoP proof の nonce を確かめる。
 *
 * 設定の `dpopNonceRequiredAtAuthorizationServer` が false なら何もせず `undefined` を返す（nonce を渡さず、DPoP proof の `nonce` も確かめない）。
 * true なら、`DPoP` ヘッダーが一つの値のリクエストには、このブロックから後のどのレスポンス（201 もエラーも）にも認可サーバーの新しい nonce を `DPoP-Nonce` ヘッダーで付け、DPoP proof に `nonce` が無いか、認可サーバーが最近発行した nonce でなければ拒否する（`requireDpopNonce()`。RFC 9449 §8 / §8.2 / §11.3）。
 * `nonce` を読むために DPoP proof を署名を確かめずに分解するので、`DPoP` ヘッダーが一つの DPoP proof の形でない（JWS のコンパクト形式でない、JOSE ヘッダーの `typ` が `dpop+jwt` でない、`alg` か `jwk` が無い、`crit` がある）リクエストも、ここで拒否する。
 * 認可サーバーの nonce なので、トークンエンドポイントで渡された nonce もここで使え、ここで渡された nonce もトークンエンドポイントで使える。
 * クライアントの認証の前に実行するので、nonce で拒否したリクエストのクライアントアサーション（`private_key_jwt`）の `jti` は消費しない。
 * DPoP proof の署名とほかのクレームは、クライアントの認証の後のブロック（`bindPushedDpopKey()`）が、`nonce` と一緒に確かめる。
 *
 * 拒否するときは、PAR のエラーと同じ形（RFC 9126 §2.3）の 400 の JSON のレスポンス（`no-cache, no-store`）を返す（`parEndpointRejectionOf()`）。
 * `error` は、nonce を受け付けないときは `use_dpop_nonce`、`DPoP` ヘッダーが一つの DPoP proof の形でないときは `invalid_dpop_proof` である。
 *
 * @spec RFC 9449 §8
 * @spec RFC 9449 §8.2
 * @spec RFC 9449 §11.3
 * @spec RFC 9126 §2.3
 * @throws {Error} 秘密が 32 バイトより短いとき、設定の `dpopNonceLifetimeSeconds` が 0 以上の有限の数でないとき（設定の誤り。PAR エンドポイントは 500 の `server_error` で応答する）
 */
export async function requirePushedDpopNonce(request: Request): Promise<Response | undefined> {
  const server = authorizationServerNonceOf(config);
  if (server === undefined) return undefined;
  try {
    await requireDpopNonce(request, server);
    return undefined;
  } catch (error) {
    const rejection = parEndpointRejectionOf(error);
    if (rejection === undefined) throw error;
    return rejection;
  }
}

/**
 * プッシュされた認可リクエストに `DPoP` ヘッダーがあれば、その鍵の JWK Thumbprint を `dpop_jkt` にしたパラメータを返す。
 *
 * PAR のリクエストの DPoP proof は、認可コードを束縛する鍵を示す（RFC 9449 §10.1）。
 * DPoP proof を検査し（`htm` はリクエストのメソッド、`htu` は issuer の `/par`）、その鍵の JWK Thumbprint を `dpop_jkt` にしたパラメータを `dpopBoundParams` に入れて返す。
 * 設定の `dpopNonceRequiredAtAuthorizationServer` が true なら、DPoP proof の `nonce` が認可サーバーの最近発行した nonce であることも、署名と一緒に確かめる（RFC 9449 §8 / §11.3）。
 * 後のブロックは、このパラメータを検証して保存するので、`/authorize` がこのリクエストを展開すると、`dpop_jkt` が認可コードをその鍵に束縛する（RFC 9449 §10）。
 * プッシュされた `dpop_jkt` と DPoP proof の両方があれば、同じ鍵でなければ拒否する（RFC 9449 §10.1 の MUST）。
 * `DPoP` ヘッダーがなければ何も返さず、プッシュされたパラメータ（`dpop_jkt` があればそれも）をそのまま使わせる。
 * プッシュされた `dpop_jkt` の形は、`DPoP` ヘッダーの有無にかかわらず、DPoP proof の前に確かめる（認可エンドポイントと同じ検証。RFC 9126 §2.1）。
 * クライアントの認証の後に実行するので、認証に失敗したリクエストの DPoP proof の署名とクレームは検査せず、その `jti` も覚えない（認可サーバーが nonce を求めるときは、認証の前のブロックが、署名を確かめずに DPoP proof の形と JOSE ヘッダーと `nonce` だけを確かめる）。
 *
 * 拒否するときは、PAR のエラーと同じ形（RFC 9126 §2.3）の 400 の JSON のレスポンス（`no-cache, no-store`）を `dpopRejection` に入れて返す（`parEndpointRejectionOf()`）。
 * `error` は、DPoP proof を受け付けないときと `dpop_jkt` が DPoP proof の鍵と違うときは `invalid_dpop_proof`、`dpop_jkt` が JWK Thumbprint の形でないときは `invalid_request`、DPoP proof の `nonce` を受け付けないときは `use_dpop_nonce` である。
 * PAR の機能のエラーの型を使わないのは、DPoP の機能が PAR の機能なしでも生成されるためである（そのときもこのファイルは生成されるが、PAR エンドポイントがないので、どこからも呼ばれない）。
 *
 * @spec RFC 9449 §8
 * @spec RFC 9449 §10.1
 * @spec RFC 9126 §2.1
 * @spec RFC 9126 §2.3
 * @throws {Error} 設定の `dpopProofMaxAgeSeconds` か `dpopProofLeewaySeconds` が 0 以上の有限の数でないとき、またはこの三つのコード以外の `DpopError`（どちらも PAR エンドポイントは 500 の `server_error` で応答する）
 */
export async function bindPushedDpopKey(request: Request, pushedParams: Record<string, string>): Promise<PushedDpopBinding> {
  try {
    const pushedJkt = parseDpopJkt(pushedParams.dpop_jkt);

    // `DPoP` ヘッダーは一つだけでなければならない（RFC 9449 §4.3）。
    const proof = readDpopProofHeader(request.headers.get('DPoP'));
    if (proof === undefined) return {};

    const proofJkt = await verifyDpopRequestProof(proof, {
      method: request.method,
      path: '/par',
      nonceServer: authorizationServerNonceOf(config),
    });
    return { dpopBoundParams: { ...pushedParams, dpop_jkt: resolvePushedDpopJkt(pushedJkt, proofJkt) } };
  } catch (error) {
    const dpopRejection = parEndpointRejectionOf(error);
    if (dpopRejection === undefined) throw error;
    return { dpopRejection };
  }
}
