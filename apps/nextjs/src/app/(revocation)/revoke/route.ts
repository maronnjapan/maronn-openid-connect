/**
 * Token Revocation Endpoint (RFC 7009 §2).
 *
 * Confidential clients authenticate with their registered method; public
 * clients registered with token_endpoint_auth_method=none identify themselves
 * with client_id alone (RFC 7009 §2.1). "Revoked" and "not found" both answer
 * 200 with no body, so the endpoint reveals nothing about which tokens exist
 * (§2.2). Revoking a refresh token also revokes the access tokens of the same
 * grant (§2.1 SHOULD).
 */
import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  requireRevocationToken,
  requireRevocationClient,
  resolveRevocationTarget,
  validateRevocationTokenClient,
  revokeResolvedToken,
  revokeGrantAccessTokens,
  RevocationError,
  TokenError,
} from '@maronn-openid-connect/core';
import { clientResolver, stores } from '../../_oidc-provider/provider';
import { createRevocationResolvers } from '../../_oidc-provider/features/revocation/resolvers';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  oauthError,
  withCors,
} from '../../_oidc-provider/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const revocationResolvers = createRevocationResolvers(stores);

/**
 * `revoke()` の結果に CORS ヘッダーを付けて返す。
 *
 * `POST /revoke` の失効リクエストに、ボディが空の 200 か、OAuth のエラーレスポンスで応答する。
 * CORS ヘッダーは `clientCors` の設定に従う。
 */
export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await revoke(request));
}

/**
 * CORS のプリフライトに、ボディなしの 204 で応答する。
 *
 * 対象は `/revoke` で、応答には `clientCors` のヘッダー（許可するオリジン、メソッド、ヘッダー、キャッシュしてよい秒数）を付ける。
 */
export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

/**
 * クライアントを認証し、提示されたトークンを失効させる。
 *
 * トークンがそのクライアントに発行されたものなら失効させ、リフレッシュトークンのときは同じグラントのアクセストークンも失効させる。
 * 成功したときは、トークンが見つからなかったときも含めて、キャッシュさせない空のボディの 200 で応答する。
 * パブリッククライアントは、`client_id` だけで自分を示す。
 *
 * エラーには、キャッシュさせない OAuth のエラーレスポンス（JSON）で応答する。
 * - 400 `invalid_request`: リクエストが不正なとき（ボディがフォームの形式でない、`token` がないなど）。
 * - 400 `invalid_grant`: トークンがほかのクライアントに発行されたものであるとき。
 * - 401 `invalid_client`（`WWW-Authenticate` ヘッダー付き）: クライアントの認証に失敗したとき。
 * - 500 `server_error`: そのほかの失敗のとき。
 *
 * @spec RFC 7009 §2
 */
async function revoke(request: Request): Promise<Response> {
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }
  const params = Object.fromEntries(new URLSearchParams(await request.text()));

  try {
    // クライアントの認証：トークンエンドポイントと同じ手順で、クライアントを認証する（OAuth 2.1 §2.3、OIDC Core 1.0 §9）。
    // `token_endpoint_auth_method` を `none` で登録したパブリッククライアントは、`client_id` だけで通る（RFC 7009 §2.1）。
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: request.headers.get('Authorization') ?? '',
    });
    const revokingClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      clientResolver,
    );
    validateClientAuthMethod(revokingClient, presentedCredentials);
    await verifyClientSecret(revokingClient, presentedCredentials.clientSecret);
    const authenticatedClientId = presentedCredentials.clientId;

    // トークンの失効：以下の呼び出しはそれぞれ core の独立した関数で、RFC 7009 §2 の順に呼ぶ。
    // 呼び出しを消せばその処理を省け、呼び出しの間に独自の処理を挟める。

    // `token` パラメータは必須で、なければ `invalid_request` にする（RFC 7009 §2.1）。
    const token = requireRevocationToken({ token: params.token });

    // 呼び出し元のクライアントが識別されていることを確かめ、されていなければ `invalid_client` にする（RFC 7009 §2.1）。
    requireRevocationClient(authenticatedClientId);

    // 提示されたトークンを、アクセストークンとリフレッシュトークンのストアから探す（RFC 7009 §2.1）。
    // `token_type_hint` は探す順番を変えるだけで、ヒントの種類で見つからなければもう一方の種類も探す。
    const resolved = await resolveRevocationTarget({
      token,
      tokenTypeHint: params.token_type_hint,
      resolvers: revocationResolvers,
    });

    // トークンが見つからなければ何もせず、成功として応答する（RFC 7009 §2.2）。
    // 失敗として応答すると、どのトークンの値が存在するかをクライアントが探れてしまうためである。
    if (resolved !== null) {
      // ほかのクライアントに発行されたトークンなら、`invalid_grant` で拒否する（RFC 7009 §2.1）。
      validateRevocationTokenClient(resolved, authenticatedClientId);

      await revokeResolvedToken(token, resolved, revocationResolvers);

      // リフレッシュトークンを失効させたときは、同じグラントのアクセストークンも失効させる（RFC 7009 §2.1 の SHOULD）。
      // 提示されたトークンだけを失効させたいときは、この呼び出しを消す。
      await revokeGrantAccessTokens(resolved, revocationResolvers);
    }

    // ボディが空の 200 で応答し、キャッシュさせない（RFC 7009 §2.2）。
    return new Response(null, {
      status: 200,
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  } catch (error) {
    if (error instanceof TokenError || error instanceof RevocationError) {
      return oauthError(
        error.error,
        error.errorDescription,
        error.statusCode,
        error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
      );
    }
    return oauthError('server_error', undefined, 500);
  }
}
