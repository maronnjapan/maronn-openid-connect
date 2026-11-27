/**
 * UserInfo Endpoint (OIDC Core 1.0 §5.3).
 *
 * The response format follows the client metadata userinfo_signed_response_alg:
 * a signed JWT (application/jwt, §5.3.2) when the client registered one,
 * JSON otherwise. Every answer — success and error — exposes or concerns PII,
 * so none may be cached (RFC 6750 §5.2 / OIDC Core 1.0 §16.4).
 *
 * Each block of userinfo() is one step of the endpoint (endpoint.ts), as the
 * steps of the Hono pipeline: read the Bearer token, resolve and validate it,
 * resolve the claims it may see, build the response and answer. A block that
 * throws ends in the [respond-error] block, which answers with the challenges
 * of the schemes the endpoint accepts.
 *
 * With the dpop extension, the (feature: dpop) block before the Bearer token
 * adds the DPoP challenge beside the Bearer one, rejects a token sent with
 * both schemes, and reads a token presented with the DPoP scheme and checks
 * its DPoP proof; the one after the token is resolved checks that the key the
 * token is bound to matches how it was presented (RFC 9449 §7.1 / §7.2).
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
import { readDpopUserInfoRequest, verifyDpopUserInfoAccess } from '../_oidc-provider/features/dpop/userinfo';
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
  readBearerToken,
  signingKeysUnavailable,
  withCors,
} from '../_oidc-provider/http';
import {
  BEARER_CHALLENGE,
  UserInfoEndpointError,
  userInfoChallengeHeader,
  type UserInfoChallenges,
  type UserInfoEndpointResponse,
} from './response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * UserInfo の GET リクエストに応答する。
 *
 * 応答は、`userinfo()` のレスポンス（エンドユーザーのクレームか、受け付ける認証スキームのチャレンジ付きのエラー）に、`clientCors` のヘッダーを付けたものである。
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
 * 返すクレームは、アクセストークンのスコープと `claims` パラメータに応じて決まる。
 * 応答はキャッシュさせない JSON で、クライアントが `userinfo_signed_response_alg` を登録していれば、署名した JWT（`application/jwt`）で応答する。
 *
 * トークンのエラーには、キャッシュさせない JSON と、受け付ける認証スキームの `WWW-Authenticate` チャレンジ（機能を有効にしなければ `Bearer`）で応答する。
 * - 401 の `invalid_token`: トークンがない、または登録されていない、期限切れ、このエンドポイント向けでない（`aud`）、サブジェクトのユーザーが見つからないとき。
 * - 403 の `insufficient_scope`: トークンが `openid` スコープを含まないとき。
 * - 400 の `invalid_request`: トークンを複数の方法で送ったとき。
 * 機能のブロックが拒否したリクエスト（dpop なら、DPoP proof を受け付けない 401 の `invalid_dpop_proof` など）にも、同じ形で応答する。
 *
 * リクエストのボディを読めないときは、チャレンジを付けずに 400 の `invalid_request` で応答する。
 * 署名鍵を読み込めないときは 503 で、それ以外の失敗（登録されたアルゴリズムの UserInfo の鍵がないときを含む）では 500 の `server_error` で応答する。
 *
 * @spec OIDC Core 1.0 §5.3
 */
