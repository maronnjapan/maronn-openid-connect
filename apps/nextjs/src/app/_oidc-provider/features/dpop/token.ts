/**
 * EXTENSION (dpop): the blocks of token/route.ts (RFC 9449 §5 / §8).
 *
 * The token endpoint calls requireTokenDpopNonce() in its
 * [require-dpop-nonce] block, right before client authentication, then
 * verifyDpopTokenRequest() in its [verify-dpop-proof] block and
 * validateDpopGrantBinding() in its [validate-dpop-grant-binding] block,
 * right after client authentication and before any grant is answered. A
 * failure is answered with a ready-made Response the block returns, so the
 * base token endpoint needs no error type of this feature.
 */
import { isPublicTokenClient, type TokenClientInfo, type TokenRequestParams } from '@maronn-openid-connect/core';
import { config, stores } from '../../provider';
import { DPOP_TOKEN_TYPE, type TokenBinding } from '../../token-binding';
import {
  buildDpopConfirmation,
  dpopBoundAccessTokensOf,
  readDpopJkt,
  requireDpopProofForClient,
  selectDpopRefreshTokenJkt,
  validateDpopBoundGrant,
} from './binding';
import { tokenEndpointRejectionOf } from './error-responses';
import { readDpopProofHeader, verifyDpopRequestProof } from './proof';
import { authorizationServerNonceOf, requireDpopNonce } from './server-nonce';

/** What verifyDpopTokenRequest() decided. */
export interface DpopTokenRequest {
  /** The JWK Thumbprint of the key of the verified DPoP proof; undefined when the request had no DPoP header. */
  dpopJkt: string | undefined;
  /** The key the tokens of the response are bound to; undefined issues Bearer tokens. */
  tokenBinding: TokenBinding | undefined;
  /**
   * The error response to answer with when the DPoP proof was rejected, or was
   * missing from a request of a client registered with dpop_bound_access_tokens.
   */
  dpopRejection?: Response;
}

/**
 * 設定が認可サーバーに DPoP の nonce を求めるとき、`DPoP` ヘッダーのあるトークンリクエストへのレスポンスに次の nonce を付け、DPoP proof の nonce を確かめる。
 *
 * 設定の `dpopNonceRequiredAtAuthorizationServer` が false なら何もせず `undefined` を返す（nonce を渡さず、DPoP proof の `nonce` も確かめない）。
 * true なら、`DPoP` ヘッダーのあるリクエストへのどのレスポンス（トークンレスポンスもエラーレスポンスも）にも認可サーバーの新しい nonce を `DPoP-Nonce` ヘッダーで付け、DPoP proof に `nonce` が無いか、認可サーバーが最近発行した nonce でなければ拒否する（`requireDpopNonce()`。RFC 9449 §8 / §8.2 / §11.3）。
 * クライアントの認証の前に実行するので、nonce で拒否したリクエストのクライアントアサーション（`private_key_jwt`）の `jti` は消費しない。
 * クライアントは、同じクライアントアサーションと、渡された nonce を入れた DPoP proof でやり直せる。
 * DPoP proof の署名とほかのクレームは、クライアントの認証の後の DPoP proof の検査（`verifyDpopTokenRequest()`）が、`nonce` と一緒に確かめる。
 * 拒否するときは、キャッシュさせない 400 のレスポンスを返す。`error` は、nonce を受け付けないときは `use_dpop_nonce`、`DPoP` ヘッダーが複数あるときと一つの JWT でないときは `invalid_dpop_proof` である。
 *
 * @spec RFC 9449 §8
 * @spec RFC 9449 §8.2
 * @spec RFC 9449 §11.3
 * @throws {Error} 秘密が 32 バイトより短いとき、設定の `dpopNonceLifetimeSeconds` が 0 以上の有限の数でないとき（設定の誤り。500 の `server_error` で応答する）
 */
export async function requireTokenDpopNonce(request: Request): Promise<Response | undefined> {
  const server = authorizationServerNonceOf(config);
  if (server === undefined) return undefined;
  try {
    await requireDpopNonce(request, server);
    return undefined;
  } catch (error) {
    const rejection = tokenEndpointRejectionOf(error);
    if (rejection === undefined) throw error;
    return rejection;
  }
}

