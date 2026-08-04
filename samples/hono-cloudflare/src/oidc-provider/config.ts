import type {
  ClientInfo,
  ClientResolver,
  TokenClientInfo,
  TokenClientResolver,
} from '@maronn-openid-connect/core';

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
   * false の場合はOAuth 2.1方針としてPKCE(S256)を必須にする。true の場合でも
   * core 側は明示的な confidential client の完全な非PKCE requestだけを許可し、
   * 不正なPKCE値やpublic clientの非PKCE requestは拒否する。
   */
  allowNonPkceAuthorizationCodeFlow: boolean;
  /**
   * OIDC Core 1.0 §6.1: 署名無し（`alg: "none"`）Request Object を互換受理するか。
   * 既定は false（署名付き Request Object のみ受理）。OIDF Conformance Suite の一部
   * module は unsigned Request Object を送るため、Basic OP conformance 互換のときだけ
   * true にする。true の場合は discovery の request_object_signing_alg_values_supported に
   * "none" も広告される。
   */
  allowUnsignedRequestObject: boolean;
  /**
   * 任意。client redirect が禁止される非リダイレクト型の authorization error
   * （未知 client_id / 未登録 redirect_uri / fragment 付き redirect_uri など、
   * OIDC Core 1.0 §3.1.2.2）の HTML フォールバックを、views.errorPage() で直接
   * 返す代わりに OP 内部のエラーページパスへ 303 リダイレクトしたいときに設定する。
   * Next.js の error.tsx のような framework-native なエラー画面へ委ねるためのフック。
   * 未設定なら従来どおり views.errorPage() を c.html で返す（express/fastify/hono の
   * デフォルト）。なお Accept: application/json の programmatic caller には、この設定の
   * 有無に関わらず常に 400 の OAuth error JSON を返す。
   */
  authorizationErrorRedirectPath?: string;
}

/**
 * Optional defaults for quick local testing.
 * Production code should create ProviderConfig from environment variables,
 * KV, D1, or another project-owned configuration source.
 */
export const defaultProviderConfig: ProviderConfig = {
  issuer: 'http://localhost:3000',
  accessTokenExpiresIn: 3600,
  idTokenExpiresIn: 3600,
  // OAuth 2.1 §6.1: refresh token は initial issuance から 90 日（7776000 秒）で必ず失効する。
  refreshTokenAbsoluteLifetime: 7776000,
  accessTokenFormat: 'jwt',
  // OIDC Core 1.0 §3.1.3.1: authorization code は short-lived であるべき（5 分 = 300 秒）。
  authorizationCodeTtl: 300,
  allowNonPkceAuthorizationCodeFlow: false,
  // OIDC Core 1.0 §6.1: require signed Request Objects by default; enable only for
  // Basic OP conformance compatibility where the suite sends unsigned ones.
  allowUnsignedRequestObject: false,
};

export function createProviderConfig(
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    ...defaultProviderConfig,
    ...overrides,
  };
}

/**
 * Extended client info with offline_access permission.
 * offlineAccessAllowed: controls whether the client may request refresh tokens
 * via the offline_access scope (OAuth 2.1 / OIDC offline_access).
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
 */
export type RegisteredClient = ClientInfo & TokenClientInfo & {
  offlineAccessAllowed?: boolean;
  userinfoSignedResponseAlg?: 'RS256' | 'ES256';
  idTokenSignedResponseAlg?: 'RS256' | 'ES256';
};

/**
 * Optional in-memory defaults for quick local testing only.
 * Prefer D1, KV, or another project-owned client resolver in real projects.
 */
export const defaultRegisteredClients: ReadonlyMap<string, RegisteredClient> = new Map([
  [
    'example-client',
    {
      clientId: 'example-client',
      clientSecret: 'example-secret',
      redirectUris: ['http://localhost:3000/callback'],
      clientType: 'confidential' as const,
      offlineAccessAllowed: true,
      // RFC 7591 §2: grant_types default is ["authorization_code"]. This client uses
      // offline_access (refresh tokens), so it must explicitly register refresh_token.
      // EXPERIMENTAL (RFC 8693): registering the token-exchange URN is what lets
      // this confidential client exchange its access tokens. Remove it to forbid
      // exchanges for this client; public clients are rejected either way.
      grantTypes: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:token-exchange'],
      // RFC 7591 §2: token_endpoint_auth_method default is client_secret_basic.
      // The sample client authenticates with client_secret_post, so register it explicitly.
      tokenEndpointAuthMethod: 'client_secret_post',
      // OIDC Dynamic Client Registration 1.0 §2: default_max_age (seconds).
      // When the authorization request omits max_age, the OP applies this as the
      // default re-authentication freshness. A request-supplied max_age overrides it.
      defaultMaxAge: 3600,
    },
  ],
]);

export function createInMemoryClientResolver(
  clients: ReadonlyMap<string, RegisteredClient> = defaultRegisteredClients,
): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      return clients.get(clientId) ?? null;
    },
  };
}
