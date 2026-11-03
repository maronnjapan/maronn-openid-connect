/**
 * OpenID Provider Configuration (OIDC Discovery 1.0 §4).
 */
import { buildProviderMetadata, getJwaAlgorithm } from '@maronn-openid-connect/core';
import { config, loadSigningKeys } from '../../_oidc-provider/provider';
import {
  corsPreflight,
  publicCors,
  signingKeysUnavailable,
  withCors,
} from '../../_oidc-provider/http';
import { discoveryOf, responseTypesOf, tokenGrantsOf } from '../../_oidc-provider/feature';
import { features } from '../../_oidc-provider/features';
import { ADVERTISED_SCOPES } from '../../_oidc-provider/scopes';
import { SUPPORTED_SCOPES } from '../../_oidc-provider/scopes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * OP のメタデータに CORS のヘッダーを付けて応答する。
 *
 * GET `/.well-known/openid-configuration` に、`providerMetadata()` のレスポンスで応答する。
 * 付けるのは `publicCors` のヘッダーなので、どのオリジンからも読める。
 */
export async function GET(request: Request): Promise<Response> {
  return withCors(request, publicCors, await providerMetadata());
}

/**
 * CORS のプリフライトに、ボディなしの 204 で応答する。
 *
 * 対象は `/.well-known/openid-configuration` で、応答には、どのオリジンからも GET できるようにする `publicCors` のヘッダーを付ける。
 */
export function OPTIONS(request: Request): Response {
  return corsPreflight(request, publicCors);
}

/**
 * OP のメタデータを組み立て、JSON で応答する。
 *
 * メタデータには、設定の `issuer` をもとにしたエンドポイントの URL、対応するレスポンスタイプ、グラントタイプ、スコープ、クレーム、署名アルゴリズムと、有効な機能が加える項目を含む。
 * レスポンスは 1 時間キャッシュしてよい（`Cache-Control: public, max-age=3600`）。
 *
 * 署名鍵を読み込めないときは、503 の `server_error` で応答する。
 * 公開する ID トークンと UserInfo の署名アルゴリズムは、署名鍵から求めるためである。
 *
 * @throws {Error} `buildProviderMetadata()` が設定の誤り（`issuer` が正しい URL でないなど）を見つけたとき。
 * @spec OIDC Discovery 1.0 §3
 * @spec OIDC Discovery 1.0 §4
 */
