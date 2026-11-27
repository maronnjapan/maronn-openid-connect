/**
 * EXTENSION (dpop): the DPoP nonces an endpoint of this OP requires
 * (RFC 9449 §8). An endpoint that requires them calls requireDpopNonce()
 * before it authenticates the client: it gives every response to a request
 * with a DPoP header a new nonce (the DPoP-Nonce header, through
 * setResponseHeader() of http.ts, which withCors() puts on the answer) and
 * rejects a proof without a nonce the server recently provided. The proof
 * checks after client authentication (proof.ts) check the nonce again with
 * the signature, for the server authorizationServerNonceOf() returns.
 *
 * It reads provider.ts and imports http.ts, so only token.ts and par.ts
 * import it (see feature.ts).
 */
import type { ProviderConfig } from '../../config';
import { setResponseHeader } from '../../http';
import { config } from '../../provider';
import { dpopNonceKeyOf, issueDpopNonce, type DpopNonceScope, type DpopNonceServer } from './nonce';
import { decodeDpopProof, readDpopProofHeader, validateDpopProofNonce } from './proof';

/**
 * 設定が認可サーバーに DPoP の nonce を求めるなら、nonce を発行して確かめるサーバーの役割（`'authorization-server'`）を返す。
 *
 * 設定の `dpopNonceRequiredAtAuthorizationServer` が false なら `undefined` を返す。
 * 認可サーバーのエンドポイント（トークンエンドポイントと PAR エンドポイント）は、返った役割を {@link requireDpopNonce} と DPoP proof の検査（`DpopProofTarget.nonceServer`）に渡す。
 * `undefined` のときは、nonce を渡さず、DPoP proof の `nonce` も確かめない。
 * nonce を渡したサーバーだけが nonce を求めるので、渡した nonce の無い DPoP proof を受け付けることはない（RFC 9449 §11.3）。
 *
 * @spec RFC 9449 §8
 * @spec RFC 9449 §11.3
 */
export function authorizationServerNonceOf(
  settings: Pick<ProviderConfig, 'dpopNonceRequiredAtAuthorizationServer'>,
): DpopNonceServer | undefined {
  return settings.dpopNonceRequiredAtAuthorizationServer ? 'authorization-server' : undefined;
}

/**
 * `DPoP` ヘッダーのあるリクエストへのレスポンスに `server` の新しい nonce を付け、DPoP proof の `nonce` が `server` の最近発行した nonce であることを確かめる。
 *
 * `DPoP` ヘッダーがなければ何もしない（DPoP を使わないリクエストには、nonce を渡さず、求めもしない）。
 * `DPoP` ヘッダーが一つの値なら、拒否するときも含め、このリクエストへのレスポンスに、`server` が今発行した nonce を `DPoP-Nonce` ヘッダーで一つだけ付ける（`setResponseHeader()` で設定し、Route Handler の `withCors()` が付ける。RFC 9449 §8 / §8.2）。
 * クライアントは、拒否されたリクエストをやり直すときも、受け付けられた次のリクエストでも、この nonce を DPoP proof に入れる。
 * 次に、DPoP proof のクレームを、署名を確かめずに読み、`nonce` が無いか、`server` が `dpopNonceLifetimeSeconds` 秒の間に発行した nonce でなければ拒否する（`validateDpopProofNonce()`）。
 * 署名を確かめないので、ここを通った DPoP proof も、後の DPoP proof の検査が署名と一緒に `nonce` を確かめ直す。
 * nonce の鍵は環境変数 `OIDC_DPOP_NONCE_SECRET` の秘密から作る（`dpopNonceKeyOf()`）。
 *
 * @spec RFC 9449 §8
 * @spec RFC 9449 §8.2
 * @spec RFC 9449 §11.3
 * @throws {DpopError} `use_dpop_nonce`: DPoP proof の `nonce` を受け付けないとき
 * @throws {DpopError} `invalid_dpop_proof`: `DPoP` ヘッダーが複数あるとき、一つの JWT でないとき
 * @throws {Error} 秘密が 32 バイトより短いとき、設定の `dpopNonceLifetimeSeconds` が 0 以上の有限の数でないとき（設定の誤り）
 */
export async function requireDpopNonce(request: Request, server: DpopNonceServer): Promise<void> {
  const proof = readDpopProofHeader(request.headers.get('DPoP'));
  if (proof === undefined) return;
  const key = await dpopNonceKeyOf(process.env.OIDC_DPOP_NONCE_SECRET);
  const scope: DpopNonceScope = { server, issuer: config.issuer };
  const now = Math.floor(Date.now() / 1000);
  setResponseHeader(request, 'DPoP-Nonce', await issueDpopNonce(key, scope, now));
  const { claims } = decodeDpopProof(proof);
  await validateDpopProofNonce(claims, key, scope, { now, lifetimeSeconds: config.dpopNonceLifetimeSeconds });
}