/**
 * トークンリクエストの DPoP proof を検証し、その鍵の JWK Thumbprint と、発行するトークンを束縛する鍵を返す。
 *
 * `DPoP` ヘッダーがなければ、`dpopJkt` と `tokenBinding` が `undefined`（Bearer トークンを発行する）の結果を返す。
 * ただし、`dpop_bound_access_tokens` を登録したクライアント（`dpopBoundAccessTokensOf()`）の、`DPoP` ヘッダーの無いリクエストは拒否する（RFC 9449 §5.2 の MUST）。
 * `DPoP` ヘッダーがあれば、DPoP proof を検査し（`htm` は POST、`htu` は issuer の `/token`）、その鍵の JWK Thumbprint を `dpopJkt` に、その鍵への束縛を `tokenBinding` に入れて返す。
 * 設定の `dpopNonceRequiredAtAuthorizationServer` が true なら、DPoP proof の `nonce` が認可サーバーの最近発行した nonce であることも、署名と一緒に確かめる（RFC 9449 §8 / §11.3）。
 * 返す `tokenBinding` は、アクセストークンの `cnf.jkt` をその鍵の JWK Thumbprint にし、`token_type` を `DPoP` にする（RFC 9449 §5 / §6.1）。
 * パブリッククライアントには、リフレッシュトークンも同じ鍵に束縛する `refreshTokenCnf` を持たせる（RFC 9449 §5 の MUST）。
 * コンフィデンシャルクライアントのリフレッシュトークンは、クライアント認証で送り手が限られているので束縛しない。
 *
 * どのグラントの前にも実行するので、機能が答えるグラント（client_credentials など）のトークンも同じ鍵に束縛する。
 * クライアントの認証の後に実行するので、認証に失敗したリクエストの DPoP proof の署名とクレームは検査せず、その `jti` も覚えない（認可サーバーが nonce を求めるときも、認証の前のブロックは `nonce` だけを確かめる）。
 * 拒否するときは、キャッシュさせない 400 の `invalid_dpop_proof`（nonce を受け付けないときは `use_dpop_nonce`）のレスポンスを `dpopRejection` に入れて返す。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §5
 * @spec RFC 9449 §5.2
 * @throws {Error} 設定の `dpopProofMaxAgeSeconds` か `dpopProofLeewaySeconds` が 0 以上の有限の数でないとき（設定の誤り。500 の `server_error` で応答する）
 */
export async function verifyDpopTokenRequest(request: Request, tokenClient: TokenClientInfo): Promise<DpopTokenRequest> {
  try {
    // `DPoP` ヘッダーは一つだけでなければならない（RFC 9449 §4.3）。
    const proof = readDpopProofHeader(request.headers.get('DPoP'));

    // `dpop_bound_access_tokens` を登録したクライアントは、常に DPoP を使う（RFC 9449 §5.2）。
    requireDpopProofForClient(dpopBoundAccessTokensOf(tokenClient), proof);
    if (proof === undefined) return { dpopJkt: undefined, tokenBinding: undefined };

    const dpopJkt = await verifyDpopRequestProof(proof, {
      method: request.method,
      path: '/token',
      nonceServer: authorizationServerNonceOf(config),
    });

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
 * 束縛した鍵は、保存したレコードの `cnf.jkt` にある。
 * リフレッシュトークンは、パブリッククライアントが DPoP proof を送って得たときに束縛されている（RFC 9449 §5）。
 * 認可コードは、認可リクエストの確認（`cnf`）を引き継いだときに束縛されている（RFC 9449 §10）。
 * DPoP proof がないか、別の鍵の DPoP proof なら、キャッシュさせない 400 の `invalid_grant` のレスポンスを返す。
 * 受け付けるときは `undefined` を返す。
 *
 * グラントを検証するブロックより前に実行するので、拒否したリクエストでは、認可コードを使用済みにせず、トークンを発行せず、リフレッシュトークンもローテーションしない。
 * 使用済みのもの、別のクライアントのもの、見つからないものは確かめず、後のグラントの検証に任せる。
 * 使用済みのコードやトークンの再提示は、グラントの検証がそのグラントのトークンを失効させる（OAuth 2.1 §4.1.2 / §4.3.1）ので、ここで先に拒否しない。
 *
 * @spec RFC 9449 §5
 * @spec RFC 9449 §10
 */
export async function validateDpopGrantBinding(
  params: Pick<TokenRequestParams, 'grant_type' | 'code' | 'refresh_token'>,
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
async function boundGrantRecordOf(
  params: Pick<TokenRequestParams, 'grant_type' | 'code' | 'refresh_token'>,
): Promise<{ used: boolean; clientId: string } | undefined> {
  if (params.grant_type === 'authorization_code' && typeof params.code === 'string') {
    return (await stores.authCodeStore.get(params.code)) ?? undefined;
  }
  if (params.grant_type === 'refresh_token' && typeof params.refresh_token === 'string') {
    return (await stores.refreshTokenStore.get(params.refresh_token)) ?? undefined;
  }
  return undefined;
}
