/**
 * EXTENSION (dpop): the blocks of token/route.ts (RFC 9449 §5).
 *
 * The token endpoint calls verifyDpopTokenRequest() in its
 * [verify-dpop-proof] block and validateDpopGrantBinding() in its
 * [validate-dpop-grant-binding] block, right after client authentication and
 * before any grant is answered. A failure is answered with a ready-made
 * Response the block returns, so the base token endpoint needs no error type
 * of this feature.
 */
import { isPublicTokenClient, type TokenClientInfo } from '@maronn-openid-connect/core';
import {
  DPOP_TOKEN_TYPE,
  buildDpopConfirmation,
  readDpopJkt,
  readDpopProofHeader,
  requireDpopProofForClient,
  selectDpopRefreshTokenJkt,
  validateDpopBoundGrant,
} from '@maronn-openid-connect/dpop';
import type { RegisteredClient } from '../../config';
import { stores } from '../../provider';
import type { TokenBinding } from '../../token-binding';
import { tokenEndpointRejectionOf } from './errors';
import { verifyDpopRequestProof } from './proof';

/** What verifyDpopTokenRequest() decided. */
export interface DpopTokenRequest {
  /** The JWK Thumbprint of the key of the verified DPoP proof; undefined when the request had no DPoP header. */
  dpopJkt: string | undefined;
  /** The key the tokens of the response are bound to; undefined issues Bearer tokens. */
  tokenBinding: TokenBinding | undefined;
  /** The error response to answer with when the DPoP proof was rejected. */
  dpopRejection?: Response;
}

/**
 * トークンリクエストの DPoP proof を検証し、発行するトークンを束縛する鍵を返す。
 *
 * `DPoP` ヘッダーがなければ、`dpopJkt` と `tokenBinding` が `undefined`（Bearer トークンを発行する）の結果を返す。
 * ただし、`dpop_bound_access_tokens` を登録したクライアントのリクエストは拒否する（RFC 9449 §5.2 の MUST）。
 * `DPoP` ヘッダーがあれば、DPoP proof を検査し（`htm` は POST、`htu` は issuer の `/token`）、その鍵の JWK Thumbprint を返す。
 * 返す `tokenBinding` は、アクセストークンをその鍵に束縛し（`cnf.jkt`、`token_type` は `DPoP`。RFC 9449 §5 / §6.1）、
 * パブリッククライアントにはリフレッシュトークンも同じ鍵に束縛する（RFC 9449 §5 の MUST）。
 * コンフィデンシャルクライアントのリフレッシュトークンは、クライアント認証で送り手が限られているので束縛しない。
 *
 * どのグラントの前にも実行するので、機能が答えるグラント（client_credentials など）のトークンも同じ鍵に束縛する。
 * 拒否するときは、キャッシュさせない 400 の `invalid_dpop_proof` のレスポンスを `dpopRejection` に入れて返す。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §5
 * @spec RFC 9449 §5.2
 */
export async function verifyDpopTokenRequest(request: Request, tokenClient: TokenClientInfo): Promise<DpopTokenRequest> {
  try {
    // `DPoP` ヘッダーは一つだけでなければならない（RFC 9449 §4.3）。
    const proof = readDpopProofHeader(request.headers.get('DPoP'));

    // `dpop_bound_access_tokens` を登録したクライアントは、常に DPoP を使う（RFC 9449 §5.2）。
    requireDpopProofForClient((tokenClient as RegisteredClient).dpopBoundAccessTokens, proof);
    if (proof === undefined) return { dpopJkt: undefined, tokenBinding: undefined };

    const dpopJkt = await verifyDpopRequestProof(proof, { method: request.method, path: '/token' });

    // パブリッククライアントのリフレッシュトークンは、DPoP proof の鍵に束縛する（RFC 9449 §5）。
    const refreshTokenJkt = selectDpopRefreshTokenJkt(isPublicTokenClient(tokenClient), dpopJkt);
    return {
      dpopJkt,
      tokenBinding: {
        cnf: buildDpopConfirmation(dpopJkt),
        tokenType: DPOP_TOKEN_TYPE,
        ...(refreshTokenJkt === undefined ? {} : { refreshTokenCnf: buildDpopConfirmation(refreshTokenJkt) }),
      },
    };
  } catch (error) {
    const dpopRejection = tokenEndpointRejectionOf(error);
    if (dpopRejection === undefined) throw error;
    return { dpopJkt: undefined, tokenBinding: undefined, dpopRejection };
  }
}

/**
 * 提示された認可コードかリフレッシュトークンが DPoP の鍵に束縛されていれば、DPoP proof が同じ鍵のものであることを確かめる。
 *
 * 認可コードは、認可リクエストの `dpop_jkt`（PAR では `DPoP` ヘッダーの鍵）に束縛されている（RFC 9449 §10）。
 * リフレッシュトークンは、パブリッククライアントが DPoP proof を送って得たときに束縛されている（RFC 9449 §5）。
 * 束縛した鍵はレコードの `cnf.jkt` にあり、DPoP proof がないか、別の鍵の DPoP proof なら、キャッシュさせない 400 の `invalid_grant` のレスポンスを返す。
 * 受け付けるときは `undefined` を返す。
 *
 * 認可コードとリフレッシュトークンを検証して使用済みにするブロックより前に実行し、別の鍵のリクエストではコードやトークンを使用済みにしない。
 * 使用済みのもの、別のクライアントのもの、見つからないものは確かめず、後のグラントの検証に任せる。
 * 使用済みのコードやトークンの再提示は、グラントの検証がそのグラントのトークンを失効させる（OAuth 2.1 §4.1.2 / §4.3.1）ので、ここで先に拒否しない。
 *
 * @spec RFC 9449 §5
 * @spec RFC 9449 §10
 */
export async function validateDpopGrantBinding(
  params: Record<string, string>,
  authenticatedClientId: string,
  dpopJkt: string | undefined,
): Promise<Response | undefined> {
  const record = await boundGrantRecordOf(params);
  if (record === undefined || record.used || record.clientId !== authenticatedClientId) return undefined;
  try {
    validateDpopBoundGrant(readDpopJkt(record), dpopJkt);
    return undefined;
  } catch (error) {
    const rejection = tokenEndpointRejectionOf(error);
    if (rejection === undefined) throw error;
    return rejection;
  }
}

/**
 * トークンリクエストが提示した認可コードかリフレッシュトークンの、保存したレコードを返す。
 *
 * `grant_type` が `authorization_code` なら `code` の、`refresh_token` なら `refresh_token` のレコードを返す。
 * ほかのグラントと、見つからないものには `undefined` を返す。
 */
async function boundGrantRecordOf(params: Record<string, string>): Promise<{ used: boolean; clientId: string } | undefined> {
  if (params.grant_type === 'authorization_code' && typeof params.code === 'string') {
    return (await stores.authCodeStore.get(params.code)) ?? undefined;
  }
  if (params.grant_type === 'refresh_token' && typeof params.refresh_token === 'string') {
    return (await stores.refreshTokenStore.get(params.refresh_token)) ?? undefined;
  }
  return undefined;
}
