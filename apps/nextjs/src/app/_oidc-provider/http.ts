/**
 * Request and response helpers shared by the OP's Route Handlers and Server
 * Actions.
 *
 * - CORS: the back-channel endpoints may be called from client applications in
 *   the browser; discovery and JWKS are public. Each Route Handler exports an
 *   OPTIONS handler (corsPreflight) and wraps its answers with withCors.
 * - Responses that carry credentials are never cached (RFC 6749 §5.1 / §5.2).
 * - OAuth request parameters must not be repeated (RFC 6749 §3.1 / §3.2), which
 *   Object.fromEntries(searchParams) would hide by keeping only the last value.
 * - An error that must not reach the client ends on the OP's error page
 *   (app/oidc-error): errorPagePath() / redirectToErrorPage().
 */
import { NextResponse } from 'next/server';
import { config, corsOrigins } from './provider';

export interface CorsPolicy {
  origins: string | readonly string[];
  allowMethods: readonly string[];
  allowHeaders: readonly string[];
  maxAge: number;
}

/**
 * Endpoints client applications call directly (token, userinfo, introspect,
 * revoke, ...): only the origins configured in provider.ts.
 */
export const clientCors: CorsPolicy = {
  origins: corsOrigins,
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  maxAge: 600,
};

/** Public metadata (discovery, JWKS): readable from any origin. */
export const publicCors: CorsPolicy = {
  origins: '*',
  allowMethods: ['GET', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 600,
};

/**
 * CORS のプリフライトに、ボディなしの 204 で応答する。
 *
 * 応答には、`policy` から `corsHeaders()` が作る CORS のヘッダーを付ける。
 */
export function corsPreflight(request: Request, policy: CorsPolicy): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, policy) });
}

/**
 * レスポンスに `policy` の CORS のヘッダーを付けて返す。
 *
 * ボディ、ステータス、ヘッダーを写した新しいレスポンスを作り、`corsHeaders()` が作る CORS のヘッダーで上書きする。
 */
export function withCors(request: Request, policy: CorsPolicy, response: Response): Response {
  const headers = new Headers(response.headers);
  corsHeaders(request, policy).forEach((value, name) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * リクエストに返す CORS のヘッダーを作って返す。
 *
 * `Vary: Origin` と、`policy` の許可するメソッド、許可するヘッダー、キャッシュしてよい秒数を必ず入れる。
 * `allowedOrigin()` がリクエストの `Origin` を許可すれば、`Access-Control-Allow-Origin` も入れる。
 */
function corsHeaders(request: Request, policy: CorsPolicy): Headers {
  const headers = new Headers();
  const origin = allowedOrigin(request.headers.get('Origin'), policy.origins);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', policy.allowMethods.join(','));
  headers.set('Access-Control-Allow-Headers', policy.allowHeaders.join(','));
  headers.set('Access-Control-Max-Age', String(policy.maxAge));
  return headers;
}

/**
 * `Access-Control-Allow-Origin` に入れる値を返す。
 *
 * `allowed` が一つの文字列（`*` か一つのオリジン）なら、リクエストの `Origin` にかかわらずその文字列を返す。
 * 配列なら、リクエストの `Origin` が含まれるときだけその値を返し、それ以外は `undefined` を返す（ヘッダーを付けない）。
 */
function allowedOrigin(
  requestOrigin: string | null,
  allowed: string | readonly string[],
): string | undefined {
  if (typeof allowed === 'string') return allowed;
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return undefined;
}

/**
 * キャッシュを禁じるヘッダー付きの JSON で応答する。
 *
 * `init` のヘッダーに `Cache-Control: no-store` と `Pragma: no-cache` を加え、`body` を JSON にして返す。
 * トークンレスポンスやイントロスペクションのレスポンスなど、認証情報を含むレスポンスに使う（RFC 6749 §5.1、§5.2）。
 */
export function noStoreJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  return Response.json(body, { ...init, headers });
}

/**
 * キャッシュされない OAuth のエラーレスポンスを返す。
 *
 * ボディは `error` と `error_description` の JSON で、ステータスコードは `status`（既定は 400）である。
 * `noStoreJson()` で返すので、キャッシュを禁じるヘッダーが付く。
 *
 * @spec RFC 6749 §5.2
 */
export function oauthError(
  error: string,
  errorDescription: string | undefined,
  status = 400,
  headers?: HeadersInit,
): Response {
  return noStoreJson({ error, error_description: errorDescription }, { status, headers });
}

/**
 * 署名鍵を使えないときの 503 のエラーレスポンスを返す。
 *
 * ボディは `server_error` のエラーの JSON である。
 * 署名鍵を読み込めないとき（鍵のプロバイダの障害など）と、読み込んだ鍵の集合が OP の署名に使えないときに使う。
 */
export function signingKeysUnavailable(): Response {
  return Response.json(
    { error: 'server_error', error_description: 'Failed to load signing key' },
    { status: 503 },
  );
}

/**
 * ボディが URL エンコードのフォームなら true を返す。
 *
 * `Content-Type` のメディアタイプが `application/x-www-form-urlencoded` であるかを確かめる。
 * メディアタイプは大文字と小文字を区別せず、`; charset=UTF-8` のようなパラメータが付くこともあるので、小文字にしてパラメータを除いてから比べる（RFC 9110 §8.3.1）。
 */
export function isFormUrlEncoded(request: Request): boolean {
  const [mediaType = ''] = (request.headers.get('Content-Type') ?? '').toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/** Request parameters, and the first name that was repeated (if any). */
export interface UniqueParams {
  params: Record<string, string>;
  duplicateKey?: string;
}

/**
 * パラメータを集め、名前の重複があればその名前も返す。
 *
 * 最初に重複した名前で集めるのをやめ、それまでに集めたパラメータと、その名前（`duplicateKey`）を返す。
 * OAuth のリクエストでは、同じ名前のパラメータを繰り返してはならない（RFC 6749 §3.1、§3.2）。
 */
export function uniqueParams(searchParams: URLSearchParams): UniqueParams {
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      return { params, duplicateKey: key };
    }
    seen.add(key);
    params[key] = value;
  }
  return { params };
}

/**
 * フォームの POST のフィールドを読み取って返す。
 *
 * URL エンコードと `multipart/form-data` のボディを読む。
 * どちらでもないボディには空の `FormData` を返すので、どのフィールドもないものとして扱われる。
 */
export async function readFormFields(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

/**
 * エラーをクエリに入れたエラー画面のパスを返す。
 *
 * 返すのは OP のエラー画面（`app/oidc-error`）の `/oidc-error?error=…` の形のパスで、`errorDescription` があれば `error_description` も入れる。
 * クライアントへ返さずに OP にとどめるエラーに使い、ページとサーバーアクションは `redirect()` でブラウザをこのパスへ移す。
 */
export function errorPagePath(error: string, errorDescription?: string): string {
  const query = new URLSearchParams({ error });
  if (errorDescription) query.set('error_description', errorDescription);
  return '/oidc-error?' + query.toString();
}

/**
 * OP のエラー画面へ 303 でリダイレクトする。
 *
 * ルートハンドラから使う。
 * 303 なので、POST のあとでもブラウザはエラー画面を GET で取得する。
 * URL は設定の `issuer` の上に組み立て、リクエストの URL は使わない（OIDC Discovery 1.0 §3）。
 */
export function redirectToErrorPage(error: string, errorDescription?: string): Response {
  return NextResponse.redirect(new URL(errorPagePath(error, errorDescription), config.issuer), 303);
}
