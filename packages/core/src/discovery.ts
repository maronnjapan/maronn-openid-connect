/**
 * OpenID Connect Discovery 1.0
 * https://openid.net/specs/openid-connect-discovery-1_0.html
 */

import { getJwaAlgorithm } from './crypto-utils.js';
import { isLoopbackHostname } from './loopback.js';
import { assertHasRs256Key } from './signing-key.js';

/**
 * Provider Metadata configuration (camelCase input)
 * Maps to the OpenID Provider Metadata fields defined in Section 3.
 */
export interface ProviderMetadataConfig {
  // Required
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  responseTypesSupported: string[];
  subjectTypesSupported: string[];
  /**
   * ID Token signing keys registered with the OP. The list of advertised
   * `id_token_signing_alg_values_supported` is derived from these keys via
   * `getJwaAlgorithm` (deduplicated). Must include at least one RS256 key
   * (OIDC Core 1.0 §15.1, enforced by `assertHasRs256Key`).
   *
   * Letting the OP advertise an alg list it cannot actually sign with breaks
   * client-side ID Token verification, so we derive the list from the actual
   * keys instead of accepting a manual string list.
   */
  idTokenSigningKeys: CryptoKey[];

  // Recommended
  userinfoEndpoint?: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  claimsSupported?: string[];
  /**
   * OIDC Discovery 1.0 §3: Claim Types the OP supports (`normal` / `aggregated` /
   * `distributed`). OPTIONAL; omitted means `normal` only. This OP implements Normal
   * Claims only, so only `["normal"]` is valid here — any other value is rejected to
   * avoid advertising an unimplemented capability (Aggregated/Distributed).
   */
  claimTypesSupported?: string[];
  /**
   * Algorithms the OP can use to sign UserInfo responses.
   * Required to advertise when any client uses userinfo_signed_response_alg
   * (OIDC Discovery 1.0 Section 3, Core 1.0 Section 5.3.2).
   */
  userinfoSigningAlgValuesSupported?: string[];

  // Optional
  grantTypesSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  responseModesSupported?: string[];
  claimsParameterSupported?: boolean;
  requestParameterSupported?: boolean;
  requestUriParameterSupported?: boolean;
  /**
   * OIDC Discovery 1.0 §3: JWS `alg` values the OP supports for signed Request
   * Objects (`request` parameter). Advertise when `requestParameterSupported` is
   * true so clients know which signing algorithms to use (e.g. `["RS256"]`).
   */
  requestObjectSigningAlgValuesSupported?: string[];

  // RFC 9207 §3: indicates that the AS returns the `iss` parameter in
  // authorization responses for issuer identification.
  authorizationResponseIssParameterSupported?: boolean;

  // RFC 8414 (OAuth 2.0 Authorization Server Metadata) — advertised here
  // because the major IdPs put them on this same document even though
  // OIDC Discovery 1.0 itself does not define them.
  introspectionEndpoint?: string;
  introspectionEndpointAuthMethodsSupported?: string[];
  revocationEndpoint?: string;
  revocationEndpointAuthMethodsSupported?: string[];
}

/**
 * OpenID Provider Metadata (snake_case output as per the spec)
 */
export interface ProviderMetadata {
  // Required
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];

  // Recommended
  userinfo_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  claims_supported?: string[];
  claim_types_supported?: string[];
  userinfo_signing_alg_values_supported?: string[];

  // Optional
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  response_modes_supported?: string[];
  claims_parameter_supported?: boolean;
  request_parameter_supported?: boolean;
  request_uri_parameter_supported?: boolean;
  request_object_signing_alg_values_supported?: string[];

  // RFC 9207 §3
  authorization_response_iss_parameter_supported?: boolean;

  // RFC 8414
  introspection_endpoint?: string;
  introspection_endpoint_auth_methods_supported?: string[];
  revocation_endpoint?: string;
  revocation_endpoint_auth_methods_supported?: string[];
}

