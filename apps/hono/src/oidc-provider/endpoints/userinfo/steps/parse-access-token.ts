import { UserInfoEndpointError } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'parse-access-token',
  endpoint: 'userinfo',
  kind: 'parse',
  label: 'Bearer トークンを読み取る',
  spec: 'RFC 6750 §2.1 / §2.2',
  function: 'parseUserInfoRequest',
  consumes: [],
  produces: ['accessToken'],
  removable: false,
});

/**
 * リクエストからアクセストークンを読み取って返す。
 *
 * 次の二つの方法に対応する。
 * - `Authorization: Bearer` ヘッダー（RFC 6750 §2.1、REQUIRED）
 * - POST のフォームのボディの `access_token` パラメータ（RFC 6750 §2.2、OPTIONAL）
 *
 * クライアントは、1 つのリクエストで複数の方法を使ってはならない（MUST NOT、RFC 6750 §2）。
 * URL のクエリパラメータ（RFC 6750 §2.3）は OAuth 2.1 が禁止しているので、意図して対応していない。
 *
 * @throws {UserInfoEndpointError} トークンがないとき（401 の `invalid_token` で、チャレンジは `realm` だけを示す、RFC 6750 §3.1）。
 * @throws {UserInfoEndpointError} 二つの方法を同時に使ったとき（400 の `invalid_request`）。
 * @throws {UserInfoEndpointError} ヘッダーやボディを読めないとき（400 の `invalid_request`）。
 */
export async function parseUserInfoRequest(c: any): Promise<string> {
  let headerToken = '';
  let bodyToken = '';
  try {
    const authHeader = c.req.header('Authorization') ?? '';
    // HTTP の認証スキームは大文字と小文字を区別しないので、`Bearer` のスキームは大文字と小文字を区別せずに照合する（RFC 7235 §2.1）。
    // トークンの値は変えずにそのまま使う。
    const bearerSpaceIndex = authHeader.indexOf(' ');
    headerToken =
      bearerSpaceIndex !== -1 &&
      authHeader.slice(0, bearerSpaceIndex).toLowerCase() === 'bearer'
        ? authHeader.slice(bearerSpaceIndex + 1)
        : '';

    if (c.req.method === 'POST') {
      const contentType = c.req.header('Content-Type') ?? '';
      const mediaType = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
      if (mediaType === 'application/x-www-form-urlencoded') {
        // メディアタイプを正規化したうえで、フォームのボディをここで解析する。
        // Hono の `parseBody()` は、`Content-Type` の書き方によっては大文字と小文字を区別して振り分けるためである。
        const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
        const candidate = body['access_token'];
        if (typeof candidate === 'string') {
          bodyToken = candidate;
        }
      }
    }
  } catch {
    throw new UserInfoEndpointError({ status: 400, body: { error: 'invalid_request' } });
  }

  const methodCount = (headerToken ? 1 : 0) + (bodyToken ? 1 : 0);
  if (methodCount > 1) {
    // クライアントは、1 つのリクエストで複数の方法を使ってはならない（MUST NOT、RFC 6750 §2）。
    throw new UserInfoEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
      headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo", error="invalid_request"' },
    });
  }
  const accessToken = headerToken || bodyToken;
  if (!accessToken) {
    // 認証情報のないリクエストへのチャレンジには `error` と `error_description` を付けず、`realm` だけを示す（RFC 6750 §3.1）。
    throw new UserInfoEndpointError({
      status: 401,
      body: { error: 'invalid_token', error_description: 'Access token is required' },
      headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo"' },
    });
  }
  return accessToken;
}