async function userinfo(request: Request): Promise<Response> {
  // 失敗の応答に並べるチャレンジ（`WWW-Authenticate`）。受け付ける認証スキームごとに一つで、機能を有効にしなければ Bearer だけである（RFC 6750 §3）。
  // 自分のスキームを受け付ける機能のブロックは、そのチャレンジを足し、リクエストがそのスキームでトークンを提示したら `scheme` を書き換える（RFC 9449 §7.2）。
  // どのブロックが失敗しても `respond-error` のブロックで読めるよう、最初のブロックの前で宣言する。
  const challenges: UserInfoChallenges = { offered: [BEARER_CHALLENGE], scheme: BEARER_CHALLENGE.scheme };

  // [load-signing-keys] 署名鍵を読み込む — OIDC Core 1.0 §10.1
  // 署名鍵は、`userinfo_signed_response_alg` を登録したクライアントへの署名付きのレスポンスに使う。
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  try {
    // [read-dpop-access-token] (feature: dpop) DPoP のチャレンジを並べ、DPoP スキームのアクセストークンを読んで DPoP proof を検証する — RFC 9449 §7.1 / §7.2 / §4.3
    const { dpopAccessToken, dpopJkt } = await readDpopUserInfoRequest(request, challenges);

    // [parse-access-token] Bearer トークンを読み取る — RFC 6750 §2.1 / §2.2
    // 機能のブロックが別のスキームのトークンを読んだ（`dpopAccessToken`）ときは、そのトークンを使い、ボディを読み直さない（リクエストのボディは一度しか読めない）。
    const accessToken = dpopAccessToken ?? (await parseBearerAccessToken(request));

    // [resolve-access-token] アクセストークンを取得して検証する — OIDC Core 1.0 §5.3.1 / RFC 6750 §3.1 / RFC 9068 §4
    // ここからのブロックは、UserInfo リクエストのパイプラインを構成する core の独立した関数を呼ぶ。
    // 呼び出しを消せばその検証を外せ、ブロックのあいだに独自の処理を入れることもできる。
    // どの検証も失敗すると `UserInfoError` を投げ、下の `respond-error` のブロックが、トークンを提示したスキームのチャレンジにエラーを入れて応答する（RFC 6750 §3）。

    // 提示されたアクセストークンの情報を取得し、登録されていなければ `invalid_token` のエラーを投げる（OIDC Core 1.0 §5.3.1）。
    const tokenInfo = await resolveUserInfoAccessToken(accessToken, resolvers.accessTokenResolver);

    // 期限切れのアクセストークンは `invalid_token` にする（RFC 6750 §3.1）。
    validateUserInfoTokenExpiration(tokenInfo);

    // トークンが `openid` スコープを含むことを確かめ、含まなければ `insufficient_scope` にする（OIDC Core 1.0 §5.3.1）。
    validateUserInfoScope(tokenInfo);

    // アクセストークンの `aud` に、この UserInfo エンドポイントが含まれることを確かめる（RFC 9068 §4）。
    // トークンエンドポイントは常に `aud` に UserInfo エンドポイントの URL を入れる（`buildAccessTokenAudience`）ので、JWT のトークンでも中身を読めない不透明なトークンでも、既定でこの確認を行う。
    // 確認をやめるときは、第 2 引数に `undefined` を渡す。
    validateUserInfoAudience(tokenInfo, `${config.issuer}/userinfo`);

    // [verify-dpop-access-token] (feature: dpop) トークンを束縛した鍵と提示の仕方を照らし合わせる — RFC 9449 §7.1 / §7.2
    verifyDpopUserInfoAccess(tokenInfo, dpopJkt);

    // [resolve-claims] トークンで開示できるクレームを決める — OIDC Core 1.0 §5.4 / §5.5
    // トークンのサブジェクトについて、保存されているすべてのクレームを読み込む。
    const userClaims = await resolveUserInfoClaims(tokenInfo, resolvers.userClaimsResolver);

    // 許可したスコープに対応するクレームだけを残す（OIDC Core 1.0 §5.4）。
    const scopedResponse = filterClaimsByScope(userClaims, tokenInfo.scope);

    // トークンエンドポイントがこのアクセストークンと一緒に保存した、個別に要求されたクレーム（`claims.userinfo` の項目）を重ねる（OIDC Core 1.0 §5.5）。
    const claims = applyRequestedClaims(scopedResponse, userClaims, tokenInfo.claims);

    // [build-response] レスポンスを組み立てる（JSON か署名付き JWT） — OIDC Core 1.0 §5.3.2
    const userInfoResponse = await buildUserInfoResponse(tokenInfo.clientId, claims, keys);

    // [respond] 応答する（no-store） — RFC 6750 §5.2
    return respondUserInfo(userInfoResponse);
  } catch (error) {
    // [respond-error] 受け付ける認証スキームのチャレンジで応答する — RFC 6750 §3 / RFC 9449 §7.2
    return respondUserInfoError(error, challenges);
  }
}

