/**
 * EXTENSION (dpop): the check of the DPoP proof of a request (RFC 9449 §4.3),
 * shared by the blocks of token/route.ts, userinfo/route.ts and
 * (par)/par/route.ts. It reads the settings and the stores of provider.ts, so
 * only the modules those blocks call import it (never feature.ts).
 */
import {
  computeJwkThumbprint,
  consumeDpopProofJti,
  decodeDpopProof,
  validateDpopProofAccessTokenHash,
  validateDpopProofAlg,
  validateDpopProofClaims,
  validateDpopProofJwk,
  verifyDpopProofSignature,
} from '@maronn-openid-connect/dpop';
import { config, stores } from '../../provider';
import { dpopSigningAlgsOf } from './config';

/** The request a DPoP proof was sent with. */
export interface DpopProofTarget {
  /** The HTTP method of the request (compared with htm). */
  method: string;
  /** The path of the endpoint under the issuer (compared with htu, without the query and the fragment). */
  path: string;
  /** The access token sent with the proof to a protected resource (compared with ath); undefined at the token and PAR endpoints. */
  accessToken?: string;
}

/**
 * リクエストの DPoP proof を検査し、その鍵の JWK Thumbprint を返す。
 *
 * 次の順に `@maronn-openid-connect/dpop` の関数を呼ぶ（RFC 9449 §4.3）。
 * 1. JWS を分解し、`typ` が `dpop+jwt` であることと JOSE ヘッダーを確かめる（`decodeDpopProof()`）
 * 2. `alg` が設定の `dpopSigningAlgValuesSupported` にあることを確かめる（`validateDpopProofAlg()`）
 * 3. `jwk` が `alg` の公開鍵であることを確かめ、その鍵で署名を検証する（`validateDpopProofJwk()`、`verifyDpopProofSignature()`）
 * 4. `jti`、`htm`、`htu`、`iat` を確かめる（`validateDpopProofClaims()`）。`htu` は、プロキシの後ろでもクライアントが見る URL と比べられるよう、リクエストの URL ではなく issuer とエンドポイントのパスから組み立てる
 * 5. 保護されたリソースへのリクエストでは、`ath` がアクセストークンのハッシュであることを確かめる（`validateDpopProofAccessTokenHash()`）
 * 6. `jti` を消費し、同じ DPoP proof の再利用を拒否する（`consumeDpopProofJti()`）
 *
 * `jti` を覚えるストアには、private_key_jwt のクライアントアサーションの `jti` を覚えるストア（`stores.clientAssertionJtiStore`）を使う。
 * キーの形が違う（DPoP は `["dpop", jkt, jti]`）ので、二つの `jti` が重なることはない。
 * サーバーが発行する nonce（RFC 9449 §8 / §9）には対応していない。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §11.1
 * @throws {DpopError} `invalid_dpop_proof`: DPoP proof を受け付けないとき
 */
export async function verifyDpopRequestProof(proof: string, target: DpopProofTarget): Promise<string> {
  const decoded = decodeDpopProof(proof);
  validateDpopProofAlg(decoded.alg, dpopSigningAlgsOf(config));
  const jwk = validateDpopProofJwk(decoded.jwk, decoded.alg);
  await verifyDpopProofSignature(decoded, jwk);
  const claims = validateDpopProofClaims(decoded.claims, {
    method: target.method,
    uri: `${config.issuer}${target.path}`,
    now: Math.floor(Date.now() / 1000),
    maxAgeSeconds: config.dpopProofMaxAgeSeconds,
    leewaySeconds: config.dpopProofLeewaySeconds,
  });
  if (target.accessToken !== undefined) {
    await validateDpopProofAccessTokenHash(decoded.claims, target.accessToken);
  }
  const jkt = await computeJwkThumbprint(jwk);
  // 署名とクレームを確かめた後で消費する。検証できない DPoP proof の `jti` を覚えると、正しいクライアントの `jti` を先に使わせる妨害ができるためである。
  await consumeDpopProofJti(stores.clientAssertionJtiStore, { jkt, jti: claims.jti, replayWindowEndsAt: claims.replayWindowEndsAt });
  return jkt;
}
