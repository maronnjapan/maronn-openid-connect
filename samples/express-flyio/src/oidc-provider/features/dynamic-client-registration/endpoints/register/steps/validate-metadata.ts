import { getJwaAlgorithm, responseTypeIncludes, type SigningKey } from '@maronn-openid-connect/core';
import {
  buildRegisteredClient,
  validateClientMetadata,
  type DynamicallyRegisteredClient,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import type { ProviderConfig } from '../../../../../config.js';
import { supportedResponseTypes } from '../../../../../endpoints/authorize/response-type.js';
import { step } from '../../../../../endpoints/step.js';
import { CUSTOM_SCOPES, STANDARD_SCOPES } from '../../../../../scopes.js';
import { features } from '../../../../enabled.js';
import { discoveryOf, tokenGrantsOf } from '../../../../feature.js';
import type { DynamicClientRegistrationConfig } from '../../../config.js';

export const meta = step({
  id: 'validate-metadata',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'validate',
  label: 'メタデータを検証してクライアントを組み立てる',
  spec: 'RFC 7591 §2 / §2.1',
  function: 'validateRegistrationMetadata',
  consumes: ['metadata'],
  produces: ['client'],
  removable: false,
});

/**
 * メタデータを検証し、登録するクライアントを作って返す。
 *
 * 作るクライアントには新しく発行した `client_id` を付け、`client_secret` で認証する方式を登録したときは `client_secret` も付ける。
 * 検証と組み立ては、experimental パッケージの副作用のない関数（`validateClientMetadata()` と `buildRegisteredClient()`）が行う。
 * 理解するフィールドだけを選んで値を検証し、RFC 7591 §2 と OIDC Dynamic Client Registration 1.0 §2 の既定値（`application_type` は `web`、`id_token_signed_response_alg` は `RS256`）を適用する。
 * 適用した既定値も登録し、レスポンスで返す（OIDC Dynamic Client Registration 1.0 §3.2）。
 * アプリケーションの種類ごとの `redirect_uris` の制約と、`grant_types` と `response_types` の整合（RFC 7591 §2.1）も確かめる。
 *
 * 受け付ける値は、この OP が応答できるものに限る。
 * - `token_endpoint_auth_method`: 登録の設定の認証方式
 * - `grant_types`: 設定のグラントタイプのうち、この OP が応答するもの（`authorization_code`、生成された機能がトークンエンドポイントで応答するグラントタイプ、機能が `token` か `id_token` を含むレスポンスタイプに応答するときの `implicit`）
 * - `response_types`: `code` と生成された機能のレスポンスタイプ（ディスカバリーが公開するものと同じ）
 * - `scope`: scopes.ts に独自のスコープを宣言するまではどの値でもよく、宣言したあとは標準のスコープと宣言したスコープ
 * - `id_token_signed_response_alg` と `userinfo_signed_response_alg`: 登録した署名鍵のアルゴリズム（ディスカバリーが公開するものと同じ）
 * - `jwks_uri`: 登録の設定の `acceptJwksUri` が有効なあいだ、宛先をプロバイダーの設定の `allowInsecureClientJwksUri` に照らして検査し、登録する（RFC 7591 §2）。ここでは取得しない
 * - `request_object_signing_alg`: ディスカバリーが `request_object_signing_alg_values_supported` に公開する alg（OIDC Dynamic Client Registration 1.0 §2）。request-object の機能がない OP では、理解しないメタデータとして無視する
 * - `token_endpoint_auth_method` が `private_key_jwt` の登録: `jwks` か `jwks_uri` を求める（OIDC Core 1.0 §9）
 * - `token_endpoint_auth_signing_alg`: ディスカバリーが `token_endpoint_auth_signing_alg_values_supported` に公開する alg（`none` は受け付けない）
 * - `request_uris`: OP が `request_uri` に応答するときだけ（`requestUriRegistrationPolicyOf()`）、https の絶対 URL（フラグメント可）の配列として登録する
 * - `client_name`、`logo_uri`、`policy_uri`、`tos_uri`、`client_uri`: ログイン画面と同意画面に表示するので、`RegisteredClient` の名前でも持つ
 * - 登録の設定（config.ts）の独自のメタデータ
 *
 * 理解しないメタデータは黙って無視する（RFC 7591 §2 の MUST）。
 * `error_description` はどれも固定の ASCII の文字列で、リクエストの値を含めない。
 *
 * @spec RFC 7591 §2
 * @spec RFC 7591 §2.1
 * @throws {ClientRegistrationError} `invalid_redirect_uri` か `invalid_client_metadata`: メタデータが検証を通らないとき
 */
export function validateRegistrationMetadata(
  c: any,
  metadata: Record<string, unknown>,
): DynamicallyRegisteredClient {
  const config: DynamicClientRegistrationConfig = c.get('dynamicClientRegistrationConfig');
  const providerConfig: ProviderConfig = c.get('config');
  const responseTypes = supportedResponseTypes();
  const requestObjectSigningAlgs = registrableRequestObjectSigningAlgs(providerConfig);
  const requestUris = requestUriRegistrationPolicyOf(providerConfig);
  const validated = validateClientMetadata(metadata, {
    tokenEndpointAuthMethods: config.tokenEndpointAuthMethods,
    grantTypes: registrableGrantTypes(config.grantTypes, responseTypes),
    responseTypes,
    scopes: registrableScopes(),
    idTokenSigningAlgValuesSupported: signingAlgsOf(c.get('idTokenSigningKeys')),
    userinfoSigningAlgValuesSupported: signingAlgsOf(c.get('userinfoSigningKeys')),
    acceptJwksUri: config.acceptJwksUri,
    allowInsecureJwksUri: providerConfig.allowInsecureClientJwksUri,
    ...(requestObjectSigningAlgs === undefined
      ? {}
      : { requestObjectSigningAlgValuesSupported: requestObjectSigningAlgs }),
    tokenEndpointAuthSigningAlgValuesSupported: providerConfig.tokenEndpointAuthSigningAlgValuesSupported,
    acceptRequestUris: requestUris.accept,
    allowInsecureRequestUris: requestUris.allowInsecure,
    customMetadata: config.customClientMetadata,
  });
  return buildRegisteredClient(validated);
}

/**
 * `request_uris` を登録するかどうかと、`http` の URL を許すかどうかを返す。
 *
 * 登録するのは、ディスカバリーが `request_uri_parameter_supported: true` を公開するとき（request-object の機能が `request_uri` に応答するとき）だけで、それ以外は理解しないメタデータとして無視させる（RFC 7591 §2）。
 * `http` の URL は、request-object の機能の設定 `allowInsecureRequestUri`（開発用）が有効なときだけ許す。
 * その設定はこの機能のものではないので、型ではなく名前で読み、機能がないときは無効として扱う。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @spec OIDC Discovery 1.0 §3
 */
export function requestUriRegistrationPolicyOf(config: ProviderConfig): { accept: boolean; allowInsecure: boolean } {
  const advertised = discoveryOf(features, {}, config.issuer, config)['request_uri_parameter_supported'];
  return {
    accept: advertised === true,
    allowInsecure: (config as unknown as Record<string, unknown>)['allowInsecureRequestUri'] === true,
  };
}

/**
 * 登録で指定できる `request_object_signing_alg` の値の一覧か `undefined` を返す。
 *
 * ディスカバリーが `request_object_signing_alg_values_supported` に公開する alg と同じ一覧で（OIDC Discovery 1.0 §3）、署名のないリクエストオブジェクトを受け付けるあいだは `none` も含む。
 * そのメンバーを公開する機能がない（request-object の機能のない OP）ときは `undefined` を返し、`request_object_signing_alg` を理解しないメタデータとして無視させる。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 */
export function registrableRequestObjectSigningAlgs(config: ProviderConfig): readonly string[] | undefined {
  const advertised = discoveryOf(features, {}, config.issuer, config)['request_object_signing_alg_values_supported'];
  return Array.isArray(advertised) ? advertised.filter((alg): alg is string => typeof alg === 'string') : undefined;
}

/**
 * 設定のグラントタイプのうち、OP が応答するものを返す。
 *
 * OP が応答するのは、`authorization_code`、生成された機能がトークンエンドポイントで応答するグラントタイプ、`responseTypes` に `token` か `id_token` を含むレスポンスタイプがあるときの `implicit` である（`implicit` とこれらのレスポンスタイプの対応は OIDC Dynamic Client Registration 1.0 §2 による）。
 * 応答しないグラントタイプは、設定にあっても登録させない。
 * 登録できても、そのクライアントはそのグラントタイプを使えないからである。
 *
 * @spec RFC 7591 §2
 */
export function registrableGrantTypes(configured: readonly string[], responseTypes: readonly string[]): string[] {
  const offered = ['authorization_code', ...tokenGrantsOf(features)];
  const answersImplicit = responseTypes.some(
    (responseType) => responseTypeIncludes(responseType, 'token') || responseTypeIncludes(responseType, 'id_token'),
  );
  if (answersImplicit) offered.push('implicit');
  return configured.filter((grantType) => offered.includes(grantType));
}

/**
 * 登録できるスコープの一覧か `undefined` を返す。
 *
 * scopes.ts に独自のスコープを宣言していれば、標準のスコープと宣言したスコープの一覧を返す（`/authorize` で `findUnsupportedScopes()` が受け付けるスコープと同じ）。
 * 宣言していなければ一覧はなく `undefined` を返すので、構文が正しいスコープならどれでも登録できる。
 */
export function registrableScopes(): readonly string[] | undefined {
  return CUSTOM_SCOPES.length === 0 ? undefined : [...STANDARD_SCOPES, ...CUSTOM_SCOPES];
}

/**
 * 署名鍵の集合の JWA アルゴリズムを、重複なく返す。
 *
 * ディスカバリーがその鍵の集合について公開するアルゴリズムと同じ値になる。
 * `keys` が `undefined` なら、空の配列を返す。
 */
function signingAlgsOf(keys: SigningKey[] | undefined): string[] {
  return [...new Set((keys ?? []).map((key) => getJwaAlgorithm(key.privateKey)))];
}
