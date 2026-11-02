/**
 * EXPERIMENTAL — Pushed Authorization Request Endpoint (RFC 9126 §2).
 *
 * Generated because the OP was created with `--enable par`. Backed by
 * @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The client POSTs the authorization request parameters here (back channel,
 * authenticated) and receives a short-lived request_uri that it then passes to
 * /authorize.
 *
 * NOTE (RFC 9126 §2.3): request size limits (413) and rate limiting (429) are
 * left to the deployment layer (reverse proxy / platform). This endpoint is
 * unauthenticated until the client credentials are checked, so put a rate
 * limit in front of it in production.
 */
import {
  ParError,
  authenticateParClient,
  buildPushedAuthorizationResponse,
  createPushedAuthorizationRecord,
  rejectForbiddenParParams,
  validatePushedAuthorizationParams,
} from '@maronn-openid-connect/experimental/par';
import { sanitizeErrorDescription } from '@maronn-openid-connect/core';
import { clientResolver, config } from '../../_oidc-provider/provider';
import { parStore } from '../../_oidc-provider/features/par/store';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  uniqueParams,
  withCors,
} from '../../_oidc-provider/http';
import { parConfig } from '../../_oidc-provider/features/par/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PAR の応答に CORS のヘッダーを付けて返す。
 *
 * `POST /par` のリクエストを `pushAuthorizationRequest()` で処理し、その応答（成功すれば `request_uri` を含む 201、失敗すれば OAuth のエラー）に `clientCors` のヘッダーを付けて返す。
 */
export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await pushAuthorizationRequest(request));
}

/**
 * CORS のプリフライトに、ボディなしの 204 で応答する。
 *
 * 対象は `/par` で、応答には `clientCors` のヘッダー（許可するオリジン、メソッド、ヘッダー、キャッシュしてよい秒数）を付ける。
 */
export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

/**
 * 認可のパラメータを検証して保存し、201 で応答する。
 *
 * クライアントを認証し、プッシュされたパラメータを `/authorize` と同じ規則で検証して保存する。
 * 201 のボディには、`/authorize` に渡す `request_uri` とその有効期間（`expires_in`）を入れ、キャッシュを禁止して返す。
 *
 * 失敗したときは、キャッシュを禁止した OAuth のエラーの JSON で次のように応答する。
 * - ボディがフォームの形式でないとき、パラメータが繰り返されたとき、`request_uri` か `request` が含まれるときは、400 の `invalid_request`
 * - クライアントの認証に失敗したときは、`WWW-Authenticate` ヘッダーを付けた 401 の `invalid_client`
 * - パラメータが正しくないとき（`redirect_uri`、`scope`、PKCE など）は、`/authorize` と同じエラーの 400
 * - それ以外の失敗は、500 の `server_error`
 *
 * @spec RFC 9126 §2
 */
async function pushAuthorizationRequest(request: Request): Promise<Response> {
  // ボディが `application/x-www-form-urlencoded` でなければ、400 の `invalid_request` で応答する（RFC 9126 §2.1）。
  if (!isFormUrlEncoded(request)) {
    return parJson(
      { error: 'invalid_request', error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded' },
      400,
    );
  }

  // 同じ名前のパラメータが繰り返されていれば、400 の `invalid_request` で応答する（RFC 6749 §3.1）。
  const { params, duplicateKey } = uniqueParams(new URLSearchParams(await request.text()));
  if (duplicateKey !== undefined) {
    return parJson(
      { error: 'invalid_request', error_description: `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated` },
      400,
    );
  }

  try {
    // 以下は、プッシュされた認可リクエストを処理するパイプラインである。
    // 各ステップは `@maronn-openid-connect/experimental/par` の独立した関数で、RFC 9126 §2.1 の順に呼ぶ。
    // 呼び出しを消せばその検証を外せ、ステップの間に独自の処理を挟むこともできる。

    // `request_uri` か `request` を含むリクエストを、`invalid_request` で拒否する。
    // `request_uri` はプッシュしてはならず（RFC 9126 §2.1 の MUST NOT）、`request` パラメータ（リクエストオブジェクトとの併用、RFC 9126 §3）にはこの生成された OP が対応していない。
    rejectForbiddenParParams(params);

    // トークンエンドポイントとまったく同じ規則で、クライアントを認証する（RFC 9126 §2.1）。
    // パブリッククライアントは認証情報を送らず、`client_id` だけを送る。
    const clientId = await authenticateParClient({
      params,
      authorizationHeader: request.headers.get('Authorization') ?? '',
      clientResolver,
    });

    // `client_id` は認可リクエストの必須のパラメータなので（RFC 9126 §2.1）、検証と保存の前に、認証したクライアントの ID に置き換える。
    const pushedParams = { ...params, client_id: clientId };

    // パラメータを、認可エンドポイントと同じ規則で検証する（RFC 9126 §2.1）。
    // 登録されていない `redirect_uri` や不正な `scope` は、エンドユーザーが画面を見る前にここで拒否する。
    await validatePushedAuthorizationParams(pushedParams, clientResolver, {
      allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
    });

    // 暗号論的な乱数で参照値を作り、その参照値でリクエストを保存する（RFC 9126 §2.2、§7.1）。
    // クライアントの認証情報は保存しない。
    const record = await createPushedAuthorizationRecord({
      clientId,
      params: pushedParams,
      store: parStore,
      expiresInSeconds: parConfig.expiresInSeconds,
    });
    const response = buildPushedAuthorizationResponse(record);

    // プッシュされたパラメータそのものは、ログに出さない。
    // `login_hint` などの個人情報を含むことがあり、`Authorization` ヘッダーには `client_secret` が含まれる。

    // `request_uri` と `expires_in` を、キャッシュを禁止した JSON の 201 で返す（RFC 9126 §2.2）。
    return parJson({ request_uri: response.requestUri, expires_in: response.expiresIn }, 201);
  } catch (error) {
    if (error instanceof ParError) {
      // `ParError` はトークンエンドポイントと同じ形の JSON のエラーで返し、リダイレクトはしない（RFC 9126 §2.3）。
      return parJson(
        { error: error.code, error_description: error.errorDescription },
        error.statusCode,
        error.wwwAuthenticate,
      );
    }
    return parJson({ error: 'server_error' }, 500);
  }
}

/**
 * キャッシュを禁止した JSON のレスポンスを返す。
 *
 * PAR のレスポンスはどれも、キャッシュさせてはならない JSON である（RFC 9126 §2.2、§2.3）。
 * `Cache-Control: no-cache, no-store` と `Pragma: no-cache` を付け、`wwwAuthenticate` を渡したときは `WWW-Authenticate` ヘッダーにも設定する。
 *
 * @spec RFC 9126 §2.2
 * @spec RFC 9126 §2.3
 */
function parJson(body: unknown, status: number, wwwAuthenticate?: string): Response {
  const headers = new Headers({ 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' });
  if (wwwAuthenticate) headers.set('WWW-Authenticate', wwwAuthenticate);
  return Response.json(body, { status, headers });
}
