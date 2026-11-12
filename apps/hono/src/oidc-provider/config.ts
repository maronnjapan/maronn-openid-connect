import {
  SUPPORTED_CLIENT_ASSERTION_SIGNING_ALGS,
  type ClientInfo,
  type ClientKeysByPurpose,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import { configOf } from './features/feature.js';
import { features } from './features/enabled.js';

/**
 * The settings of the provider.
 *
 * The fields below are the ones every generated provider has. A feature that
 * needs a setting of its own adds it to this interface from its directory
 * (`declare module '../../config.js'` in features/<id>/), and its default from
 * the config entry of its feature.ts. Removing the feature removes both.
 */
export interface ProviderConfig {
  issuer: string;
  accessTokenExpiresIn: number;
  idTokenExpiresIn: number;
  /**
   * Refresh token の absolute lifetime（秒）。初回発行時刻からの絶対的な有効期限。
   * OAuth 2.1 §6.1: refresh token rotation で sliding expiry を毎回延長すると、利用者が
   * リフレッシュし続ける限り RT が無期限に延び、漏洩 RT が長期間 abuse され得る。本実装は
   * sliding expiry を持たず、RT の expiresAt は initial issuance（originalIssuedAt）からの
   * この absolute lifetime のみで決まる。rotation しても失効時刻は前に進まない。
   * 設定例: 90 日 = 7776000。
   */
  refreshTokenAbsoluteLifetime: number;
  /**
   * online refresh token（`offline_access` が付与されていない grant にも発行する
   * Refresh Token）を有効にするか。
   *
   * OIDC Core 1.0 §11 は `offline_access` を「End-User が居ない（not logged in）ときにも
   * 使える Refresh Token」と定義したうえで、Refresh Token の利用がその用途に限られない
   * ことを明示している（"The use of Refresh Tokens is not exclusive to the
   * `offline_access` use case. The Authorization Server MAY grant Refresh Tokens in
   * other contexts that are beyond the scope of this specification."）。本 OP はその
   * 「other contexts」を online refresh token として実装する。
   *
   * - `true`（既定）: `grant_types` に `refresh_token` を登録したクライアントには、
   *   `offline_access` が無くても Refresh Token を発行する。ただし発行元のログイン
   *   セッションに結び付けられ、セッションが終われば `invalid_grant` になる。ブラウザ
   *   セッションを持たない経路（device authorization grant）では発行しない。
   * - `false`: Refresh Token は `offline_access` が付与された grant にだけ発行する。
   *   ログアウトしても使い続けられる offline refresh token だけになる。
   */
  onlineRefreshTokenEnabled: boolean;
  /**
   * アクセストークンの形式。
   * - 'jwt' (デフォルト): 自己完結。ステートレス検証可能だが即時失効が困難。
   * - 'opaque'         : 不透明文字列。リソースサーバは Introspection / ストア参照で検証。
   *                      Revocation との相性が良く、即時失効が必要なケースに向く。
   */
  accessTokenFormat: 'jwt' | 'opaque';
  /**
   * Authorization code の有効期間（秒）。OIDC Core 1.0 §3.1.3.1 は authorization code を
   * short-lived にすることを求めており（推奨上限 10 分）、本ライブラリは core helper の
   * デフォルトと同じ 300 秒（5 分）を既定値とする。PoC でタイムアウト挙動を確認したい場合は
   * この値を縮めて検証できる。
   */
  authorizationCodeTtl: number;
  /**
   * OpenID Foundation Basic OP static-client conformance 互換モード。
   * true の場合、core は明示的な confidential client の完全な非 PKCE request だけを
   * 許可し、不正な PKCE 値や public client の非 PKCE request は拒否する。
   * false の場合は OAuth 2.1 方針として PKCE(S256) を必須にする。
   *
   * The pkce feature (features/pkce/) sets the default to false. A provider
   * generated with --disable pkce keeps the default of this file, true.
   */
  allowNonPkceAuthorizationCodeFlow: boolean;
  /**
   * `scope` に `openid` を必須にするか（OIDC Core 1.0 §3.1.2.1）。
   *
   * - `false`（既定）: `openid` のない認可リクエストを、OpenID Connect ではない OAuth 2.0 の
   *   認可リクエストとして受け付ける（OIDC Core 1.0 §3.1.2.2、RFC 6749 §4.1）。発行するトークンは
   *   `openid` スコープを持たないので、ID トークンは発行されず、UserInfo エンドポイントは
   *   `insufficient_scope` で拒否する。`code` 以外の `response_type`（インプリシットフローと
   *   ハイブリッドフロー）は OpenID Connect のフローなので、この設定でも `openid` を求める。
   * - `true`: OpenID Connect のリクエストだけを受け付け、`openid` のないリクエストを
   *   `invalid_scope` で拒否する。
   *
   * どちらでも `scope` は必須で、この認可サーバーは既定のスコープを持たない（RFC 6749 §3.3）。
   * 認可エンドポイントのほか、PAR とデバイス認可のエンドポイント（それらの機能を生成したとき）も
   * この設定に従う。CIBA は仕様が `openid` を求めるので、常に必須である（CIBA Core 1.0 §7.1）。
   */
  requireOpenIdScope: boolean;
  /**
   * The settings below are for the jwks_uri a client registers (RFC 7591 §2,
   * RegisteredClient.jwksUri): the OP fetches the client's keys from it when a
   * process needs them, such as the verification of a signed Request Object
   * (client-jwks-uri.ts). They are flat fields, so overriding one keeps the
   * defaults of the others.
   *
   * allowInsecureClientJwksUri: let a jwks_uri use http, localhost, and
   * loopback, private and link-local addresses. For development only: by
   * default the OP fetches https URLs of public hosts only, so a jwks_uri
   * cannot make it reach into its own network (RFC 8725 §3.10). The names a
   * DNS host resolves to are not checked; pass outboundFetch (app.ts) to send
   * the fetches through an egress proxy that does.
   */
  allowInsecureClientJwksUri: boolean;
  /**
   * How long (seconds) the keys of a jwks_uri are used when its response has
   * no Cache-Control max-age (RFC 9111 §4.2.2). Default 300.
   */
  clientJwksUriCacheTtlSeconds: number;
  /**
   * The least time (seconds) the keys of a jwks_uri are used, whatever its
   * response says (a smaller max-age, no-cache, no-store), so a request does
   * not fetch the jwks_uri every time. Default 30. Set 0 to follow max-age=0,
   * no-cache and no-store as RFC 9111 asks; every Request Object of such a
   * client then fetches its jwks_uri.
   */
  clientJwksUriCacheMinTtlSeconds: number;
  /**
   * The most time (seconds) the keys of a jwks_uri are used, whatever max-age
   * its response gives: a key the client removes from its jwks_uri stops
   * verifying after this long at most. Default 300.
   */
  clientJwksUriCacheMaxTtlSeconds: number;
  /**
   * OIDC Core 1.0 §10.1.1: a kid the cached keys do not have makes the OP
   * fetch the jwks_uri again, at most once per this many seconds (and a failed
   * fetch of expired keys is remembered as long). Default 30.
   */
  clientJwksUriRefetchIntervalSeconds: number;
  /** How long (milliseconds) the OP waits for a jwks_uri to answer. Default 3000. */
  clientJwksUriTimeoutMs: number;
  /** The largest jwks_uri document (bytes) the OP reads. Default 65536. */
  clientJwksUriMaxBytes: number;
  /** The most keys a jwks_uri document may hold. Default 32. */
  clientJwksUriMaxKeys: number;
  /** How many jwks_uri the OP keeps the keys of; the oldest is dropped beyond it. Default 1000. */
  clientJwksUriCacheMaxEntries: number;
  /**
   * The ClientKeyResolver purposes the jwks_uri of a client serves: for these,
   * a client with a jwksUri gets the keys of its jwks_uri only. The same as the
   * jwksPurposes of dynamic client registration by default.
   */
  clientJwksUriPurposes: readonly string[];
  /**
   * The JWS algs a private_key_jwt client assertion may be signed with
   * (OIDC Core 1.0 §9, OIDC Discovery 1.0 §3
   * token_endpoint_auth_signing_alg_values_supported). Discovery advertises
   * them for the token endpoint (and the introspection and revocation
   * endpoints of their features), and dynamic client registration accepts
   * them as token_endpoint_auth_signing_alg. By default the algs core
   * verifies: RS256, RS384, RS512 (RFC 7518 §3.3) and ES256, ES384, ES512
   * (§3.4). none and the HS algs are never accepted. The list must not be
   * empty while the OP advertises private_key_jwt (RFC 8414 §2), as it always
   * does: discovery throws otherwise.
   */
  tokenEndpointAuthSigningAlgValuesSupported: readonly string[];
  /**
   * The URLs a client registered for the End-User to see (logo_uri,
   * policy_uri, tos_uri, client_uri; OIDC Dynamic Client Registration 1.0 §2)
   * appear on the login and consent pages only when they use https
   * (client-display.ts). allowInsecureClientDisplayUris lets them use http
   * too, for development only. Default false.
   */
  allowInsecureClientDisplayUris: boolean;
  /**
   * OIDC Dynamic Client Registration 1.0 §9.1: show the logo_uri and
   * policy_uri of a client only when their host is the host of one of its
   * redirect_uris, so a client cannot borrow the logo or the policy of
   * another site. Default false (the hosts are not compared).
   */
  requireClientDisplayUriHostMatch: boolean;
}

/**
 * The defaults of the fields above. The features add theirs on top
 * (createProviderConfig()), the defaults of the fields they declare included.
 */
const baseProviderConfig = {
  issuer: 'http://localhost:3000',
  accessTokenExpiresIn: 3600,
  idTokenExpiresIn: 3600,
  // OAuth 2.1 §6.1: refresh token は initial issuance から 90 日（7776000 秒）で必ず失効する。
  refreshTokenAbsoluteLifetime: 7776000,
  // OIDC Core 1.0 §11: offline_access 無しの Refresh Token（online refresh token）も
  // 発行する。ログインセッションに結び付けられるため、ログアウトすると使えなくなる。
  onlineRefreshTokenEnabled: true,
  accessTokenFormat: 'jwt',
  // OIDC Core 1.0 §3.1.3.1: authorization code は short-lived であるべき（5 分 = 300 秒）。
  authorizationCodeTtl: 300,
  allowNonPkceAuthorizationCodeFlow: true,
  // OIDC Core 1.0 §3.1.2.2: `openid` のないリクエストも、OAuth 2.0 の認可リクエストとして受け付ける。
  requireOpenIdScope: false,
  // RFC 7591 §2 jwks_uri: https and public hosts only (RFC 8725 §3.10).
  allowInsecureClientJwksUri: false,
  // RFC 9111 §5.2.2.1: max-age within 30 to 300 seconds, 300 without max-age.
  clientJwksUriCacheTtlSeconds: 300,
  clientJwksUriCacheMinTtlSeconds: 30,
  clientJwksUriCacheMaxTtlSeconds: 300,
  // OIDC Core 1.0 §10.1.1: an unknown kid refetches at most every 30 seconds.
  clientJwksUriRefetchIntervalSeconds: 30,
  clientJwksUriTimeoutMs: 3000,
  clientJwksUriMaxBytes: 65536,
  clientJwksUriMaxKeys: 32,
  clientJwksUriCacheMaxEntries: 1000,
  clientJwksUriPurposes: ['request_object', 'private_key_jwt', 'dpop'],
  // OIDC Core 1.0 §9: the asymmetric algs core verifies (RFC 7518 §3.3 / §3.4).
  tokenEndpointAuthSigningAlgValuesSupported: [...SUPPORTED_CLIENT_ASSERTION_SIGNING_ALGS],
  // OIDC Dynamic Client Registration 1.0 §2 / §9.1: https only, hosts not compared.
  allowInsecureClientDisplayUris: false,
  requireClientDisplayUriHostMatch: false,
} satisfies Partial<ProviderConfig>;

/**
 * 既定値に上書きを重ねた OP の設定を返す。
 *
 * このファイルの既定値、有効な機能の既定値、アプリが渡す `overrides` の順に重ね、後のものが前のものを上書きする。
 * 本番の環境では、`overrides` の値を環境変数、KV、D1 など、プロジェクトが管理する設定から読むようにする。
 */
export function createProviderConfig(
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  // 三つを重ねた設定を `ProviderConfig` として返す。
  // 機能が宣言した項目の既定値は、その機能の `feature.ts` の `config` にあるので、重ねた結果はすべての項目がそろった `ProviderConfig` になる。
  return {
    ...baseProviderConfig,
    ...configOf(features),
    ...overrides,
  } as ProviderConfig;
}

/**
 * Extended client info for this provider.
 *
 * Whether a client may receive refresh tokens is decided by the standard
 * `grantTypes` registration metadata (RFC 7591 §2 / OIDC Dynamic Client
 * Registration 1.0 §2) it already carries through TokenClientInfo — there is no
 * separate provider-specific switch. `grantTypes` containing `refresh_token`
 * gates both refresh token flavors; OIDC Core 1.0 §11 (prompt=consent) decides
 * which flavor the authorization produces.
 *
 * scope (RFC 7591 §2 `scope`, from ClientInfo / TokenClientInfo): the scope
 * values this client may request. When set, a request for any other scope is
 * rejected with invalid_scope at /authorize (and at the device and CIBA
 * endpoints when they are generated). Leave it out to let the client request
 * every scope the provider accepts.
 *
 * userinfoSignedResponseAlg: when set, the UserInfo endpoint returns a signed JWT
 * with content-type `application/jwt` (OIDC Core 1.0 Section 5.3.2 — client metadata
 * `userinfo_signed_response_alg`). The endpoint picks a registered UserInfo signing
 * key whose alg matches this value (mirroring idTokenSignedResponseAlg), so the
 * response is signed with the requested alg — not limited to RS256. A request whose
 * alg has no registered key is rejected as a server configuration error.
 *
 * idTokenSignedResponseAlg: chooses the JWA alg for this client's ID Token
 * (OIDC Dynamic Client Registration 1.0 §2 — client metadata
 * `id_token_signed_response_alg`). When omitted, the OIDC default `RS256` is used.
 * The token endpoint picks an actual signing key matching this alg from the
 * registered ID Token key set; a request whose alg has no registered key is
 * rejected as a server configuration error.
 *
 * The client's public keys are not part of it: each process that needs them
 * asks the ClientKeyResolver for the keys of its own purpose
 * (ClientRegistration.keys below, kept by registerClient() of db/).
 *
 * jwksUri (RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2 — client
 * metadata `jwks_uri`): the URL of the client's JWK Set. The ClientKeyResolver
 * of app.ts fetches the keys of the purposes of clientJwksUriPurposes from it
 * (client-jwks-uri.ts), so the client rotates its keys there without the OP
 * changing anything. A client registers either jwksUri or keys, never both.
 *
 * requestObjectSigningAlg (OIDC Dynamic Client Registration 1.0 §2 — client
 * metadata `request_object_signing_alg`): every Request Object of the client
 * must be signed with this alg, `none` included (OIDC Core 1.0 §6.3.2); the
 * request-object feature rejects any other. Leave it out to accept every alg
 * the provider accepts. An alg the provider does not accept is not refused at
 * registration; the Request Objects of the client are.
 *
 * tokenEndpointAuthSigningAlg (TokenClientInfo; OIDC Dynamic Client
 * Registration 1.0 §2 — client metadata `token_endpoint_auth_signing_alg`):
 * the alg every private_key_jwt client assertion of the client must be signed
 * with (client-auth.ts). A client authenticating with private_key_jwt
 * (tokenEndpointAuthMethods) registers its keys under the private_key_jwt
 * purpose, or a jwksUri.
 *
 * requestUris (OIDC Dynamic Client Registration 1.0 §2 — client metadata
 * `request_uris`): the request_uri values the client uses (OIDC Core 1.0
 * §6.2). The request-object feature fetches a request_uri, and, with its
 * requireRequestUriRegistration setting, accepts the registered values only.
 *
 * clientName, clientUri, logoUri, policyUri and tosUri (OIDC Dynamic Client
 * Registration 1.0 §2 — client metadata `client_name`, `client_uri`,
 * `logo_uri`, `policy_uri` and `tos_uri`): what the login and consent screens
 * show the End-User about the client (views.tsx), in place of the bare
 * client_id.
 *
 * A feature that reads client metadata of its own adds it to this interface
 * from its directory (`declare module '../../config.js'` in features/<id>/),
 * so removing the feature removes the field.
 */
export interface RegisteredClient extends ClientInfo, TokenClientInfo {
  userinfoSignedResponseAlg?: 'RS256' | 'ES256';
  idTokenSignedResponseAlg?: 'RS256' | 'ES256';
  jwksUri?: string;
  requestObjectSigningAlg?: string;
  requestUris?: string[];
  clientName?: string;
  clientUri?: string;
  logoUri?: string;
  policyUri?: string;
  tosUri?: string;
}

/**
 * A client as registerClient() (db/clients.ts) takes it: the RegisteredClient
 * and its public keys by purpose (keys). A purpose names the process that uses
 * the keys: request_object for signed Request Objects (OIDC Core 1.0 §6.3.2)
 * and private_key_jwt for client assertions (§9), which the OP verifies, or
 * another one such as dpop (RFC 9449) for a process a project adds. Register
 * the same key under two purposes to use it for both.
 * A client with a jwksUri registers no keys: registerClient() rejects both.
 *
 * clientSecret is the secret as the client presents it; registerClient()
 * stores only its hash (clientSecretHash).
 */
export type ClientRegistration = RegisteredClient & {
  keys?: ClientKeysByPurpose;
};