/**
 * `Authorization: Bearer` ヘッダーか、POST のフォームのボディの `access_token` から、アクセストークンを読み取って返す。
 *
 * 次の二つの方法に対応する。
 * - `Authorization: Bearer` ヘッダー（RFC 6750 §2.1、REQUIRED）
 * - POST のフォームのボディの `access_token` パラメータ（RFC 6750 §2.2、OPTIONAL）
 *
 * クライアントは、1 つのリクエストで複数の方法を使ってはならない（MUST NOT、RFC 6750 §2）。
 * URL のクエリパラメータ（RFC 6750 §2.3）は OAuth 2.1 が禁止しているので、意図して対応していない。
 *
 * @spec RFC 6750 §2.1
 * @spec RFC 6750 §2.2
 * @throws {UserInfoEndpointError} トークンがないとき（401 の `invalid_token` で、どのチャレンジもエラーを伝えない、RFC 6750 §3.1）。
 * @throws {UserInfoEndpointError} 二つの方法を同時に使ったとき（400 の `invalid_request` で、`Bearer` のチャレンジがそのエラーを伝える、RFC 9449 §7.2）。
 * @throws {UserInfoEndpointError} リクエストのボディを読めないとき（チャレンジの付かない 400 の `invalid_request`）。
 */
async function parseBearerAccessToken(request: Request): Promise<string> {
  let token: string;
  let methodCount: number;
  try {
    ({ token, methodCount } = await extractAccessToken(request));
  } catch {
    throw new UserInfoEndpointError({ status: 400, body: { error: 'invalid_request' } });
  }
  if (methodCount > 1) {
    // クライアントは、1 つのリクエストで複数の方法を使ってはならない（MUST NOT、RFC 6750 §2）。
    // ヘッダーもフォームのボディも Bearer の方法（RFC 6750 §2.1 / §2.2）で、認証しようとしたスキームは決まるので、`Bearer` のチャレンジだけにエラーを入れる（RFC 9449 §7.2）。
    throw new UserInfoEndpointError(
      {
        status: 400,
        body: { error: 'invalid_request', error_description: 'Multiple access token methods are not allowed' },
      },
      { error: 'invalid_request' },
    );
  }
  if (!token) {
    // 認証情報のないリクエストへのチャレンジには `error` と `error_description` を付けない（RFC 6750 §3.1、RFC 9449 §7.2）。
    throw new UserInfoEndpointError(
      { status: 401, body: { error: 'invalid_token', error_description: 'Access token is required' } },
      'without-error',
    );
  }
  return token;
}

/**
 * UserInfo のレスポンスを、トークンのクライアントが登録した形式で組み立てて返す。
 *
 * クライアントが `userinfo_signed_response_alg` を登録していなければ（クライアントがもう登録されていないときも）、クレームを JSON で返す。
 * 登録していれば、登録した UserInfo の鍵のうち、そのアルゴリズム（RS256、ES256 など）の鍵で署名した JWT（`application/jwt`）を返す。
 * JWT の `iss` は設定の `issuer`、`aud` はクライアント ID である。
 * そのアルゴリズムの鍵がないのはサーバーの設定の誤りなので、別のアルゴリズムで署名せずに 500 の `server_error` にする。
 *
 * @spec OIDC Core 1.0 §5.3.2
 * @throws {UserInfoEndpointError} クライアントが登録したアルゴリズムの UserInfo の鍵がないとき（500 の `server_error`）。
 */
