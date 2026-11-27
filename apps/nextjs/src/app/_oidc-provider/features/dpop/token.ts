/**
 * EXTENSION (dpop): the block of token/route.ts (RFC 9449 §5).
 *
 * The token endpoint calls verifyDpopTokenRequest() in its
 * [verify-dpop-proof] block, right after client authentication and before
 * any grant is answered. A failure is answered with a ready-made Response the
 * block returns, so the base token endpoint needs no error type of this
 * feature.
 */
import { DPOP_TOKEN_TYPE, type TokenBinding } from '../../token-binding';
import { buildDpopConfirmation } from './binding';
import { tokenEndpointRejectionOf } from './error-responses';
import { readDpopProofHeader, verifyDpopRequestProof } from './proof';

/** What verifyDpopTokenRequest() decided. */
export interface DpopTokenRequest {
  /** The key the access token of the response is bound to; undefined issues Bearer tokens. */
  tokenBinding: TokenBinding | undefined;
  /** The error response to answer with when the DPoP proof was rejected. */
  dpopRejection?: Response;
}

/**
 * トークンリクエストの DPoP proof を検証し、発行するアクセストークンを束縛する鍵を返す。
 *
 * `DPoP` ヘッダーがなければ、`tokenBinding` が `undefined`（Bearer トークンを発行する）の結果を返す。
 * `DPoP` ヘッダーがあれば、DPoP proof を検査し（`htm` は POST、`htu` は issuer の `/token`）、その鍵への束縛を `tokenBinding` に入れて返す。
 * 返す `tokenBinding` は、アクセストークンの `cnf.jkt` をその鍵の JWK Thumbprint にし、`token_type` を `DPoP` にする（RFC 9449 §5 / §6.1）。
 * リフレッシュトークンを束縛する `refreshTokenCnf` は持たない。
 *
 * どのグラントの前にも実行するので、機能が答えるグラント（client_credentials など）のアクセストークンも同じ鍵に束縛する。
 * クライアントの認証の後に実行するので、認証に失敗したリクエストの DPoP proof は検査せず、その `jti` も覚えない。
 * 拒否するときは、キャッシュさせない 400 の `invalid_dpop_proof` のレスポンスを `dpopRejection` に入れて返す。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §5
 * @throws {Error} 設定の `dpopProofMaxAgeSeconds` か `dpopProofLeewaySeconds` が 0 以上の有限の数でないとき（設定の誤り。500 の `server_error` で応答する）
 */
export async function verifyDpopTokenRequest(request: Request): Promise<DpopTokenRequest> {
  try {
    // `DPoP` ヘッダーは一つだけでなければならない（RFC 9449 §4.3）。
    const proof = readDpopProofHeader(request.headers.get('DPoP'));
    if (proof === undefined) return { tokenBinding: undefined };

    const dpopJkt = await verifyDpopRequestProof(proof, { method: request.method, path: '/token' });
    return { tokenBinding: { cnf: buildDpopConfirmation(dpopJkt), tokenType: DPOP_TOKEN_TYPE } };
  } catch (error) {
    const dpopRejection = tokenEndpointRejectionOf(error);
    if (dpopRejection === undefined) throw error;
    return { tokenBinding: undefined, dpopRejection };
  }
}
