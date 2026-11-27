/**
 * EXTENSION (dpop): the DPoP nonces the endpoints of this OP require
 * (RFC 9449 §8 / §9). An endpoint of the authorization server that requires
 * them calls requireDpopNonce() after it parses the request and before it
 * authenticates the client: from then on, every response to a request with
 * one DPoP header carries a new nonce (the DPoP-Nonce header, through
 * setResponseHeader() of http.ts, which withCors() puts on the answer), and a
 * proof without a nonce the server recently provided is rejected. It decodes
 * the proof without checking its signature, so a DPoP header that is not one
 * well-formed DPoP proof is rejected then too. The proof checks after client
 * authentication (proof.ts) check the nonce again with the signature, for the
 * server authorizationServerNonceOf() returns. The protected resource (the
 * UserInfo endpoint) gives a request presented with the DPoP scheme a new
 * nonce with provideDpopNonce(), and its proof check requires one, for the
 * server resourceServerNonceOf() returns.
 *
 * It reads provider.ts and imports http.ts, so only token.ts, par.ts and
 * userinfo.ts import it (see feature.ts).
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
 * 設定が保護されたリソースに DPoP の nonce を求めるなら、nonce を発行して確かめるサーバーの役割（`'resource-server'`）を返す。
 *
 * 設定の `dpopNonceRequiredAtResourceServer` が false なら `undefined` を返す。
 * 保護されたリソース（UserInfo エンドポイント）は、返った役割を {@link provideDpopNonce} と DPoP proof の検査（`DpopProofTarget.nonceServer`）に渡す。
 * `undefined` のときは、nonce を渡さず、DPoP proof の `nonce` も確かめない（RFC 9449 §11.3）。
 * 認可サーバーとは役割が違うので、認可サーバーの nonce は受け付けず、保護されたリソースの nonce は認可サーバーが受け付けない（RFC 9449 §9）。
 *
 * @spec RFC 9449 §9
 * @spec RFC 9449 §11.3
 */
export function resourceServerNonceOf(
  settings: Pick<ProviderConfig, 'dpopNonceRequiredAtResourceServer'>,
): DpopNonceServer | undefined {
  return settings.dpopNonceRequiredAtResourceServer ? 'resource-server' : undefined;
}

/**
 * `request` へのレスポンスに、`server` が今発行した nonce を `DPoP-Nonce` ヘッダーで一つ付ける。
 *
 * ヘッダーは `setResponseHeader()` で設定し、Route Handler の `withCors()` が付けるので、この後でブロックが返すどのレスポンス（成功もエラーも）にも付く。
 * クライアントは、拒否されたリクエストをやり直すときも、受け付けられた次のリクエストでも、この nonce を DPoP proof に入れる（RFC 9449 §8 / §8.2 / §9）。
 * nonce の鍵は環境変数 `OIDC_DPOP_NONCE_SECRET` の秘密から作る（`dpopNonceKeyOf()`）。
 *
 * @spec RFC 9449 §8.2
 * @spec RFC 9449 §9
 * @throws {Error} 秘密が 32 バイトより短いとき（設定の誤り）
 */
export async function provideDpopNonce(request: Request, server: DpopNonceServer): Promise<void> {
  const key = await dpopNonceKeyOf(process.env.OIDC_DPOP_NONCE_SECRET);
  setResponseHeader(request, 'DPoP-Nonce', await issueDpopNonce(key, { server, issuer: config.issuer }, Math.floor(Date.now() / 1000)));
}

/**
 * `DPoP` ヘッダーのあるリクエストへのレスポンスに `server` の新しい nonce を付け、DPoP proof の `nonce` が `server` の最近発行した nonce であることを確かめる。
 *
 * `DPoP` ヘッダーがなければ何もしない（DPoP を使わないリクエストには、nonce を渡さず、求めもしない）。
 * `DPoP` ヘッダーが一つの値（空でなく、空白もコンマも含まない）なら、拒否するときも含め、このリクエストへのレスポンスに、`server` が今発行した nonce を `DPoP-Nonce` ヘッダーで一つだけ付ける（`setResponseHeader()` で設定し、Route Handler の `withCors()` が付ける。RFC 9449 §8 / §8.2）。
 * クライアントは、拒否されたリクエストをやり直すときも、受け付けられた次のリクエストでも、この nonce を DPoP proof に入れる。
 * 次に、DPoP proof を署名を確かめずに分解し（`decodeDpopProof()`。JWS のコンパクト形式で、JOSE ヘッダーの `typ` が `dpop+jwt`、`alg` と `jwk` があり、`crit` が無いものだけを受け付ける）、`nonce` が無いか、`server` が `dpopNonceLifetimeSeconds` 秒の間に発行した nonce でなければ拒否する（`validateDpopProofNonce()`）。
 * 署名を確かめないので、ここを通った DPoP proof も、後の DPoP proof の検査が署名と一緒に `nonce` を確かめ直す。
 * nonce の鍵は環境変数 `OIDC_DPOP_NONCE_SECRET` の秘密から作る（`dpopNonceKeyOf()`）。
 *
 * @spec RFC 9449 §8
 * @spec RFC 9449 §8.2
 * @spec RFC 9449 §11.3
 * @throws {DpopError} `use_dpop_nonce`: DPoP proof の `nonce` を受け付けないとき
 * @throws {DpopError} `invalid_dpop_proof`: `DPoP` ヘッダーが一つの DPoP proof の形でないとき（複数ある、空か空白を含む、JWS のコンパクト形式でない、`typ` が `dpop+jwt` でない、`alg` か `jwk` が無い、`crit` がある）
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