async function buildUserInfoResponse(
  clientId: string,
  claims: UserInfoResponse,
  keys: ProviderSigningKeys,
): Promise<UserInfoEndpointResponse> {
  const client = (await clientResolver.findClient(clientId)) as RegisteredClient | null;
  const alg = client?.userinfoSignedResponseAlg;
  if (!client || !alg) {
    return { status: 200, body: claims };
  }
  let signingKey: SigningKey;
  try {
    signingKey = selectSigningKeyByAlg(keys.userinfo, alg);
  } catch {
    throw new UserInfoEndpointError({
      status: 500,
      body: {
        error: 'server_error',
        error_description: `No UserInfo signing key registered for alg "${alg}"`,
      },
    });
  }
  const jwt = await generateUserInfoJwt(claims, {
    issuer: config.issuer,
    audience: client.clientId,
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
  });
  return { status: 200, text: jwt, headers: { 'Content-Type': 'application/jwt' } };
}

/**
 * UserInfo のレスポンスを、キャッシュさせない HTTP のレスポンスにして返す。
 *
 * どのレスポンスにも `Cache-Control: no-store` と `Pragma: no-cache` を付ける（RFC 6750 §5.2、OIDC Core 1.0 §16.4）。
 * `text` があればそのボディを（署名した JWT。`Content-Type` は `headers` のもの）、なければ `body` を JSON で返す。
 *
 * @spec RFC 6750 §5.2
 * @spec OIDC Core 1.0 §16.4
 */
function respondUserInfo(response: UserInfoEndpointResponse): Response {
  if (response.text !== undefined) {
    return new Response(response.text, {
      status: response.status,
      headers: { ...response.headers, 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }
  return noStoreJson(response.body ?? {}, { status: response.status, headers: response.headers });
}

/**
 * ブロックが投げたエラーを、種類に応じたキャッシュさせない UserInfo のエラーレスポンスにして返す。
 *
 * エラーの種類ごとに、次のように応答する。
 * - `UserInfoEndpointError`: ブロックが決めたレスポンスを返す。ブロックがチャレンジを求めたときは、受け付ける認証スキームのチャレンジ（`WWW-Authenticate` ヘッダー）を付ける。
 * - `UserInfoError`: パイプラインが拒否したトークンに、受け付ける認証スキームのチャレンジとエラーの JSON で応答する（`invalid_token` なら 401、`insufficient_scope` なら 403）。
 *   エラーの情報は、リクエストがトークンを提示したスキーム（`challenges.scheme`）のチャレンジが伝える（RFC 6750 §3、RFC 9449 §7.2）。
 * - それ以外: 500 の `server_error` で応答する。
 *
 * チャレンジは `challenges` のスキームごとに一つで、機能を有効にしなければ `Bearer realm="UserInfo"` だけである。
 *
 * @spec RFC 6750 §3
 * @spec RFC 9449 §7.2
 */
function respondUserInfoError(error: unknown, challenges: UserInfoChallenges): Response {
  if (error instanceof UserInfoEndpointError) {
    if (error.challenge === undefined) {
      return respondUserInfo(error.response);
    }
    return respondUserInfo({
      ...error.response,
      headers: { ...error.response.headers, 'WWW-Authenticate': userInfoChallengeHeader(challenges, error.challenge) },
    });
  }
  if (error instanceof UserInfoError) {
    return respondUserInfo({
      status: error.statusCode,
      body: { error: error.error, error_description: error.errorDescription },
      headers: {
        'WWW-Authenticate': userInfoChallengeHeader(challenges, {
          error: error.error,
          errorDescription: error.errorDescription,
        }),
      },
    });
  }
  return respondUserInfo({ status: 500, body: { error: 'server_error' } });
}

/**
 * アクセストークンと、送られた方法の数を返す。
 *
 * 次の二つの方法に対応する。
 * - `Authorization: Bearer` ヘッダー（RFC 6750 §2.1、REQUIRED）
 * - POST のフォームのボディの `access_token` パラメータ（RFC 6750 §2.2、OPTIONAL）
 *
 * URL のクエリパラメータ（RFC 6750 §2.3）は OAuth 2.1 が禁止しているので、意図して対応していない。
 * 呼び出し側は `methodCount` を見て、複数の方法を使ったリクエストを拒否できる。
 */
async function extractAccessToken(request: Request): Promise<{ token: string; methodCount: number }> {
  const headerToken = readBearerToken(request.headers.get('Authorization') ?? '');

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
