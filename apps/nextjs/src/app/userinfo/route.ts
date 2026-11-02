/**
 * UserInfo Endpoint (OIDC Core 1.0 §5.3).
 *
 * The response format follows the client metadata userinfo_signed_response_alg:
 * a signed JWT (application/jwt, §5.3.2) when the client registered one,
 * JSON otherwise. Every answer — success and error — exposes or concerns PII,
 * so none may be cached (RFC 6750 §5.2 / OIDC Core 1.0 §16.4).
 */
import {
  resolveUserInfoAccessToken,
  validateUserInfoTokenExpiration,
  validateUserInfoScope,
  validateUserInfoAudience,
  resolveUserInfoClaims,
  filterClaimsByScope,
  applyRequestedClaims,
  generateUserInfoJwt,
  selectSigningKeyByAlg,
  UserInfoError,
  type SigningKey,
  type UserInfoResponse,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../_oidc-provider/config';
import {
  clientResolver,
  config,
  loadSigningKeys,
  resolvers,
  type ProviderSigningKeys,
} from '../_oidc-provider/provider';
import {
  clientCors,
  corsPreflight,
  noStoreJson,
  signingKeysUnavailable,
  withCors,
} from '../_oidc-provider/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * UserInfo の GET リクエストに応答する。
 *
 * 応答は、`userinfo()` のレスポンス（エンドユーザーのクレームか `Bearer` のエラー）に、`clientCors` のヘッダーを付けたものである。
 */
export async function GET(request: Request): Promise<Response> {
  return withCors(request, clientCors, await userinfo(request));
}

/**
 * UserInfo の POST リクエストに応答する。
 *
 * アクセストークンは、`Authorization` ヘッダーか、フォームの `access_token` フィールドで受け取る。
 * 応答は、`userinfo()` のレスポンスに `clientCors` のヘッダーを付けたものである。
 */
export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await userinfo(request));
}

/**
 * CORS のプリフライトに、ボディなしの 204 で応答する。
 *
 * 対象は `/userinfo` で、応答には `clientCors` のヘッダー（許可するオリジン、メソッド、ヘッダー、キャッシュしてよい秒数）を付ける。
 */
export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

/**
 * トークンを検証し、エンドユーザーのクレームで応答する。
 *
 * 返すクレームは、アクセストークンのスコープと `claims` パラメータが許すものである。
 * 応答はキャッシュさせない JSON で、クライアントが `userinfo_signed_response_alg` を登録していれば、署名した JWT（`application/jwt`）で応答する。
 *
 * トークンのエラーには、キャッシュさせない JSON と、`Bearer` の `WWW-Authenticate` チャレンジで応答する。
 * - 401 の `invalid_token`: トークンがない、または登録されていない、期限切れ、このエンドポイント向けでない（`aud`）、サブジェクトのユーザーが見つからないとき。
 * - 403 の `insufficient_scope`: トークンが `openid` スコープを含まないとき。
 * - 400 の `invalid_request`: トークンを複数の方法で送ったとき。
 *
 * リクエストのボディを読めないときは、チャレンジを付けずに 400 の `invalid_request` で応答する。
 * 署名鍵を読み込めないときは 503 で、それ以外の失敗（登録されたアルゴリズムの UserInfo の鍵がないときを含む）では 500 の `server_error` で応答する。
 *
 * @spec OIDC Core 1.0 §5.3
 */