async function providerMetadata(): Promise<Response> {
  // [load-signing-keys] 署名鍵を読み込む — OIDC Core 1.0 §10.1
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  // [build-metadata] OP のメタデータを組み立てる — OIDC Discovery 1.0 §3 / RFC 8414
  // エンドポイントの URL は、すべて設定の `issuer` をもとに作る。
  // ここで書く項目はどの OP にもあるもので、機能はそれぞれ、自分の項目（エンドポイント、扱うグラントタイプ、署名するレスポンスモード）を、その機能の feature.ts の `discovery` で加える。
  const issuer = config.issuer;
  const metadata = buildProviderMetadata({
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    // `code` と、機能が扱うレスポンスタイプ（その機能の feature.ts の `authorize.responseTypes`）を並べる。
    // インプリシットフローは `id_token` と `id_token token` を、ハイブリッドフローは `code id_token`、`code token`、`code id_token token` を加える。
    responseTypesSupported: ['code', ...responseTypesOf(features)],
    // 認可コードフローは、認可レスポンスをクエリで返す（OAuth 2.0 Multiple Response Type Encoding Practices §2.1、OIDC Discovery 1.0 §3）。
    // ほかのレスポンスモード（インプリシットフローとハイブリッドフローのフラグメント、`form_post`、JARM）で応答する機能は、そのモードをこの一覧に加える。
    responseModesSupported: ['query'],
    subjectTypesSupported: ['public'],
    // `id_token_signing_alg_values_supported` は、登録したすべての ID トークンの鍵から求めるので、RS256 と ES256 が混在する鍵の集合はそのとおりに公開される（OIDC Core 1.0 §15.1）。
    // RS256 の鍵があることは `buildProviderMetadata()` が確かめる。
    idTokenSigningKeys: keys.idToken.map((key) => key.privateKey),
    userinfoEndpoint: `${issuer}/userinfo`,
    scopesSupported: [...ADVERTISED_SCOPES],
    // この OP は通常のクレーム（`normal`）だけを返し、`_claim_names` や `_claim_sources` は使わない（OIDC Core 1.0 §5.6、OIDC Discovery 1.0 §3）。
    claimTypesSupported: ['normal'],
    claimsSupported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      // 以下は、OP が発行する ID トークンのプロトコルのクレームである（OIDC Core 1.0 §2、§3.1.3.6）。
      // `at_hash` は、ID トークンと一緒に発行するアクセストークンに対して付ける（OIDC Core 1.0 §3.1.3.6、§3.2.2.10）。
      // `c_hash`（OIDC Core 1.0 §3.3.2.11）は、`hybrid-flow` の機能が feature.ts の `discovery` で加える。
      'auth_time',
      'nonce',
      'acr',
      'amr',
      'azp',
      'at_hash',
      'name',
      'family_name',
      'given_name',
      'middle_name',
      'nickname',
      'preferred_username',
      'profile',
      'picture',
      'website',
      'gender',
      'birthdate',
      'zoneinfo',
      'locale',
      'updated_at',
      'email',
      'email_verified',
      'address',
      'phone_number',
      'phone_number_verified',
    ],
    // `authorization_code` と、機能がトークンエンドポイントで扱うグラントタイプ（その機能の feature.ts の `token`）を並べる。
    // 認可エンドポイントで扱うグラントタイプ（インプリシットフローとハイブリッドフローの `implicit`）は、その機能が feature.ts の `discovery` で加える。
    grantTypesSupported: ['authorization_code', ...tokenGrantsOf(features)],
    // `none` は、トークンエンドポイントがパブリッククライアント（`client_secret` を持たないクライアント）を受け付けることを示す（RFC 6749 §2.1、OAuth 2.1 §2.4）。
    tokenEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
      'none',
    ],
    // 登録した UserInfo の鍵で署名できるアルゴリズムを、重複を除いて並べる（OIDC Core 1.0 §5.3.2）。
    // `userinfo_signed_response_alg` を使うクライアントは、メタデータの値をそのまま信頼できる。
    userinfoSigningAlgValuesSupported: [
      ...new Set(keys.userinfo.map((key) => getJwaAlgorithm(key.privateKey))),
    ],
    // リクエストオブジェクトへの対応は、`request-object` の機能が公開する（OIDC Core 1.0 §6.1）。
    // `request_uri`（OIDC Core 1.0 §6.2）には対応しないので、明示的に `false` を公開する。
    // 省略すると、ディスカバリーの仕様では `request_uri_parameter_supported` の既定値が `true` になるためである（OIDC Discovery 1.0 §3）。
    requestParameterSupported: false,
    requestUriParameterSupported: false,
    // `claims` リクエストパラメータには、ID トークンと UserInfo の両方で対応している（OIDC Core 1.0 §5.5、OIDC Discovery 1.0 §3）。
    claimsParameterSupported: true,
    // すべての認可レスポンスに `iss` を含める（RFC 9207 §3）。
    authorizationResponseIssParameterSupported: true,
  });

  // [respond] 応答する（キャッシュ可能） — RFC 8414 §3.2 / RFC 9111 §5.2
  // ディスカバリーのメタデータはキャッシュしてよいので、JWKS エンドポイントと同じ 3600 秒の有効期間を付ける。
  return Response.json(
    discoveryOf(
      features,
      // `code_challenge_methods_supported` は OIDC Discovery 1.0 の項目ではなく、PKCE（RFC 7636）と OAuth 2.1 の項目なので、ここで加える。
      { ...metadata, code_challenge_methods_supported: ['S256'] },
      issuer,
      config,
    ),
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