/**
 * `issuer` を発行者の識別子として検証する。
 *
 * 次のどれかに当てはまれば `Error` を投げる。
 * - 空文字列である
 * - URL として解析できない
 * - スキームが `https` でない（開発用に、ループバックのホストの `localhost`、`127.` で始まる IPv4 アドレス、`[::1]` は除く）
 * - クエリを含む
 * - フラグメントを含む
 *
 * @spec OIDC Discovery 1.0 §3
 * @throws {Error} 上のどれかに当てはまるとき
 */
function validateIssuer(issuer: string): void {
  if (!issuer) {
    throw new Error('issuer is required');
  }

  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`issuer must be a valid URL: ${issuer}`);
  }

  if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('issuer must use https scheme (except loopback hosts)');
  }

  if (url.search) {
    throw new Error('issuer must not contain query parameters');
  }

  if (url.hash) {
    throw new Error('issuer must not contain a fragment');
  }
}

/**
 * 設定を検証し、OP のメタデータを組み立てて返す。
 *
 * 返す値はディスカバリーのメタデータで、設定のキャメルケースの名前を、仕様のスネークケースの名前（`authorization_endpoint` など）に置き換えたものである。
 * 次の設定がないか空なら `Error` を投げる。
 * - `issuer`（発行者の識別子としての条件も検証する）
 * - `authorizationEndpoint`、`tokenEndpoint`、`jwksUri`
 * - `responseTypesSupported`、`subjectTypesSupported`、`idTokenSigningKeys`
 *
 * `idTokenSigningKeys` には、RS256 の鍵が少なくとも 1 つ必要である（OIDC Core 1.0 §15.1）。
 * `id_token_signing_alg_values_supported` には、鍵の集合から求めたアルゴリズムを、重複を除いて鍵の順に並べる。
 *
 * 任意の項目のうち、配列は要素があるときだけ、真偽値は指定されたときだけ、エンドポイントの URL は空でないときだけ含める。
 * `claimTypesSupported` に指定できる値は `normal` だけである。
 *
 * @spec OIDC Discovery 1.0 §3
 * @spec OIDC Core 1.0 §15.1
 * @throws {Error} 必須の設定がないか空のとき、`issuer` が条件を満たさないとき、RS256 の鍵がないとき、RSASSA-PKCS1-v1_5 でも ECDSA でもない鍵があるとき、または `claimTypesSupported` に `normal` 以外の値があるとき
 */