async function userinfo(request: Request): Promise<Response> {
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  let accessToken: string;
  try {
    const { token, methodCount } = await extractAccessToken(request);
    if (methodCount > 1) {
      // クライアントは、1 つのリクエストで複数の方法を使ってはならない（MUST NOT、RFC 6750 §2）。
      return noStoreJson(
        {
          error: 'invalid_request',
          error_description: 'Multiple access token methods are not allowed',
        },
        {
          status: 400,
          headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo", error="invalid_request"' },
        },
      );
    }
    if (!token) {
      // 認証情報のないリクエストへのチャレンジには `error` と `error_description` を付けず、`realm` だけを示す（RFC 6750 §3.1）。
      return noStoreJson(
        { error: 'invalid_token', error_description: 'Access token is required' },
        { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo"' } },
      );
    }
    accessToken = token;
  } catch {
    return noStoreJson({ error: 'invalid_request' }, { status: 400 });
  }

  try {
    // ここからの各ステップは、UserInfo リクエストのパイプラインを構成する core の独立した関数である。
    // 呼び出しを消せばその検証を外せ、ステップのあいだに独自の処理を入れることもできる。
    // どのステップも失敗すると `UserInfoError` を投げ、下の `catch` ブロックが RFC 6750 の `Bearer` のチャレンジで応答する。

    // 提示されたアクセストークンの情報を取得し、登録されていなければ `invalid_token` のエラーを投げる（OIDC Core 1.0 §5.3.1）。
    const tokenInfo = await resolveUserInfoAccessToken(accessToken, resolvers.accessTokenResolver);

    // 期限切れのアクセストークンは `invalid_token` にする（RFC 6750 §3.1）。
    validateUserInfoTokenExpiration(tokenInfo);

    // トークンが `openid` スコープを含むことを確かめ、含まなければ `insufficient_scope` にする（OIDC Core 1.0 §5.3.1）。
    validateUserInfoScope(tokenInfo);

    // アクセストークンの `aud` に、この UserInfo エンドポイントが含まれることを確かめる（RFC 9068 §4）。
    // トークンエンドポイントは常に `aud` に UserInfo エンドポイントの URL を入れる（`buildAccessTokenAudience`）ので、JWT のトークンでも中身を読めない不透明なトークンでも、この確認を行う。
    // 確認をやめるときは、第 2 引数に `undefined` を渡す。
    validateUserInfoAudience(tokenInfo, `${config.issuer}/userinfo`);

    // トークンのサブジェクトについて、OP が持つすべてのクレームを読み込む。
    const userClaims = await resolveUserInfoClaims(tokenInfo, resolvers.userClaimsResolver);

    // 許可したスコープが認めるクレームだけを残す（OIDC Core 1.0 §5.4）。
    const scopedResponse = filterClaimsByScope(userClaims, tokenInfo.scope);

    // トークンエンドポイントがこのアクセストークンと一緒に保存した、個別に要求されたクレーム（`claims.userinfo` の項目）を重ねる（OIDC Core 1.0 §5.5）。
    const response = applyRequestedClaims(scopedResponse, userClaims, tokenInfo.claims);

    const client = (await clientResolver.findClient(tokenInfo.clientId)) as RegisteredClient | null;
    if (client?.userinfoSignedResponseAlg) {
      return await signedUserInfo(response, client, keys);
    }
    return noStoreJson(response);
  } catch (error) {
    if (error instanceof UserInfoError) {
      return noStoreJson(
        { error: error.error, error_description: error.errorDescription },
        {
          status: error.statusCode,
          headers: {
            'WWW-Authenticate': `Bearer realm="UserInfo", error="${error.error}", error_description="${error.errorDescription}"`,
          },
        },
      );
    }
    return noStoreJson({ error: 'server_error' }, { status: 500 });
  }
}

/**
 * UserInfo のクレームを、署名した JWT で応答する。
 *
 * 署名には、クライアントが登録したアルゴリズム（RS256、ES256 など）の、登録した UserInfo の鍵を使う。
 * JWT の `iss` は設定の `issuer`、`aud` はクライアント ID で、レスポンスはキャッシュさせない。
 * そのアルゴリズムの鍵がないのはサーバーの設定の誤りなので、別のアルゴリズムで署名せずに 500 の `server_error` で応答する。
 *
 * @spec OIDC Core 1.0 §5.3.2
 */
async function signedUserInfo(
  claims: UserInfoResponse,
  client: RegisteredClient,
  keys: ProviderSigningKeys,
): Promise<Response> {
  let signingKey: SigningKey;
  try {
    signingKey = selectSigningKeyByAlg(keys.userinfo, client.userinfoSignedResponseAlg);
  } catch {
    return noStoreJson(
      {
        error: 'server_error',
        error_description: `No UserInfo signing key registered for alg "${client.userinfoSignedResponseAlg}"`,
      },
      { status: 500 },
    );
  }
  const jwt = await generateUserInfoJwt(claims, {
    issuer: config.issuer,
    audience: client.clientId,
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
  });
  return new Response(jwt, {
    headers: { 'Content-Type': 'application/jwt', 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

/**
 * リクエストのアクセストークンと、送られた方法の数を返す。
 *
 * 次の二つの方法に対応する。
 * - `Authorization: Bearer` ヘッダー（RFC 6750 §2.1、REQUIRED）
 * - POST のフォームのボディの `access_token` パラメータ（RFC 6750 §2.2、OPTIONAL）
 *
 * URL のクエリパラメータ（RFC 6750 §2.3）は OAuth 2.1 が禁止しているので、意図して対応していない。
 * 呼び出し側は `methodCount` を見て、複数の方法を使ったリクエストを拒否できる。
 */
async function extractAccessToken(request: Request): Promise<{ token: string; methodCount: number }> {
  const authHeader = request.headers.get('Authorization') ?? '';
  // HTTP の認証スキームは大文字と小文字を区別しないので、`Bearer` のスキームは大文字と小文字を区別せずに照合する（RFC 7235 §2.1）。
  // トークンの値は変えずにそのまま使う。
  const spaceIndex = authHeader.indexOf(' ');
  const headerToken =
    spaceIndex !== -1 && authHeader.slice(0, spaceIndex).toLowerCase() === 'bearer'
      ? authHeader.slice(spaceIndex + 1)
      : '';

  let bodyToken = '';
  if (request.method === 'POST') {
    const mediaType =
      (request.headers.get('Content-Type') ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
    if (mediaType === 'application/x-www-form-urlencoded') {
      bodyToken = new URLSearchParams(await request.text()).get('access_token') ?? '';
    }
  }

  const methodCount = (headerToken ? 1 : 0) + (bodyToken ? 1 : 0);
  return { token: headerToken || bodyToken, methodCount };
}
