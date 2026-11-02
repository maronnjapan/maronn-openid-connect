/**
 * Token Introspection Endpoint (RFC 7662 §2).
 *
 * Confidential clients only: a caller registered with token_endpoint_auth_method
 * 'none' is rejected with invalid_client (RFC 7662 §2.1 / RFC 9701 §5), since a
 * public client_id alone is not authentication. Responses are never cached
 * (RFC 7662 §2.2).
 */
import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  requireIntrospectionToken,
  requireIntrospectionClient,
  requireConfidentialIntrospectionCaller,
  resolveIntrospectionToken,
  isIntrospectionTokenActive,
  buildIntrospectionResponse,
  INACTIVE_INTROSPECTION_RESPONSE,
  IntrospectionError,
  TokenError,
  type IntrospectionResponse,
} from '@maronn-openid-connect/core';
import { respondIntrospectionJwt } from '../../_oidc-provider/features/jwt-introspection-response/respond';
import { clientResolver, loadSigningKeys, stores } from '../../_oidc-provider/provider';
import { createIntrospectionResolvers } from '../../_oidc-provider/features/introspection/resolvers';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  noStoreJson,
  oauthError,
  signingKeysUnavailable,
  withCors,
} from '../../_oidc-provider/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const introspectionResolvers = createIntrospectionResolvers(stores);

/**
 * `introspect()` の結果に CORS ヘッダーを付けて返す。
 *
 * `POST /introspect` のイントロスペクションリクエストに、トークンの内容、`{ active: false }`、OAuth のエラーレスポンスのどれかで応答する。
 * CORS ヘッダーは `clientCors` の設定に従う。
 */
export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await introspect(request));
}

/**
 * CORS のプリフライトに、ボディなしの 204 で応答する。
 *
 * 対象は `/introspect` で、応答には `clientCors` のヘッダー（許可するオリジン、メソッド、ヘッダー、キャッシュしてよい秒数）を付ける。
 */
export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

/**
 * クライアントを認証し、トークンの内容で応答する。
 *
 * 呼び出し元はコンフィデンシャルクライアントに限る。
 * 有効なトークンには、その内容のイントロスペクションのレスポンスを、キャッシュさせない JSON で返す。
 * 登録されていない、期限切れ、まだ有効になっていない、ローテーションで使用済みになったトークンには、`{ active: false }` だけを返す。
 * `jwt-introspection-response` 機能を有効にしていれば、`application/token-introspection+jwt` を受け付ける呼び出し元には、同じ内容を署名付きの JWT で返す。
 *
 * エラーには、キャッシュさせない OAuth のエラーレスポンス（JSON）で応答する。
 * - 400 `invalid_request`: リクエストが不正なとき（ボディがフォームの形式でない、`token` がないなど）。
 * - 401 `invalid_client`（`WWW-Authenticate` ヘッダー付き）: クライアントの認証に失敗したとき、または呼び出し元がパブリッククライアントのとき。
 * - 500 `server_error`: そのほかの失敗のとき。
 *
 * 署名鍵を読み込めないときは、503 で応答する。
 *
 * @spec RFC 7662 §2
 */
async function introspect(request: Request): Promise<Response> {
  // [load-signing-keys] Load the signing keys — OIDC Core 1.0 §10.1
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  // [parse-request] Parse the introspection request — RFC 7662 §2.1
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }
  const params = Object.fromEntries(new URLSearchParams(await request.text()));

  try {
    // [authenticate-client] Authenticate the client — RFC 7662 §2.1 / OAuth 2.1 §2.3
    // トークンエンドポイントと同じ手順で、クライアントを認証する（OAuth 2.1 §2.3、OIDC Core 1.0 §9）。
    // イントロスペクションでは、呼び出し元の認証が必須である（RFC 7662 §2.1）。
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: request.headers.get('Authorization') ?? '',
    });
    const introspectingClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      clientResolver,
    );
    validateClientAuthMethod(introspectingClient, presentedCredentials);
    await verifyClientSecret(introspectingClient, presentedCredentials.clientSecret);
    // 呼び出し元がコンフィデンシャルクライアントであることを確かめ、パブリッククライアントなら `invalid_client` にする（RFC 7662 §2.1、RFC 9701 §5）。
    // `token_endpoint_auth_method` を `none` で登録したクライアントは、公開されている `client_id` を示すだけで上の手順を通るので、それを認証済みとして扱うと、誰でもトークンを探れてしまう。
    // 失効エンドポイントには、あえてこの確認を置いていない。
    // RFC 7009 §2.1 は、パブリッククライアントが自分のトークンを失効させることを認めているためである。
    requireConfidentialIntrospectionCaller(introspectingClient);
    const authenticatedClientId = presentedCredentials.clientId;

    // [resolve-token] Resolve the token — RFC 7662 §2.1
    // 以下の呼び出しはそれぞれ core の独立した関数で、RFC 7662 §2 の順に呼ぶ。
    // 呼び出しを消せばその処理を省け、呼び出しの間に独自の処理を挟める。

    // `token` パラメータは必須で、なければ `invalid_request` にする（RFC 7662 §2.1）。
    const token = requireIntrospectionToken({ token: params.token });

    // 呼び出し元がクライアントとして認証されていることを確かめ、されていなければ `invalid_client` にする（RFC 7662 §2.1）。
    requireIntrospectionClient(authenticatedClientId);

    // 提示されたトークンを、アクセストークンとリフレッシュトークンのストアから探す（RFC 7662 §2.1）。
    // `token_type_hint` は探す順番を変えるだけで、ヒントの種類で見つからなければもう一方の種類も探す。
    const resolved = await resolveIntrospectionToken({
      token,
      tokenTypeHint: params.token_type_hint,
      accessTokenResolver: introspectionResolvers.introspectionAccessTokenResolver,
      refreshTokenResolver: introspectionResolvers.introspectionRefreshTokenResolver,
    });

    // [build-response] Build the introspection response — RFC 7662 §2.2
    // トークンが有効ならその内容を、そうでなければ `{ active: false }` だけを返す（RFC 7662 §2.2）。
    // 登録されていない、期限切れ、まだ有効になっていない、ローテーションで使用済みになったトークンにはほかのメンバーを含めないので、呼び出し元は「存在しなかった」トークンと「もう有効でない」トークンを区別できない。
    let response: IntrospectionResponse = INACTIVE_INTROSPECTION_RESPONSE;
    if (resolved !== null && isIntrospectionTokenActive(resolved)) {
      response = buildIntrospectionResponse(resolved);
    }

    // [respond-jwt] (feature: jwt-introspection-response) Answer as a signed JWT when asked — RFC 9701 §4 / §5
    const jwtResponse = await respondIntrospectionJwt(request, response, authenticatedClientId, keys);
    if (jwtResponse) return jwtResponse;

    // [respond] Respond (no-store) — RFC 7662 §2.2
    return noStoreJson(response);
  } catch (error) {
    // [respond-error] Answer the error — RFC 7662 §2.3 / RFC 6749 §5.2
    if (error instanceof TokenError || error instanceof IntrospectionError) {
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
