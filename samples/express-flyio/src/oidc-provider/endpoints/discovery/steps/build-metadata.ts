import { buildProviderMetadata } from '@maronn-openid-connect/core';
import type { ProviderConfig } from '../../../config.js';
import { features } from '../../../features/enabled.js';
import { discoveryOf, tokenGrantsOf } from '../../../features/feature.js';
import { ADVERTISED_SCOPES } from '../../../scopes.js';
import { supportedResponseTypes } from '../../authorize/response-type.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'build-metadata',
  endpoint: 'discovery',
  kind: 'transform',
  label: 'OP のメタデータを組み立てる',
  spec: 'OIDC Discovery 1.0 §3 / RFC 8414',
  function: 'buildDiscoveryMetadata',
  consumes: ['idTokenSigningKeys', 'userinfoSigningAlgValues'],
  produces: ['metadata'],
  removable: false,
});

/**
 * OP のメタデータを組み立てて返す。
 *
 * エンドポイントの URL は、すべて設定の `issuer` をもとに作る。
 * ここで書く項目はどの OP にもあるもので、機能はそれぞれ、自分の項目（エンドポイント、扱うグラントタイプ、署名するレスポンスモード）を、その機能の feature.ts の `discovery` で加える。
 * 配列の項目は値を重複させずにつなぎ、それ以外の項目は機能の値で置き換える（`discoveryOf()`）。
 *
 * @throws {Error} `buildProviderMetadata()` が設定の誤り（`issuer` が正しい URL でない、ID トークンの署名鍵がないか RS256 の鍵を含まないなど）を見つけたとき。
 * @spec OIDC Discovery 1.0 §3
 * @spec RFC 8414
 */
export function buildDiscoveryMetadata(
  c: any,
  input: { idTokenSigningKeys: CryptoKey[]; userinfoSigningAlgValues: string[] },
): Record<string, unknown> {
  const { idTokenSigningKeys, userinfoSigningAlgValues } = input;
  const config: ProviderConfig = c.get('config');
  const issuer = config.issuer;

  const metadata = buildProviderMetadata({
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    // `code` と、機能が扱うレスポンスタイプ（その機能の feature.ts の `authorize.responseTypes`）を並べる。
    // インプリシットフローは `id_token` と `id_token token` を、ハイブリッドフローは `code id_token`、`code token`、`code id_token token` を加える。
    responseTypesSupported: supportedResponseTypes(),
    // 認可コードフローは、認可レスポンスをクエリで返す（OAuth 2.0 Multiple Response Type Encoding Practices §2.1、OIDC Discovery 1.0 §3）。
    // ほかのレスポンスモード（インプリシットフローとハイブリッドフローのフラグメント、`form_post`、JARM）で応答する機能は、そのモードをこの一覧に加える。
    responseModesSupported: ['query'],
    subjectTypesSupported: ['public'],
    idTokenSigningKeys,
    userinfoEndpoint: `${issuer}/userinfo`,
    // OIDC Core 1.0 のスコープと、宣言した独自のスコープを並べる（scopes.ts の `ADVERTISED_SCOPES`）。
    // `offline_access` は、それを許可する `refresh-token` の機能が加える。
    scopesSupported: [...ADVERTISED_SCOPES],
    // この OP は通常のクレーム（`normal`）だけを返し、`_claim_names` や `_claim_sources` は使わない（OIDC Core 1.0 §5.6）。
    // 集約クレームと分散クレームに対応しないことを機械で読めるように、`['normal']` を明示する（OIDC Discovery 1.0 §3）。
    claimTypesSupported: ['normal'],
    claimsSupported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      // 以下は、OP が発行する ID トークンのプロトコルのクレームである（endpoints/token/ の `issue-id-token` のステップ、OIDC Core 1.0 §2、§3.1.3.6）。
      // `auth_time`、`nonce`、`acr`、`amr` は認証の状況から付け、`azp` はオーディエンスが複数のトークンに、`at_hash` は ID トークンと一緒に発行するアクセストークンに対して付ける（OIDC Core 1.0 §3.1.3.6、§3.2.2.10）。
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
    // `private_key_jwt` は、クライアントの秘密鍵で署名したクライアントアサーションによる認証である（OIDC Core 1.0 §9、client-auth.ts）。
    tokenEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
      'private_key_jwt',
      'none',
    ],
    // `private_key_jwt` を公開するときに必要な項目である（OIDC Discovery 1.0 §3、RFC 8414 §2）。
    // `none` は含めない。
    tokenEndpointAuthSigningAlgValuesSupported: [...config.tokenEndpointAuthSigningAlgValuesSupported],
    // `userinfo_signed_response_alg` を使うクライアントがあるときに必要な項目である（OIDC Core 1.0 §5.3.2）。
    // 登録した UserInfo の鍵の集合から求めるので、ES256 などの鍵を設定すれば、そのアルゴリズムも公開される。
    userinfoSigningAlgValuesSupported: userinfoSigningAlgValues,
    // `request` パラメータ（リクエストオブジェクト）には `request-object` の機能だけが対応し、その機能が対応を公開する（OIDC Core 1.0 §6.3）。
    // `request_uri`（OIDC Core 1.0 §6.2）には対応しないので、明示的に `false` を公開する。
    // 省略すると、ディスカバリーの仕様では `request_uri_parameter_supported` の既定値が `true` になるためである。
    requestParameterSupported: false,
    requestUriParameterSupported: false,
    // `claims` リクエストパラメータには ID トークンと UserInfo の両方で対応しているので、対応を公開する（OIDC Core 1.0 §5.5、OIDC Discovery 1.0 §3）。
    // この項目の既定値は `false` なので、公開しないと、仕様に従う RP は `claims` パラメータを送らない。
    claimsParameterSupported: true,
    // すべての認可レスポンスに `iss` を含める（RFC 9207 §3）。
    authorizationResponseIssParameterSupported: true,
  });

  // `code_challenge_methods_supported` は OIDC Discovery 1.0 の項目ではなく、PKCE（RFC 7636）と OAuth 2.1 の項目なので、ここで加える。
  // そのうえで、有効な機能の項目を加えて返す。
  return discoveryOf(
    features,
    { ...metadata, code_challenge_methods_supported: ['S256'] },
    issuer,
    config,
  );
}
