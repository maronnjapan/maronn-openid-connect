/**
 * Token Endpoint (OIDC Core 1.0 §3.1.3).
 *
 * Authenticates the client, validates the grant it presents and answers with
 * the token response: authorization_code here, and refresh_token in the
 * (feature: refresh-token) blocks.
 *
 * The grants of the other features (token exchange, ID-JAG, device_code, CIBA)
 * are answered in their own blocks right after client authentication and
 * before validateGrantTypeSupported, each by the grant.ts of its feature.
 */
import {
  validateGrantTypeSupported,
  resolveAuthenticatedTokenClient,
  validateClientGrantType,
  resolveAuthorizationCode,
  validateAuthorizationCodeUnused,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  verifyAuthorizationCodePkce,
  consumeAuthorizationCode,
  buildValidatedAuthorizationCodeRequest,
  buildAccessTokenPayload,
  computeAtHash,
  resolveAcrAmr,
  buildIdTokenPayload,
  generateIdToken,
  buildAccessTokenAudience,
  extractClientCredentials,
  validateClientAuthMethod,
  verifyClientSecret,
  TokenError,
  TokenErrorCode,
  type AuthorizationCodeData,
  type TokenRequestParams,
  type ValidatedTokenRequest,
} from '@maronn-openid-connect/core';
import { dispatchCiba } from '../_oidc-provider/features/ciba/grant';
import { dispatchDeviceCode } from '../_oidc-provider/features/device-authorization-grant/grant';
import { dispatchIdJagIssuance, dispatchIdJagRedemption } from '../_oidc-provider/features/id-jag/grant';
import {
  decideRefreshTokenIssuance,
  issueRefreshToken,
  revokeRotatedRefreshToken,
  validateRefreshTokenGrant,
} from '../_oidc-provider/features/refresh-token/token';
import { dispatchTokenExchange } from '../_oidc-provider/features/token-exchange/grant';
import { tokenGrantsOf } from '../_oidc-provider/feature';
import { features } from '../_oidc-provider/features';
import type { RegisteredClient } from '../_oidc-provider/config';
import {
  accessTokenIssuer,
  acrResolver,
  clientResolver,
  config,
  loadSigningKeys,
  resolvers,
  selectIdTokenSigningKey,
  stores,
} from '../_oidc-provider/provider';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  noStoreJson,
  oauthError,
  signingKeysUnavailable,
  uniqueParams,
  withCors,
} from '../_oidc-provider/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const { authorizationCodeResolver } = resolvers;
const { authCodeStore, accessTokenStore } = stores;

/**
 * `token()` の結果に CORS ヘッダーを付けて返す。
 *
 * `POST /token` のトークンリクエストに、トークンレスポンスか OAuth のエラーレスポンスで応答する。
 * CORS ヘッダーは `clientCors` の設定に従う。
 */
export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await token(request));
}

/**
 * CORS のプリフライトに、ボディなしの 204 で応答する。
 *
 * 対象は `/token` で、応答には `clientCors` のヘッダー（許可するオリジン、メソッド、ヘッダー、キャッシュしてよい秒数）を付ける。
 */
export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

/**
 * クライアントを認証し、トークンを発行して応答する。
 *
 * 提示されたグラントを検証し、キャッシュさせないトークンレスポンスで応答する。
 * レスポンスには、アクセストークンと、`openid` スコープが許可されたときの ID トークンと、発行したときのリフレッシュトークンを含める。
 * アクセストークンは UserInfo、イントロスペクション、失効の各エンドポイントのために保存し、認可コードは使用済みにする（再び提示されたら拒否し、そのグラントのトークンを失効させる）。
 * 有効にした機能のグラント（ID-JAG、トークン交換、`device_code`、CIBA）には、クライアントの認証の直後にあるそれぞれのブロックが応答する。
 *
 * エラーには、キャッシュさせない OAuth のエラーレスポンス（JSON）で応答する。
 * - 400: リクエストが不正なとき、またはグラントを拒否したとき。
 * - 401 `invalid_client`（`WWW-Authenticate` ヘッダー付き）: クライアントの認証に失敗したとき。
 * - 500 `server_error`: クライアントの `alg` に合う ID トークンの署名鍵がないとき、またはそのほかの失敗のとき。
 *
 * 署名鍵を読み込めないときは、503 で応答する。
 *
 * @spec OIDC Core 1.0 §3.1.3
 */