export function buildProviderMetadata(config: ProviderMetadataConfig): ProviderMetadata {
  validateIssuer(config.issuer);

  if (!config.authorizationEndpoint) {
    throw new Error('authorizationEndpoint is required');
  }
  if (!config.tokenEndpoint) {
    throw new Error('tokenEndpoint is required');
  }
  if (!config.jwksUri) {
    throw new Error('jwksUri is required');
  }
  if (!config.responseTypesSupported || config.responseTypesSupported.length === 0) {
    throw new Error('responseTypesSupported must not be empty');
  }
  if (!config.subjectTypesSupported || config.subjectTypesSupported.length === 0) {
    throw new Error('subjectTypesSupported must not be empty');
  }
  if (!config.idTokenSigningKeys || config.idTokenSigningKeys.length === 0) {
    throw new Error('idTokenSigningKeys must not be empty');
  }
  // 鍵の集合に RS256 の鍵が 1 つもなければ例外を投げる（OIDC Core 1.0 §15.1）。
  assertHasRs256Key(config.idTokenSigningKeys);

  // 公開するアルゴリズムを、実際の鍵の集合から重複を除いて求める。
  // 鍵の順を保つので、同じ順の鍵からは毎回同じ一覧ができる。
  const idTokenAlgs: string[] = [];
  const seenAlgs = new Set<string>();
  for (const key of config.idTokenSigningKeys) {
    const alg = getJwaAlgorithm(key);
    if (!seenAlgs.has(alg)) {
      seenAlgs.add(alg);
      idTokenAlgs.push(alg);
    }
  }

  const metadata: ProviderMetadata = {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    jwks_uri: config.jwksUri,
    response_types_supported: config.responseTypesSupported,
    subject_types_supported: config.subjectTypesSupported,
    id_token_signing_alg_values_supported: idTokenAlgs,
  };

  // 推奨の項目を、設定されていれば含める。
  if (config.userinfoEndpoint) {
    metadata.userinfo_endpoint = config.userinfoEndpoint;
  }
  if (config.registrationEndpoint) {
    metadata.registration_endpoint = config.registrationEndpoint;
  }
  // 要素のない配列の項目は含めない（OIDC Discovery 1.0 の MUST）。
  if (config.scopesSupported && config.scopesSupported.length > 0) {
    metadata.scopes_supported = config.scopesSupported;
  }
  if (config.claimsSupported && config.claimsSupported.length > 0) {
    metadata.claims_supported = config.claimsSupported;
  }
  if (config.claimTypesSupported && config.claimTypesSupported.length > 0) {
    // `normal` 以外の値があれば例外を投げる（OIDC Core 1.0 §5.6）。
    // この OP は通常のクレームしか返さない（`filterClaimsByScope()` は `_claim_names` も `_claim_sources` も出力しない）ので、ほかの種類を公開すると実際の振る舞いと食い違う。
    const invalid = config.claimTypesSupported.filter((t) => t !== 'normal');
    if (invalid.length > 0) {
      throw new Error(
        `Unsupported claim_types_supported value(s): ${invalid.join(', ')}. Only 'normal' is supported.`,
      );
    }
    metadata.claim_types_supported = config.claimTypesSupported;
  }
  if (
    config.userinfoSigningAlgValuesSupported &&
    config.userinfoSigningAlgValuesSupported.length > 0
  ) {
    metadata.userinfo_signing_alg_values_supported =
      config.userinfoSigningAlgValuesSupported;
  }

  // 任意の項目を、設定されていれば含める。
  if (config.grantTypesSupported && config.grantTypesSupported.length > 0) {
    metadata.grant_types_supported = config.grantTypesSupported;
  }
  if (config.tokenEndpointAuthMethodsSupported && config.tokenEndpointAuthMethodsSupported.length > 0) {
    metadata.token_endpoint_auth_methods_supported = config.tokenEndpointAuthMethodsSupported;
  }
  if (config.responseModesSupported && config.responseModesSupported.length > 0) {
    metadata.response_modes_supported = config.responseModesSupported;
  }
  if (config.claimsParameterSupported !== undefined) {
    metadata.claims_parameter_supported = config.claimsParameterSupported;
  }
  if (config.requestParameterSupported !== undefined) {
    metadata.request_parameter_supported = config.requestParameterSupported;
  }
  if (config.requestUriParameterSupported !== undefined) {
    metadata.request_uri_parameter_supported = config.requestUriParameterSupported;
  }
  if (
    config.requestObjectSigningAlgValuesSupported &&
    config.requestObjectSigningAlgValuesSupported.length > 0
  ) {
    metadata.request_object_signing_alg_values_supported =
      config.requestObjectSigningAlgValuesSupported;
  }

  // 認可レスポンスに発行者の識別子（`iss`）を付けるかどうかを公開する（RFC 9207 §3）。
  if (config.authorizationResponseIssParameterSupported !== undefined) {
    metadata.authorization_response_iss_parameter_supported =
      config.authorizationResponseIssParameterSupported;
  }

  // RFC 8414 の項目を、設定されていれば含める。
  // 対応する `*_auth_methods_supported` の一覧を公開するにはエンドポイントの URL も必要だが（RFC 8414 §2）、この関数はそれを確かめない。
  if (config.introspectionEndpoint) {
    metadata.introspection_endpoint = config.introspectionEndpoint;
  }
  if (
    config.introspectionEndpointAuthMethodsSupported &&
    config.introspectionEndpointAuthMethodsSupported.length > 0
  ) {
    metadata.introspection_endpoint_auth_methods_supported =
      config.introspectionEndpointAuthMethodsSupported;
  }
  if (config.revocationEndpoint) {
    metadata.revocation_endpoint = config.revocationEndpoint;
  }
  if (
    config.revocationEndpointAuthMethodsSupported &&
    config.revocationEndpointAuthMethodsSupported.length > 0
  ) {
    metadata.revocation_endpoint_auth_methods_supported =
      config.revocationEndpointAuthMethodsSupported;
  }

  return metadata;
}