async function token(request: Request): Promise<Response> {
  // [load-signing-keys] Load the signing keys — OIDC Core 1.0 §10.1
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  // [parse-request] Parse the token request — RFC 6749 §4.1.3 / §3.2
  // ボディが `application/x-www-form-urlencoded` でなければ（`multipart/form-data` や `application/json` など）、解析する前に `invalid_request` で拒否する（RFC 6749 §4.1.3、OIDC Core 1.0 §3.1.3.1）。
  // 解析する前に拒否するので、フォームでないボディがトークンのパラメータとして使われることはない。
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Token requests must use application/x-www-form-urlencoded');
  }

  // 同じパラメータが繰り返されていたら、`invalid_request` で拒否する（RFC 6749 §3.2）。
  const { params: rawParams, duplicateKey } = uniqueParams(new URLSearchParams(await request.text()));
  if (duplicateKey !== undefined) {
    return oauthError('invalid_request', `Parameter "${duplicateKey}" must not be repeated`);
  }
  if (!isTokenRequestParams(rawParams)) {
    return oauthError('invalid_request', 'Missing required parameter: grant_type');
  }
  const params = rawParams;

  try {
    // [authenticate-client] Authenticate the client — OAuth 2.1 §2.3 / OIDC Core 1.0 §9
    // クライアントを認証する（OAuth 2.1 §2.3、OIDC Core 1.0 §9）。
    // 対応する認証方式は `client_secret_basic` と `client_secret_post` で、`none` で登録したパブリッククライアントは `client_id` だけで識別する。
    // 以下の処理はそれぞれ core の独立した関数なので、`verifyClientSecret()` を独自の検証（`private_key_jwt` など）に差し替えても、ほかの処理は変えずに済む。

    // 提示された認証情報と、実際に使われた認証方式を読み取る。
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: request.headers.get('Authorization') ?? '',
    });

    // 提示された `client_id` の登録済みクライアントを取得する（RFC 6749 §5.2）。
    const tokenClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      clientResolver,
    );

    // 使われた認証方式が、クライアントの登録した方式のどれかであることを確かめる（OIDC Core 1.0 §9）。
    // 認証方式のダウングレードや、パブリッククライアントとの取り違えを防ぐ。
    validateClientAuthMethod(tokenClient, presentedCredentials);

    // `client_secret` を定数時間で比較する（OAuth 2.1 §7.4.1）。
    await verifyClientSecret(tokenClient, presentedCredentials.clientSecret);

    const authenticatedClientId = presentedCredentials.clientId;

    // [dispatch-id-jag-issuance] (feature: id-jag) Issue an ID-JAG (Cross-App Access) — ID-JAG draft §4.3
    const idJagIssuance = await dispatchIdJagIssuance(params, tokenClient, keys);
    if (idJagIssuance) return idJagIssuance;

    // [dispatch-id-jag-redemption] (feature: id-jag) Redeem an ID-JAG on the jwt-bearer grant — ID-JAG draft §4.4 / RFC 7523 §2.1
    const idJagRedemption = await dispatchIdJagRedemption(params, tokenClient, keys);
    if (idJagRedemption) return idJagRedemption;

    // [dispatch-token-exchange] (feature: token-exchange) Token Exchange — RFC 8693 §2.1
    const exchanged = await dispatchTokenExchange(params, tokenClient, keys);
    if (exchanged) return exchanged;

    // [dispatch-device-code] (feature: device-authorization-grant) Redeem a device_code — RFC 8628 §3.4 / §3.5
    const deviceGrantResponse = await dispatchDeviceCode(params, tokenClient, keys);
    if (deviceGrantResponse) return deviceGrantResponse;

    // [dispatch-ciba] (feature: ciba) Redeem an auth_req_id (CIBA) — CIBA Core 1.0 §10.1 / §11
    const cibaGrantResponse = await dispatchCiba(params, tokenClient, keys);
    if (cibaGrantResponse) return cibaGrantResponse;

    // [validate-grant-type] Validate grant_type — RFC 6749 §5.2
    // `grant_type` がこの OP の扱う値かどうかを確かめ、扱わない値なら `unsupported_grant_type` にする（RFC 6749 §5.2）。
    // `authorization_code` は常に扱い、`refresh_token` は `refresh-token` 機能がトークンエンドポイントに加えたとき（その機能の `feature.ts` の `token.grants`）だけ扱う。
    // 機能が自分で応答するグラントは、このブロックより前で処理を終えている。
    const grantType = validateGrantTypeSupported(params.grant_type, [
      'authorization_code',
      ...tokenGrantsOf(features),
    ]);
    // クライアントにこの `grant_type` が許可されているかを確かめ、許可されていなければ `unauthorized_client` にする（RFC 6749 §5.2）。
    validateClientGrantType(tokenClient, grantType);

    // [validate-refresh-token-grant] (feature: refresh-token) Validate the refresh_token grant — OAuth 2.1 §4.3.1 / RFC 6749 §6
    const refreshTokenRequest = await validateRefreshTokenGrant(params, authenticatedClientId, grantType);

    // [validate-authorization-code-grant] Validate the authorization_code grant — OAuth 2.1 §4.1.2 / RFC 7636 / OIDC Core 1.0 §3.1.3.2
    const validatedRequest =
      refreshTokenRequest ?? (await validateAuthorizationCodeGrant(params, authenticatedClientId));

    // [select-signing-keys] Select the signing keys — OIDC Dynamic Client Registration 1.0 §2 (id_token_signed_response_alg)
    // ID トークンの署名鍵として、`alg` がクライアントの `id_token_signed_response_alg` と一致する、登録された ID トークン用の鍵を選ぶ（登録がなければ RS256。OpenID Connect Dynamic Client Registration 1.0 §2）。
    // その `alg` の鍵がなければ、サーバーの設定の誤りとして 500 の `server_error` で応答する。
    const idTokenAlg = (tokenClient as RegisteredClient).idTokenSignedResponseAlg;
    const idTokenKey = selectIdTokenSigningKey(keys, idTokenAlg);
    if (!idTokenKey) {
      return oauthError(
        'server_error',
        `No ID Token signing key registered for alg "${idTokenAlg ?? 'RS256'}"`,
        500,
      );
    }

    // [resolve-subject] Resolve the subject, auth_time and nonce — OIDC Core 1.0 §12.2
    let subject: string;
    let authTime: number | undefined;
    let nonce: string | undefined;

    if (validatedRequest.grantType === 'authorization_code') {
      // 同意のステップが保存した認可コードのレコード（`createAuthorizationCode()` が作ったもの）をストアから読み、認証したサブジェクトと `auth_time` を取り出す。
      // レコードにサブジェクトか `auth_time` がなければ、`invalid_grant` で拒否する。
      const authCode = (await authCodeStore.get(validatedRequest.code)) as
        | AuthorizationCodeData
        | undefined;
      if (!authCode?.subject || !authCode.authTime) {
        throw new TokenError(
          TokenErrorCode.InvalidGrant,
          'Authorization code missing required subject context',
        );
      }
      subject = authCode.subject;
      authTime = authCode.authTime;
      nonce = validatedRequest.nonce;
    } else {
      // `refresh_token` グラントでは、リフレッシュトークンに保存したサブジェクトと `auth_time` を使い、`nonce` は入れない。
      // OIDC Core 1.0 §12.2 は、発行し直す ID トークンが保つクレームに `iss`、`sub`、`aud`、`exp`、`iat`、`auth_time`、`azp`、`acr`、`amr` を挙げ、`nonce` を挙げていない。
      // `nonce` は認証リクエストとその ID トークンを結び付ける値で（OIDC Core 1.0 §2）、リフレッシュにはその認証リクエストがないので、古い `nonce` を入れてもリプレイを防ぐことにはならない。
      // 主な OP（Google、Auth0）もリフレッシュでは `nonce` を省いており、この OP も省く。
      // `auth_time` は §12.1 に従って引き継ぐ。
      subject = validatedRequest.subject;
      authTime = validatedRequest.authTime;
      nonce = undefined;
    }

    // アクセストークンの `aud` を決める（決め方は core の `buildAccessTokenAudience()` にまとめてある）。
    // JWT 形式のアクセストークンの `aud` は空にできない（RFC 9068 §3）。
    // このアクセストークンは常に OP 自身の UserInfo エンドポイントで使えるので、UserInfo エンドポイントの URL（ディスカバリーのメタデータの `userinfo_endpoint` と同じ）を常に `aud` に含める。
    // `resource` で指定された値（`validatedRequest.audience`）があれば後ろに加え、UserInfo エンドポイントは取り除かない。
    // 重複した値は取り除く。
    // リフレッシュでは保存済みの `aud`（UserInfo エンドポイントを含む）を引き継ぐので、計算し直しても同じ集合になる。
    const effectiveAudience = buildAccessTokenAudience({
      userInfoEndpoint: `${config.issuer}/userinfo`,
      requested: validatedRequest.audience,
      issuer: config.issuer,
    });

    // [decide-refresh-token-issuance] (feature: refresh-token) Decide whether a refresh token is issued — OIDC Core 1.0 §11 / RFC 9700 §4.14
    const refreshTokenDecision = decideRefreshTokenIssuance(tokenClient, validatedRequest);

    // [resolve-acr-amr] Resolve the acr / amr the tokens carry — OIDC Core 1.0 §3.1.2.1 / §12.1 / RFC 9068 §2.2.1
    // トークンに入れる `acr` と `amr` を決める。
    // ID トークンには両方を、アクセストークンには `acr` を入れ、エンドユーザーがどう認証されたかをリソースサーバーが判断できるようにする（RFC 9068 §2.2.1）。
    // - `authorization_code`: `acrResolver`（`provider.ts`）に問い合わせる。
    //   `acr_values` と `claims` の要求も渡し、リゾルバがそれに沿った値を返せるようにする。
    // - `refresh_token`: 保存済みの `acr` と `amr` をそのまま使い、リゾルバは呼ばない。
    //   最初の認証の情報を保つためである（OIDC Core 1.0 §12.1）。
    // 以下の処理はそれぞれ core の独立した関数で、ID トークンに独自のクレームを加えるときは、署名する前に `idTokenPayload` を書き換える。
    const { acr, amr } = await resolveAcrAmr({
      subject,
      clientId: validatedRequest.clientId,
      acr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : undefined,
      amr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : undefined,
      acrResolver: validatedRequest.grantType === 'authorization_code' ? acrResolver : undefined,
      requestedAcrValues:
        validatedRequest.grantType === 'authorization_code' ? validatedRequest.acrValues : undefined,
      // 解析した `claims` パラメータを渡し、`acr_values` がないときは `claims.id_token.acr.values` をリゾルバへの要求値にする（OIDC Core 1.0 §5.5）。
      claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
    });

    // [issue-access-token] Issue the access token — RFC 9068 §2.2 / §2.2.1 / §3
    // 発行時刻をレスポンス全体で一つにし、発行したトークンと保存するトークンの情報で `iat` と `exp` を一致させる。
    const issuedAt = Math.floor(Date.now() / 1000);

    // ペイロードに `iss`、`sub`、`aud`、`exp`、`iat`、`jti`、`scope`、`client_id` を入れ、認証の `acr` があればそれも入れる（RFC 9068 §2.2、§2.2.1）。
    // アクセストークンに独自のクレームを加えるときは、署名する前のここでペイロードに加える。
    const accessTokenPayload = buildAccessTokenPayload({
      issuer: config.issuer,
      subject,
      clientId: validatedRequest.clientId,
      scope: validatedRequest.scope,
      audience: effectiveAudience,
      expiresIn: config.accessTokenExpiresIn,
      issuedAt,
      acr,
    });

    // `provider.ts` が設定の `accessTokenFormat` から選んだ方式で、JWT か不透明な文字列のトークンを発行する。
    const accessToken = await accessTokenIssuer.issue({
      payload: accessTokenPayload,
      privateKey: keys.general[0].privateKey,
      keyId: keys.general[0].keyId,
    });

    // [issue-id-token] Issue the ID Token — OIDC Core 1.0 §3.1.3.6 / §12.1
    // ID トークンは、スコープに `openid` があるときだけ発行する。
    // `refresh_token` グラントでも ID トークンを返してよく（MAY）、返すときは最初の認証と同じ `auth_time`、`acr`、`amr` で発行し直す（OIDC Core 1.0 §12、§12.1）。
    // リフレッシュでは `nonce` が `undefined` になる。
    // OIDC Core 1.0 §12.2 が、発行し直す ID トークンに残すクレームに `nonce` を挙げていないためである。
    let idToken: string | undefined;
    if (validatedRequest.scope.includes('openid')) {
      // このアクセストークンのハッシュの左半分から `at_hash` を求め、ID トークンをアクセストークンに結び付ける（OIDC Core 1.0 §3.1.3.6）。
      // ハッシュ関数は、ID トークンの署名鍵の `alg` に合わせる。
      const atHash = await computeAtHash(accessToken, idTokenKey.privateKey);

      const idTokenPayload = buildIdTokenPayload({
        issuer: config.issuer,
        subject,
        clientId: validatedRequest.clientId,
        scope: validatedRequest.scope,
        expiresIn: config.idTokenExpiresIn,
        issuedAt,
        atHash,
        nonce,
        authTime,
        acr,
        amr,
      });

      // ID トークンに独自のクレームを加えるときは、署名する前のここでペイロードに加える（例: `idTokenPayload.tenant_id = await lookupTenant(subject);`）。

      idToken = await generateIdToken({
        payload: idTokenPayload,
        privateKey: idTokenKey.privateKey,
        keyId: idTokenKey.keyId,
      });
    }

    // [persist-access-token] Store the access token record — RFC 7662 §2.2 / OIDC Core 1.0 §5.5 / RFC 9470 §6.2
    // アクセストークンのレコードを、UserInfo、イントロスペクション、失効の各エンドポイントのためにストアに保存する。
    // `iat`、`nbf`、`audience`、`issuer`、`acr` は、イントロスペクションのレスポンスで返せるように保存する。
    // `grantId` はこのトークンを元の認可のグラントに結び付け、認可コードが再利用されたときに、同じグラントのほかのトークンと一緒に失効させられるようにする（OAuth 2.1 §4.1.2）。
    await accessTokenStore.set(accessToken, {
      sub: subject,
      clientId: validatedRequest.clientId,
      scope: validatedRequest.scope,
      expiresAt: issuedAt + config.accessTokenExpiresIn,
      grantId: validatedRequest.grantId,
      iat: issuedAt,
      // JWT 形式でも不透明な文字列でも `nbf`（`iat` と同じ値）を保存し、まだ有効になっていないトークンをイントロスペクションが無効と報告できるようにし、`nbf` も返せるようにする（RFC 7519 §4.1.5、RFC 7662 §2.2）。
      // JWT の発行処理も、トークンの中に同じ `nbf`（`iat` と同じ値）を入れる。
      nbf: issuedAt,
      audience: effectiveAudience,
      issuer: config.issuer,
      // core が発行ごとに作ったトークンの識別子を保存し、イントロスペクションが `jti` を返せるようにする（RFC 9068 §2.2、RFC 7662 §2.2）。
      // JWT 形式で同じ秒に発行した二つのトークンが別の文字列になるのも、この値があるためである（RS256 の署名は、同じ入力に対して同じ値になる）。
      // そのため、トークンの文字列をキーにするこのストアで、別のグラントのレコードと重ならない。
      jti: accessTokenPayload.jti,
      // 認可リクエストの `claims` パラメータを保存し、UserInfo エンドポイントが `claims.userinfo` で要求されたクレーム（`{"userinfo":{"name":{"essential":true}}}` など）をスコープとは別に返せるようにする（OIDC Core 1.0 §5.5）。
      // 保存するのは `authorization_code` グラントのときだけで、リフレッシュで発行したトークンには保存しない。
      claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
      // トークンを発行したときの `acr` を保存し、不透明な文字列のトークンでもイントロスペクションが `acr` を返せるようにする（RFC 9068 §2.2.1、RFC 9470 §6.2）。
      acr,
    });

    // [issue-refresh-token] (feature: refresh-token) Mint and store the refresh token — OAuth 2.1 §4.3.1 / §6.1
    const refreshToken = await issueRefreshToken({
      decision: refreshTokenDecision,
      subject,
      authTime,
      nonce,
      validatedRequest,
      issuedAt,
      audience: effectiveAudience,
      acr,
      amr,
    });

    // [revoke-rotated-refresh-token] (feature: refresh-token) Revoke the presented refresh token (rotation) — OAuth 2.1 §4.3.1
    await revokeRotatedRefreshToken(params, validatedRequest);

    // [build-token-response] Build the token response body — OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1
    const tokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: config.accessTokenExpiresIn,
      id_token: idToken,
      scope: validatedRequest.scope.join(' '),
      refresh_token: refreshToken,
    };

    // [respond] Respond (no-store) — RFC 6749 §5.1
    return noStoreJson(tokenResponse);
  } catch (error) {
    // [respond-error] Answer the token error — RFC 6749 §5.2 / RFC 6750 §3
    if (error instanceof TokenError) {
      // 401 のレスポンスには `WWW-Authenticate` ヘッダーを付ける（RFC 6750 §3、OAuth 2.1 §5.2）。
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

/**
 * パラメータの `grant_type` が文字列なら true を返す。
 *
 * true のとき、TypeScript はパラメータを `TokenRequestParams` として扱う（型の絞り込み）。
 * オブジェクトでない値と、必須の `grant_type` がない値には false を返す。
 */
function isTokenRequestParams(params: unknown): params is TokenRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  return typeof (params as Record<string, unknown>)['grant_type'] === 'string';
}

/**
 * 認可コードを検証し、検証済みリクエストを返す。
 *
 * 検証に通った認可コードは、ストアで使用済みにする。
 * `code` がない、認可コードが見つからない、使用済み、ほかのクライアントに発行された、期限切れ、`redirect_uri` が認可リクエストと合わない、PKCE の `code_verifier` が合わないときは、中で呼ぶ core の関数が `TokenError`（`invalid_grant` など）を投げる。
 * 使用済みの認可コードが再び提示されたときは、そのグラントから発行したトークンを失効させてから拒否する。
 *
 * 安全のための規則はそれぞれ core の別々の関数なので、一つずつ取り除いたり、差し替えたり、実験用の処理を前後に挟んだりできる。
 *
 * @spec OAuth 2.1 §4.1.2
 * @spec RFC 7636
 * @spec OIDC Core 1.0 §3.1.3.2
 */
async function validateAuthorizationCodeGrant(
  params: TokenRequestParams,
  authenticatedClientId: string,
): Promise<ValidatedTokenRequest> {
  // `code` パラメータがあることを確かめ、提示された認可コードのレコードをストアから取得する。
  const { code, authorizationCode } = await resolveAuthorizationCode(params, authorizationCodeResolver);

  // 使用済みの認可コードなら、そのグラントから発行したトークンを失効させてから拒否する（OAuth 2.1 §4.1.2）。
  await validateAuthorizationCodeUnused(authorizationCode, authorizationCodeResolver);

  // 認可コードが認証したクライアントに発行されたものであることと、有効期限が切れていないことを確かめる。
  validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
  validateAuthorizationCodeExpiration(authorizationCode);

  // トークンリクエストの `redirect_uri` を、認可コードに保存した値と照らし合わせる（OIDC Core 1.0 §3.1.3.2）。
  validateAuthorizationCodeRedirectUri(authorizationCode, params.redirect_uri);

  // 認可コードに PKCE の値が保存されていれば、`code_verifier` を S256 で検証する（RFC 7636）。
  const codeVerified = await verifyAuthorizationCodePkce(authorizationCode, params.code_verifier);

  // 認可コードを削除せずに使用済みにし、後で再び提示されたときに再利用として検出できるようにする。
  await consumeAuthorizationCode(code, authorizationCodeResolver);

  return buildValidatedAuthorizationCodeRequest(code, authorizationCode, authenticatedClientId, codeVerified);
}
