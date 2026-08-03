/**
 * Authentication Request（認可リクエスト）のバリデーション
 * OIDC Core 1.0 Section 3.1.2 / OAuth 2.1 に準拠
 */
import { sanitizeErrorDescription } from './error-utils.js';
import { isLoopbackHostname } from './loopback.js';
import { parseRequestObject, RequestObjectError } from './request-object.js';
import type { JwkSet } from './jwks.js';
import type { ClaimsParameter, ClaimRequestValue } from './userinfo.js';

/**
 * OIDC Core 1.0 §6.1 / OIDC Basic OP の既定 Request Object 署名アルゴリズム。
 * 署名付き Request Object では少なくとも RS256 を必須対応とする。
 */
export const DEFAULT_REQUEST_OBJECT_SIGNING_ALGS = ['RS256'] as const;

/**
 * 認可エンドポイントのエラーコード
 * OAuth 2.1 Section 4.1.2.1 / OIDC Core 1.0 Section 3.1.2.6
 */
export enum AuthorizationErrorCode {
  // OAuth 2.1 Section 4.1.2.1
  InvalidRequest = 'invalid_request',
  UnauthorizedClient = 'unauthorized_client',
  AccessDenied = 'access_denied',
  UnsupportedResponseType = 'unsupported_response_type',
  InvalidScope = 'invalid_scope',
  ServerError = 'server_error',
  TemporarilyUnavailable = 'temporarily_unavailable',
  // OIDC Core 1.0 Section 3.1.2.6
  InteractionRequired = 'interaction_required',
  LoginRequired = 'login_required',
  AccountSelectionRequired = 'account_selection_required',
  ConsentRequired = 'consent_required',
  // OIDC Core 1.0 Section 6.3: returned when the OP does not support the
  // request / request_uri parameters but the client used them.
  RequestNotSupported = 'request_not_supported',
  RequestUriNotSupported = 'request_uri_not_supported',
  // OIDC Core 1.0 §3.1.2.6: returned when the OP does not support the `registration`
  // parameter (Self-Issued OP RP metadata, §7.2.1) but the client used it.
  RegistrationNotSupported = 'registration_not_supported',
}

/**
 * 認可リクエストのパラメータ
 * OAuthパラメータ名（snake_case）をそのままキーとして使用
 */
export interface AuthorizationRequestParams {
  response_type?: string;
  client_id: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  prompt?: string;
  display?: string;
  max_age?: string;
  ui_locales?: string;
  claims_locales?: string;
  acr_values?: string;
  login_hint?: string;
  id_token_hint?: string;
  /**
   * OIDC Core 1.0 §6.1: Request Object passed by value (a signed JWS JWT whose
   * claims are the Authorization Request parameters). Supported here: the JWS is
   * verified against the client's registered keys (`ClientInfo.jwks`) and its
   * claims supersede the OAuth query parameters. Discovery advertises
   * `request_parameter_supported: true`.
   */
  request?: string;
  /**
   * OIDC Core 1.0 §6.2: Request Object passed by reference. Unsupported here
   * (`request_uri_parameter_supported` is false), so a present `request_uri` is
   * rejected with `request_uri_not_supported` (§6.3).
   */
  request_uri?: string;
  /**
   * OIDC Core 1.0 §3.1.2.1 / §7.2.1: Self-Issued OP RP-metadata parameter. Unsupported
   * here, so a present `registration` is rejected with `registration_not_supported` (§3.1.2.6).
   */
  registration?: string;
  // アクセストークンのaudience（スペース区切り）
  audience?: string;
  /**
   * OIDC Core 1.0 §5.5: claims リクエストパラメータ。
   * Authentication Request では JSON 文字列としてシリアライズされて送られる。
   */
  claims?: string;
  // OAuth 2.1 PKCE (required by default; optional only in explicit compatibility mode)
  code_challenge?: string;
  code_challenge_method?: string;
}

/**
 * 外部から提供されるクライアント情報
 *
 * clientId と redirectUris は必ず同一クライアントのものでなければならない。
 * バリデーション関数は clientId の整合性を実行時に検証する。
 *
 * clientType は OAuth 2.1 Section 2.1 のクライアント種別。
 * 'public' (native / SPA 等の機密値を保持できないクライアント) のときだけ
 * ループバックアドレスのポート差異を許容する (OAuth 2.1 Section 10.3.3)。
 * 未指定時は confidential 相当として厳格一致を適用する。
 */
export interface ClientInfo {
  clientId: string;
  redirectUris: string[];
  clientType?: 'confidential' | 'public';
  /**
   * このクライアントが認可エンドポイントで使用してよい response_type の一覧。
   * OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: 既定は `["code"]`。
   * 未指定時は `["code"]` として扱い従来どおり動作する（後方互換）。
   * 登録外の response_type は OAuth 2.1 §4.1.2.1 の `unauthorized_client` で拒否される。
   */
  responseTypes?: string[];
  /**
   * クライアント登録メタデータ `default_max_age`（秒）。
   * OIDC Dynamic Client Registration 1.0 §2: リクエストに `max_age` が無い場合の
   * 既定の再認証鮮度として OP 側で適用する。`max_age` リクエストパラメータが
   * 来た場合はそちらが優先（上書き）される（Core 1.0 §3.1.2.1）。
   * 値は非負整数（秒）でなければならず、不正値は server_error として拒否される。
   * `default_max_age` は OPTIONAL なメタデータであり、未指定の場合はフォールバックを行わない。
   */
  defaultMaxAge?: number;
  /**
   * クライアントが登録した公開鍵集合（JWKS）。
   * OIDC Core 1.0 §6.1: 署名付き Request Object（`request` パラメータ）の JWS 署名検証に使う。
   * 署名付き Request Object を受け付けるクライアントでは必須。未登録のまま署名付き
   * Request Object を受け取った場合は `invalid_request` で拒否される。
   */
  jwks?: JwkSet;
}

/**
 * クライアント情報を解決するインターフェース
 *
 * 実装者は、引数の clientId に対応するクライアント情報を返す責務を持つ。
 * findClient が返す ClientInfo.clientId は、引数の clientId と一致しなければならない。
 * この制約はバリデーション関数内で実行時に検証され、
 * 不一致の場合はエラーとなる。
 *
 * @example
 * ```ts
 * const resolver: ClientResolver = {
 *   findClient: async (clientId) => {
 *     const row = await db.query('SELECT * FROM clients WHERE id = ?', [clientId]);
 *     if (!row) return null;
 *     return { clientId: row.id, redirectUris: row.redirect_uris };
 *   },
 * };
 * ```
 */
export interface ClientResolver {
  findClient(clientId: string): Promise<ClientInfo | null>;
}

/**
 * `offline_access` scope が認可リクエストで許可されるかを判定するコールバック。
 *
 * OIDC Core 1.0 §11: `offline_access` を要求する場合、`prompt=consent` を含めること、
 * もしくは「他の条件」で offline access を許可することを必須とする。条件を満たさない
 * 場合 OP は `offline_access` 要求を MUST 無視する。
 *
 * このコールバックを差し替えることで、独自の consent 取得済み判定など
 * `prompt=consent` 以外の許可条件を後から差し込める。
 *
 * @returns `true` なら付与 scope に `offline_access` を残す。`false` なら除外する。
 */
export type OfflineAccessGrantedCallback = (
  request: AuthorizationRequestParams,
  context: { promptValues: string[] },
) => boolean | Promise<boolean>;

/**
 * `offline_access` の既定許可ロジック。
 * OIDC Core 1.0 §11 が明示する `prompt=consent` のみを許可条件とする安全側の実装。
 */
export const defaultIsOfflineAccessGranted: OfflineAccessGrantedCallback = (
  _request,
  { promptValues },
) => promptValues.includes('consent');

/**
 * validateAuthorizationRequest のオプション
 */
export interface ValidateAuthorizationRequestOptions {
  /**
   * `offline_access` を許可するかの判定。未指定なら `defaultIsOfflineAccessGranted`
   * （= `prompt=consent` を必須とする）が使われる。
   */
  isOfflineAccessGranted?: OfflineAccessGrantedCallback;
  /**
   * `claims` リクエストパラメータ（OIDC Core 1.0 §5.5）を `JSON.parse` する前に
   * 課す最大長（文字数）。未指定なら `DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH`。
   *
   * 認可エンドポイントは未認証・公開であり、巨大／深ネストの `claims` をパースさせる
   * ことで CPU・メモリを枯渇させるアプリ層 DoS の余地がある。エッジ環境（Cloudflare
   * Workers 等）では 1 リクエストの CPU/メモリ制限が厳しいため、最も制約の厳しい実行
   * 環境を基準に安全側へ倒す。OWASP API4:2023 / RFC 9700 §2.5。
   */
  maxClaimsParameterLength?: number;
  /**
   * OpenID Foundation Basic OP conformance compatibility.
   *
   * OAuth 2.1 requires PKCE for authorization code flow. OIDC Basic OP static-client
   * tests still exercise confidential-client authorization code flow without PKCE.
   * Keep this false unless running that compatibility target.
   */
  allowNonPkceAuthorizationCodeFlow?: boolean;
  /**
   * OIDC Core 1.0 §6.1: signed Request Object (`request` parameter) handling.
   */
  requestObject?: {
    /**
     * `request` パラメータ（Request Object by value）を OP としてサポートするか（機能トグル）。
     * 既定は true（従来挙動）。false の場合、`request` パラメータを含むリクエストは
     * Request Object をパースせず OIDC Core 1.0 §6.3 の `request_not_supported` で拒否する。
     * false にする構成では discovery の `request_parameter_supported` も false を広告すること。
     */
    supported?: boolean;
    /**
     * 受理する JWS 署名アルゴリズム。未指定なら {@link DEFAULT_REQUEST_OBJECT_SIGNING_ALGS}（`["RS256"]`）。
     */
    supportedSigningAlgs?: string[];
    /**
     * 署名無し（`alg: "none"`）Request Object を互換受理するか。
     *
     * OIDF Conformance Suite の一部 module は unsigned Request Object を送るため、
     * Basic OP conformance 互換の場合のみ true にする。既定は false（署名必須）。
     */
    allowUnsigned?: boolean;
  };
}

/**
 * `claims` リクエストパラメータ（OIDC Core 1.0 §5.5）を `JSON.parse` する前に課す
 * デフォルトの最大長（文字数）。
 *
 * OIDC Core §5.5 は構文（JSON シリアライズ）を規定するが**サイズ上限は規定しない**ため、
 * 実装が安全側に決めてよい。正規の `claims` は通常数百バイト〜1KB 程度で、数 KB を
 * 超える正規利用は稀。十分な余裕（16 KiB）を持たせつつ未認証 DoS 面を抑える値とする。
 */
export const DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH = 16384;

/**
 * バリデーション済みの認可リクエスト
 */
export interface ValidatedAuthorizationRequest {
  responseType: 'code';
  clientId: string;
  redirectUri: string;
  /**
   * 認可リクエストで `redirect_uri` パラメータが明示的に送られていたか。
   * OIDC Core 1.0 Section 3.1.3.2: 明示されていた場合 Token Endpoint でも MUST 一致。
   * 認可サーバ側で1つだけ登録されていて省略された場合は false（Token 側で必須化しない）。
   */
  redirectUriExplicit: boolean;
  scope: string[];
  // OAuth 2.1 PKCE (required by default; absent only in explicit compatibility mode)
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  state?: string;
  nonce?: string;
  prompt?: string[];
  display?: string;
  maxAge?: number;
  uiLocales?: string;
  claimsLocales?: string;
  acrValues?: string;
  loginHint?: string;
  idTokenHint?: string;
  audience?: string[];
  /**
   * OIDC Core 1.0 §5.5: parsed `claims` request parameter. `userinfo` / `id_token`
   * top-level members are preserved; other keys are dropped to keep the surface narrow.
   */
  claims?: ClaimsParameter;
}

/**
 * 認可エンドポイントのエラー
 *
 * redirectable が true の場合、クライアントの redirect_uri にエラーを返す。
 * redirectable が false の場合、ユーザーエージェントにエラーを直接表示する。
 */
export class AuthorizationError extends Error {
  public readonly error: AuthorizationErrorCode;
  public readonly errorDescription: string;
  public readonly redirectUri?: string;
  public readonly state?: string;

  constructor(
    error: AuthorizationErrorCode,
    errorDescription: string,
    redirectUri?: string,
    state?: string
  ) {
    // RFC 6749 Section 5.2: error_description must be limited to a safe character
    // set so user-controlled fragments (e.g. "Invalid prompt value: ${value}") cannot
    // smuggle quotes/control bytes into the JSON body or WWW-Authenticate header.
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'AuthorizationError';
    this.error = error;
    this.errorDescription = sanitized;
    this.redirectUri = redirectUri;
    this.state = state;
  }

  get redirectable(): boolean {
    return this.redirectUri !== undefined;
  }
}

const VALID_PROMPT_VALUES = ['none', 'login', 'consent', 'select_account'] as const;

// OIDC Core 1.0 §3.1.2.1: `display` is OPTIONAL and constrained to these values.
const VALID_DISPLAY_VALUES = ['page', 'popup', 'touch', 'wap'] as const;

const VALID_CODE_CHALLENGE_METHODS = ['S256'] as const;

// RFC 7636 Section 4.2: For S256, code_challenge = BASE64URL-ENCODE(SHA256(...)).
// SHA-256 produces 32 bytes whose base64url-no-padding encoding is always 43 characters.
const CODE_CHALLENGE_S256_LENGTH = 43;
// base64url alphabet (no padding): [A-Za-z0-9\-_]
const CODE_CHALLENGE_S256_PATTERN = /^[A-Za-z0-9\-_]+$/;

/**
 * redirect_uri をクライアントの登録済みURIと照合する
 * RFC 3986 Section 6.2.1 の Simple String Comparison を使用
 *
 * OAuth 2.1 Section 10.3.3: ループバックアドレスのポート差異許容は public client (native) のみ。
 * confidential client は厳格一致を要求する。clientType 未指定時も厳格一致 (安全側)。
 */
function matchRedirectUri(
  requestUri: string,
  registeredUris: string[],
  clientType?: 'confidential' | 'public'
): boolean {
  // まず完全一致を試みる
  if (registeredUris.includes(requestUri)) {
    return true;
  }

  // ループバックポート許容は public client 限定
  if (clientType !== 'public') {
    return false;
  }

  // ループバックアドレスの場合、ポート番号の違いを許容
  try {
    const requestUrl = new URL(requestUri);
    if (isLoopbackHostname(requestUrl.hostname)) {
      return registeredUris.some((registeredUri) => {
        try {
          const registeredUrl = new URL(registeredUri);
          return (
            isLoopbackHostname(registeredUrl.hostname) &&
            requestUrl.protocol === registeredUrl.protocol &&
            requestUrl.hostname === registeredUrl.hostname &&
            requestUrl.pathname === registeredUrl.pathname &&
            requestUrl.search === registeredUrl.search
          );
        } catch {
          return false;
        }
      });
    }
  } catch {
    // URL解析に失敗した場合は不一致
  }

  return false;
}

/**
 * XSS / RCE の起点になり得る危険スキーム。
 * OAuth 2.0 Security BCP / RFC 8252 Section 8.5 により AS 側で拒否すべき。
 * 比較は ASCII 小文字化したスキーム（末尾コロン込み）で行う。
 */
const DANGEROUS_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
]);

/**
 * 登録済み redirect_uri の妥当性を検査する
 * - OIDC Core 1.0 Section 3.1.2.1: redirect_uri MUST NOT include a fragment component
 * - OAuth 2.0 Security BCP / RFC 8252 Section 8.5: 危険スキームを拒否する
 * - OIDC Core 1.0 Section 3.1.2.1 / RFC 8252 Section 8.4: 非ループバックの平文 http:// を拒否する
 * 設定ミス（fatal で redirectable ではない）を早期に検知する目的で、
 * ClientResolver が返した URIs を検査する。
 */
export function validateRegisteredRedirectUris(registeredUris: string[]): void {
  for (const uri of registeredUris) {
    if (uri.includes('#')) {
      throw new AuthorizationError(
        AuthorizationErrorCode.ServerError,
        `Registered redirect_uri must not contain fragment: ${uri}`
      );
    }

    // スキーム抽出（先頭から最初の ':' まで、ASCII 小文字化）
    const colonIndex = uri.indexOf(':');
    if (colonIndex === -1) {
      throw new AuthorizationError(
        AuthorizationErrorCode.ServerError,
        `Registered redirect_uri must include a scheme: ${uri}`
      );
    }
    const scheme = uri.slice(0, colonIndex + 1).toLowerCase();

    if (DANGEROUS_SCHEMES.has(scheme)) {
      throw new AuthorizationError(
        AuthorizationErrorCode.ServerError,
        `Registered redirect_uri uses a dangerous scheme: ${scheme} (${uri})`
      );
    }

    // http:// はループバック（localhost / 127.0.0.0/8 / [::1]）以外を拒否する
    if (scheme === 'http:') {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        throw new AuthorizationError(
          AuthorizationErrorCode.ServerError,
          `Registered redirect_uri is not a valid URL: ${uri}`
        );
      }
      if (!isLoopbackHostname(parsed.hostname)) {
        throw new AuthorizationError(
          AuthorizationErrorCode.ServerError,
          `Registered redirect_uri must use https:// or loopback http:// — got ${uri}`
        );
      }
    }
  }
}

/**
 * redirect_uri を解決する
 * - リクエストに redirect_uri がある場合: 登録済みURIと照合
 * - リクエストに redirect_uri がない場合: 登録済みURIが1つなら使用、複数ならエラー
 */
function resolveRedirectUri(
  requestRedirectUri: string | undefined,
  registeredUris: string[],
  clientType?: 'confidential' | 'public'
): string {
  if (requestRedirectUri !== undefined) {
    // フラグメントを含む redirect_uri を拒否
    if (requestRedirectUri.includes('#')) {
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequest,
        'redirect_uri must not contain fragment'
      );
    }

    // 登録済みURIとの照合
    if (!matchRedirectUri(requestRedirectUri, registeredUris, clientType)) {
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequest,
        'redirect_uri not registered'
      );
    }

    return requestRedirectUri;
  }

  // redirect_uri が省略された場合
  if (registeredUris.length === 1) {
    return registeredUris[0] as string;
  }

  // 複数の登録済みURIがある場合は redirect_uri が必須
  throw new AuthorizationError(
    AuthorizationErrorCode.InvalidRequest,
    'redirect_uri is required when multiple redirect URIs are registered'
  );
}

/**
 * redirect_uri を解決する（機能単位のステップ関数）。
 * - リクエストに redirect_uri がある場合: 登録済みURIと照合（RFC 3986 §6.2.1 の
 *   Simple String Comparison。public client のみループバックのポート差異を許容）
 * - リクエストに redirect_uri がない場合: 登録済みURIが1つならそれを使用、複数ならエラー
 *
 * このステップより前のエラーはリダイレクト先を信頼できないため非リダイレクトで投げる。
 * このステップで確定した redirectUri を、以降のステップにエラーリダイレクト先として渡す。
 */
export function resolveAuthorizationRedirectUri(
  effectiveParams: AuthorizationRequestParams,
  client: ClientInfo,
): string {
  return resolveRedirectUri(
    effectiveParams.redirect_uri,
    client.redirectUris,
    client.clientType,
  );
}

/**
 * prompt パラメータをバリデーションする（機能単位のステップ関数）
 * OIDC Core 1.0 Section 3.1.2.1
 *
 * `prompt` が無い場合は undefined を返す。値がある場合は空白区切りで分割し、
 * none/login/consent/select_account 以外の値、および none と他値の併用を
 * リダイレクト可能な invalid_request として拒否する。
 */
export function validatePromptParameter(
  effectiveParams: AuthorizationRequestParams,
  redirectUri: string,
  state?: string
): string[] | undefined {
  if (effectiveParams.prompt === undefined) {
    return undefined;
  }
  return validatePrompt(effectiveParams.prompt, redirectUri, state);
}

/**
 * prompt パラメータをバリデーションする
 * OIDC Core 1.0 Section 3.1.2.1
 */
function validatePrompt(
  promptValue: string,
  redirectUri: string,
  state?: string
): string[] {
  const values = promptValue.split(' ').filter((v) => v.length > 0);

  // 各値が有効かチェック
  for (const value of values) {
    if (!(VALID_PROMPT_VALUES as readonly string[]).includes(value)) {
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequest,
        `Invalid prompt value: ${value}`,
        redirectUri,
        state
      );
    }
  }

  // none は他の値と組み合わせ不可
  if (values.includes('none') && values.length > 1) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'prompt value "none" must not be combined with other values',
      redirectUri,
      state
    );
  }

  return values;
}

/**
 * max_age パラメータをバリデーションする
 */
function validateMaxAge(
  maxAgeValue: string,
  redirectUri: string,
  state?: string
): number {
  const num = Number(maxAgeValue);

  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'max_age must be a non-negative integer',
      redirectUri,
      state
    );
  }

  return num;
}

/**
 * クライアント登録の default_max_age をバリデーションする。
 *
 * OIDC Dynamic Client Registration 1.0 §2: default_max_age は秒数を表す
 * 非負整数でなければならない。値はリクエストではなく登録メタデータ由来のため、
 * 不正値は設定ミス（サーバ側エラー）として扱い、リダイレクトせず server_error を投げる。
 */
function validateDefaultMaxAge(defaultMaxAge: number): number {
  if (
    !Number.isFinite(defaultMaxAge) ||
    !Number.isInteger(defaultMaxAge) ||
    defaultMaxAge < 0
  ) {
    throw new AuthorizationError(
      AuthorizationErrorCode.ServerError,
      'Registered default_max_age must be a non-negative integer'
    );
  }

  return defaultMaxAge;
}

/**
 * max_age / default_max_age を解決する（機能単位のステップ関数）。
 *
 * - リクエストに `max_age` があれば検証して採用する（OIDC Core 1.0 §3.1.2.1）。
 * - 無ければクライアント登録の `default_max_age` を検証して採用する
 *   （OIDC Dynamic Client Registration 1.0 §2）。
 * - どちらも無ければ undefined を返す（再認証鮮度の要求なし）。
 */
export function resolveMaxAge(
  effectiveParams: AuthorizationRequestParams,
  client: ClientInfo,
  redirectUri: string,
  state?: string
): number | undefined {
  if (effectiveParams.max_age !== undefined) {
    return validateMaxAge(effectiveParams.max_age, redirectUri, state);
  }
  if (client.defaultMaxAge !== undefined) {
    return validateDefaultMaxAge(client.defaultMaxAge);
  }
  return undefined;
}

/**
 * PKCE code_challenge / code_challenge_method をバリデーションする
 * OAuth 2.1 Section 4.1.1, 7.5
 */
function validateCodeChallenge(
  codeChallenge: string | undefined,
  codeChallengeMethod: string | undefined,
  redirectUri: string,
  state?: string
): { codeChallenge: string; codeChallengeMethod: 'S256' } {
  // OAuth 2.1: code_challenge は必須
  if (!codeChallenge) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'Missing required parameter: code_challenge',
      redirectUri,
      state
    );
  }

  // code_challenge_method は必須
  if (!codeChallengeMethod) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'Missing required parameter: code_challenge_method',
      redirectUri,
      state
    );
  }

  // S256 のみサポート（plain はセキュリティ上拒否）
  if (!(VALID_CODE_CHALLENGE_METHODS as readonly string[]).includes(codeChallengeMethod)) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      `Unsupported code_challenge_method: ${codeChallengeMethod}`,
      redirectUri,
      state
    );
  }

  // RFC 7636 Section 4.2: S256 code_challenge は 43 文字固定の base64url-no-padding 表現。
  // Token Endpoint の code_verifier 比較まで遅延させず、ここで形式違反を検出する。
  if (codeChallenge.length !== CODE_CHALLENGE_S256_LENGTH) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      `code_challenge must be a ${CODE_CHALLENGE_S256_LENGTH}-character base64url-encoded SHA-256 hash for S256`,
      redirectUri,
      state
    );
  }
  if (!CODE_CHALLENGE_S256_PATTERN.test(codeChallenge)) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'code_challenge contains invalid characters (must be base64url: [A-Za-z0-9-_], 43 chars)',
      redirectUri,
      state
    );
  }

  return {
    codeChallenge,
    codeChallengeMethod: codeChallengeMethod as 'S256',
  };
}

/**
 * PKCE の code_challenge / code_challenge_method をバリデーションする
 * （機能単位のステップ関数）。OAuth 2.1 Section 4.1.1, 7.5。
 *
 * OAuth 2.1 では PKCE（S256）は必須。`allowNonPkceAuthorizationCodeFlow` が
 * true かつ confidential client が PKCE を完全に省略した場合のみ、
 * OIDF Basic OP static-client conformance 互換として省略を許容し空を返す。
 */
export function validateAuthorizationCodePkce(
  effectiveParams: AuthorizationRequestParams,
  client: ClientInfo,
  redirectUri: string,
  state?: string,
  options: { allowNonPkceAuthorizationCodeFlow?: boolean } = {},
): { codeChallenge?: string; codeChallengeMethod?: 'S256' } {
  const codeChallenge = effectiveParams.code_challenge;
  const codeChallengeMethod = effectiveParams.code_challenge_method;
  const pkceOmitted =
    codeChallenge === undefined && codeChallengeMethod === undefined;
  if (
    pkceOmitted &&
    options.allowNonPkceAuthorizationCodeFlow === true &&
    client.clientType === 'confidential'
  ) {
    return {};
  }

  return validateCodeChallenge(
    codeChallenge,
    codeChallengeMethod,
    redirectUri,
    state,
  );
}

/**
 * client_id の存在検証・ClientResolver からの解決・clientId 整合性検証を行う
 * （機能単位のステップ関数）。
 * いずれもリダイレクト先が確定する前の検証であり、非リダイレクトエラーとして投げる。
 */
export async function resolveClientForAuthorization(
  params: AuthorizationRequestParams,
  clientResolver: ClientResolver,
): Promise<ClientInfo> {
  const clientId = params.client_id;
  if (!clientId) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'Missing required parameter: client_id'
    );
  }

  const client = await clientResolver.findClient(clientId);
  if (!client) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'Unknown client_id'
    );
  }

  // ClientResolver の実装が正しく clientId を返しているか実行時に検証
  // これにより、異なるクライアントのデータが混在するバグを検出する
  if (client.clientId !== clientId) {
    throw new AuthorizationError(
      AuthorizationErrorCode.ServerError,
      `ClientResolver returned mismatched clientId: expected "${clientId}", got "${client.clientId}". ` +
        'Ensure findClient returns data for the queried client_id. ' +
        'clientId mismatch detected.'
    );
  }

  return client;
}

/**
 * {@link resolveRequestObjectParams} の戻り値。
 */
export interface ResolvedRequestObjectParams {
  /**
   * クエリ値に Request Object の claim を上書きした有効パラメータ集合。
   * `request` パラメータが無い場合はクエリパラメータのコピーそのもの。
   * 以降の検証ステップはこの値を入力とする。
   */
  effectiveParams: AuthorizationRequestParams;
  /**
   * 検証済み Request Object の claim。`request` パラメータが無い場合は undefined。
   * {@link validateRequestObjectConsistency} に渡して response_type / client_id の
   * 一致検証に使う。
   */
  requestObjectClaims?: Record<string, unknown>;
}

/**
 * Request Object by value（OIDC Core 1.0 §6.1）を解決する（機能単位のステップ関数）。
 *
 * `request` パラメータが無い場合はクエリパラメータのコピーをそのまま返す。
 * ある場合は署名付き JWS Request Object をクライアント登録鍵（`ClientInfo.jwks`）で
 * 検証し、claim をクエリ値に supersede した有効パラメータ集合を返す。検証失敗
 * （壊れた JWT / 未対応 alg / 鍵不一致 / 署名不一致）は信頼できないため、
 * 内部の redirect_uri も信用せず非リダイレクトの invalid_request とする。
 *
 * `response_type` / `client_id` は OAuth 2.0 request syntax 側を正とするため
 * 上書きしない（後段の {@link validateRequestObjectConsistency} で一致検証する）。
 */
export async function resolveRequestObjectParams(
  params: AuthorizationRequestParams,
  client: ClientInfo,
  options: {
    /**
     * 受理する JWS 署名アルゴリズム。
     * 未指定なら {@link DEFAULT_REQUEST_OBJECT_SIGNING_ALGS}（`["RS256"]`）。
     */
    supportedSigningAlgs?: string[];
    /**
     * 署名無し（`alg: "none"`）Request Object を互換受理するか。既定 false（署名必須）。
     * OIDF Conformance Suite 互換の場合のみ true にする。
     */
    allowUnsigned?: boolean;
  } = {},
): Promise<ResolvedRequestObjectParams> {
  if (params.request === undefined) {
    return { effectiveParams: { ...params } };
  }

  let requestObjectClaims: Record<string, unknown>;
  try {
    requestObjectClaims = await parseRequestObject(params.request, {
      jwks: client.jwks,
      supportedSigningAlgs:
        options.supportedSigningAlgs ?? [
          ...DEFAULT_REQUEST_OBJECT_SIGNING_ALGS,
        ],
      allowUnsigned: options.allowUnsigned ?? false,
    });
  } catch (e) {
    if (e instanceof RequestObjectError) {
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequest,
        e.message,
      );
    }
    throw e;
  }

  return {
    effectiveParams: mergeRequestObjectParams(params, requestObjectClaims),
    requestObjectClaims,
  };
}

/**
 * 未サポートのリクエストパラメータを拒否する（機能単位のステップ関数）。
 *
 * - `request_uri`（OIDC Core 1.0 §6.2 / §6.3）: 未対応のため request_uri_not_supported
 * - `registration`（§3.1.2.1 / §7.2.1）: 未対応のため registration_not_supported（§3.1.2.6）
 * - `request`（§6.1 / §6.3）: `requestParameterSupported: false` の構成でのみ
 *   request_not_supported で拒否する（既定はサポート扱いで拒否しない）
 *
 * いずれも redirect 先確定後のリダイレクト可能エラーとして投げる。
 */
export function rejectUnsupportedRequestParams(
  params: AuthorizationRequestParams,
  redirectUri: string,
  state?: string,
  options: { requestParameterSupported?: boolean } = {},
): void {
  if (
    params.request !== undefined &&
    options.requestParameterSupported === false
  ) {
    throw new AuthorizationError(
      AuthorizationErrorCode.RequestNotSupported,
      'request parameter (Request Object) is not supported',
      redirectUri,
      state,
    );
  }

  if (params.request_uri !== undefined) {
    throw new AuthorizationError(
      AuthorizationErrorCode.RequestUriNotSupported,
      'request_uri parameter (Request Object by reference) is not supported',
      redirectUri,
      state,
    );
  }

  if (params.registration !== undefined) {
    throw new AuthorizationError(
      AuthorizationErrorCode.RegistrationNotSupported,
      'registration parameter is not supported',
      redirectUri,
      state,
    );
  }
}

/**
 * Request Object とクエリパラメータの整合性を検証する（機能単位のステップ関数）。
 *
 * OIDC Core 1.0 §6.1: "values for the response_type and client_id parameters MUST
 * be included using the OAuth 2.0 request syntax"。Request Object 内にも含まれる
 * 場合は値が一致しなければ invalid_request で拒否する（その他のパラメータは
 * supersede 規則に従い Request Object 側を有効値として採用する）。
 * requestObjectClaims が undefined（`request` パラメータ無し）の場合は何もしない。
 */
export function validateRequestObjectConsistency(
  params: AuthorizationRequestParams,
  requestObjectClaims: Record<string, unknown> | undefined,
  redirectUri: string,
  state?: string,
): void {
  if (requestObjectClaims === undefined) {
    return;
  }

  const roResponseType =
    typeof requestObjectClaims['response_type'] === 'string'
      ? (requestObjectClaims['response_type'] as string)
      : undefined;
  if (roResponseType !== undefined && roResponseType !== params.response_type) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'request object response_type does not match the request',
      redirectUri,
      state,
    );
  }

  const roClientId =
    typeof requestObjectClaims['client_id'] === 'string'
      ? (requestObjectClaims['client_id'] as string)
      : undefined;
  if (roClientId !== undefined && roClientId !== params.client_id) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'request object client_id does not match the request',
      redirectUri,
      state,
    );
  }
}

/**
 * response_type を検証する（機能単位のステップ関数）。
 *
 * - 欠落は invalid_request（OAuth 2.1 §4.1.2.1）
 * - `code` 以外は unsupported_response_type（OP 全体での未サポート）
 * - クライアント登録外の response_type は unauthorized_client（クライアント単位の認可。
 *   既定 `["code"]`: OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2）
 *
 * OIDC Core 1.0 §6.1: response_type は OAuth 2.0 request syntax 側を正とするため、
 * Request Object 適用前のクエリパラメータ（params）を渡すこと。
 */
export function validateResponseType(
  params: AuthorizationRequestParams,
  client: ClientInfo,
  redirectUri: string,
  state?: string,
): 'code' {
  const responseType = params.response_type;
  if (!responseType) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'Missing required parameter: response_type',
      redirectUri,
      state
    );
  }

  if (responseType !== 'code') {
    throw new AuthorizationError(
      AuthorizationErrorCode.UnsupportedResponseType,
      `Unsupported response_type: ${responseType}`,
      redirectUri,
      state
    );
  }

  // クライアント単位の response_type 認可
  // RFC 6749 §4.1.2.1 / OAuth 2.1 §4.1.2.1: "The client is not authorized to request
  // an authorization code using this method." → unauthorized_client。
  // OP 全体での未サポート（unsupported_response_type）とは区別する。
  const allowedResponseTypes = client.responseTypes ?? ['code'];
  if (!allowedResponseTypes.includes(responseType)) {
    throw new AuthorizationError(
      AuthorizationErrorCode.UnauthorizedClient,
      `Client is not authorized to use response_type: ${responseType}`,
      redirectUri,
      state
    );
  }

  return responseType;
}

/**
 * scope を検証する（機能単位のステップ関数）。
 *
 * - OIDC Core 1.0 §6.1: scope は Request Object があっても OAuth 2.0 request syntax
 *   （クエリ側 = queryParams）に必須。欠落は invalid_request。
 * - 有効値（effectiveParams。Request Object 不使用ならクエリと同じものを渡す）を
 *   空白区切りで分割・重複除去し、`openid` を含まなければ invalid_scope（§3.1.2.1）。
 */
export function validateAuthorizationScope(
  queryParams: AuthorizationRequestParams,
  effectiveParams: AuthorizationRequestParams,
  redirectUri: string,
  state?: string,
): string[] {
  const queryScopeValue = queryParams.scope;
  if (!queryScopeValue) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'Missing required parameter: scope',
      redirectUri,
      state
    );
  }

  const scopeValue = effectiveParams.scope ?? queryScopeValue;
  // RFC 6749 §3.3: scope は空白区切りの集合。Token Endpoint（refresh_token grant）は
  // `[...new Set(...)]` で重複除去しているため、Authorization Endpoint でも揃える。
  // dedup は権限を変えない（同一権限の二重表現を畳むだけ）の非破壊変換で、挿入順は保持する。
  const scope = [...new Set(scopeValue.split(' ').filter((s) => s.length > 0))];
  if (!scope.includes('openid')) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidScope,
      'scope must include openid',
      redirectUri,
      state
    );
  }

  return scope;
}

/**
 * offline_access の許可ポリシーを適用する（機能単位のステップ関数）。
 *
 * OIDC Core 1.0 §11: 許可条件を満たさない `offline_access` 要求は MUST 無視する
 * （scope から除外する）。既定条件は `prompt=consent`
 * （{@link defaultIsOfflineAccessGranted}）。isOfflineAccessGranted を差し替える
 * ことで独自の許可条件を差し込める。
 * scope に `offline_access` が無い場合は何もせずそのまま返す。引数は変更しない。
 */
export async function applyOfflineAccessPolicy(
  scope: string[],
  effectiveParams: AuthorizationRequestParams,
  promptValues: string[] | undefined,
  isOfflineAccessGranted: OfflineAccessGrantedCallback = defaultIsOfflineAccessGranted,
): Promise<string[]> {
  if (!scope.includes('offline_access')) {
    return scope;
  }

  const granted = await isOfflineAccessGranted(effectiveParams, {
    promptValues: promptValues ?? [],
  });
  if (granted) {
    return scope;
  }

  return scope.filter((s) => s !== 'offline_access');
}

/**
 * display パラメータを検証する（機能単位のステップ関数）。
 *
 * OIDC Core 1.0 §3.1.2.1: `display` は OPTIONAL だが page/popup/touch/wap の
 * いずれかでなければならない。未定義値は invalid_request（redirectable）とする。
 */
export function validateDisplayParameter(
  effectiveParams: AuthorizationRequestParams,
  redirectUri: string,
  state?: string,
): string | undefined {
  const display = effectiveParams.display;
  if (
    display !== undefined &&
    !(VALID_DISPLAY_VALUES as readonly string[]).includes(display)
  ) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      `Unsupported display value: ${display}`,
      redirectUri,
      state
    );
  }
  return display;
}

/**
 * audience パラメータをパースする（機能単位のステップ関数）。
 * スペース区切りの文字列を配列に変換する。無ければ undefined を返す。
 */
export function parseAudienceParameter(
  effectiveParams: AuthorizationRequestParams,
): string[] | undefined {
  const audienceValue = effectiveParams.audience;
  if (audienceValue === undefined) {
    return undefined;
  }
  return audienceValue.split(' ').filter((a) => a.length > 0);
}

/**
 * Authentication Request（認可リクエスト）のパラメータをバリデーションする
 *
 * 機能単位のステップ関数を順に呼び出す合成関数。カスタマイズや検証のために
 * ステップ単位で処理を消したり足したりしたい場合は、この関数と同じ順序で
 * 各ステップ関数を直接呼び出すこと（CLI 生成コードはその形で出力される）。
 *
 * バリデーション順序:
 * 1. {@link resolveClientForAuthorization}（不正な場合はリダイレクト不可エラー）
 * 2. {@link validateRegisteredRedirectUris}（設定ミスの早期検知）
 * 3. {@link resolveRequestObjectParams}（OIDC Core 1.0 §6.1）
 * 4. {@link resolveAuthorizationRedirectUri}（不正な場合はリダイレクト不可エラー）
 * 5. {@link rejectUnsupportedRequestParams} / {@link validateRequestObjectConsistency}
 * 6. {@link validateResponseType} / {@link validateAuthorizationScope} /
 *    {@link validateAuthorizationCodePkce} / {@link validatePromptParameter} /
 *    {@link applyOfflineAccessPolicy} / {@link validateDisplayParameter} /
 *    {@link resolveMaxAge} / {@link parseAudienceParameter} /
 *    {@link parseClaimsRequestParameter}（不正な場合はリダイレクト可能エラー）
 *
 * @param params 認可リクエストのパラメータ
 * @param clientResolver クライアント情報を解決するインターフェース（外部から注入）
 * @returns バリデーション済みの認可リクエスト
 * @throws {AuthorizationError} バリデーションエラー
 */
export async function validateAuthorizationRequest(
  params: AuthorizationRequestParams,
  clientResolver: ClientResolver,
  options: ValidateAuthorizationRequestOptions = {}
): Promise<ValidatedAuthorizationRequest> {
  // --- Phase 1: client_id の検証（非リダイレクトエラー） ---
  const client = await resolveClientForAuthorization(params, clientResolver);

  // --- Phase 2: redirect_uri の検証（非リダイレクトエラー） ---
  // 登録済み URIs にフラグメントが含まれていないことを検証（設定ミスの早期検知）
  validateRegisteredRedirectUris(client.redirectUris);

  // --- Request Object by value (OIDC Core 1.0 §6.1) ---
  // 機能トグル（requestObject.supported = false）の場合はパースせず、redirect 先の
  // 解決後に rejectUnsupportedRequestParams が request_not_supported で拒否する（§6.3）。
  const requestParameterSupported = options.requestObject?.supported ?? true;
  const { effectiveParams: effective, requestObjectClaims } =
    requestParameterSupported
      ? await resolveRequestObjectParams(params, client, {
          supportedSigningAlgs: options.requestObject?.supportedSigningAlgs,
          allowUnsigned: options.requestObject?.allowUnsigned,
        })
      : { effectiveParams: { ...params }, requestObjectClaims: undefined };

  // 認可リクエストの redirect_uri 解決は Request Object 由来の値を優先する。
  // これにより top-level の redirect_uri が無効でも Request Object 内の有効な
  // redirect_uri を使って処理を継続できる（oidcc-ensure-request-object-with-redirect-uri）。
  const redirectUri = resolveAuthorizationRedirectUri(effective, client);

  // --- Phase 3 以降はリダイレクト可能エラー ---
  // RFC 6749 §4.1.2.1 / OIDC Core §3.1.2.6: `state` は redirect 先が確定した後の
  // リダイレクト可能エラー（invalid_scope / unsupported_response_type 等）でのみ
  // クライアントへ echo する。client_id 欠落・不明・不一致 / redirect_uri 不正 /
  // Request Object パース失敗のような非リダイレクトエラーは redirect 先を信頼できない
  // ため、ここより前で `state` を渡さずに throw し、`state` を echo しない。
  const state = effective.state;

  // OIDC Core 1.0 §6.3: 未サポートの request（機能トグル無効時）/ request_uri / registration
  rejectUnsupportedRequestParams(params, redirectUri, state, {
    requestParameterSupported,
  });

  // OIDC Core 1.0 §6.1: Request Object 内の response_type / client_id はクエリと一致必須
  validateRequestObjectConsistency(params, requestObjectClaims, redirectUri, state);

  // response_type の検証（OP 全体・クライアント単位）
  const responseType = validateResponseType(params, client, redirectUri, state);

  // scope の検証（§6.1: クエリ側に必須。Request Object 側の値が supersede する）
  let scope = validateAuthorizationScope(params, effective, redirectUri, state);

  // PKCE の検証 (OAuth 2.1: REQUIRED by default).
  // OIDC Basic OP static-client conformance still includes non-PKCE code flow;
  // allow it only for explicit confidential clients when compatibility mode is enabled.
  const pkce = validateAuthorizationCodePkce(effective, client, redirectUri, state, {
    allowNonPkceAuthorizationCodeFlow: options.allowNonPkceAuthorizationCodeFlow,
  });

  // prompt の検証
  const prompt = validatePromptParameter(effective, redirectUri, state);

  // OIDC Core 1.0 §11: `offline_access` の許可条件を満たさない場合は scope から除外する。
  // 既定では `prompt=consent` が必須。利用者は isOfflineAccessGranted で代替条件を差し込める。
  scope = await applyOfflineAccessPolicy(
    scope,
    effective,
    prompt,
    options.isOfflineAccessGranted,
  );

  // display の検証
  const display = validateDisplayParameter(effective, redirectUri, state);

  // max_age / default_max_age の解決
  const maxAge = resolveMaxAge(effective, client, redirectUri, state);

  // audience パラメータ（スペース区切りの文字列を配列に変換）
  const audience = parseAudienceParameter(effective);

  // OIDC Core 1.0 §5.5: parse the claims request parameter (JSON-encoded).
  // Only the `userinfo` and `id_token` top-level members are recognized;
  // unknown members are silently ignored per spec guidance.
  const claims = parseClaimsRequestParameter(
    effective,
    redirectUri,
    state,
    options.maxClaimsParameterLength,
  );

  return {
    responseType,
    clientId: client.clientId,
    redirectUri,
    redirectUriExplicit: effective.redirect_uri !== undefined,
    scope,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    state,
    nonce: effective.nonce,
    prompt,
    display,
    maxAge,
    uiLocales: effective.ui_locales,
    claimsLocales: effective.claims_locales,
    acrValues: effective.acr_values,
    loginHint: effective.login_hint,
    idTokenHint: effective.id_token_hint,
    audience,
    claims,
  };
}

/**
 * OIDC Core 1.0 §6.1: Request Object 内の claim を Authorization Request パラメータへ
 * 展開（supersede）した**新しいパラメータ集合を返す純粋関数**。引数は変更しない。
 * クエリ値（`params`）に Request Object 値（`roClaims`）を上書きした結果を返すため、
 * 呼び出し側は `const effective = mergeRequestObjectParams(params, roClaims)` の形で
 * 「Request Object の値が以降の処理に使われる」ことを代入式として読める。
 *
 * `response_type` / `client_id` は OAuth 2.0 request syntax 側を正とするため override
 * しない（呼び出し側で一致検証のみ行う）。`request` / `request_uri` は Request Object 内に
 * 含めてはならず、含まれていても無視する。
 *
 * Request Object の claim 値は JSON 値（文字列・数値・オブジェクト）になり得るため、
 * クエリ文字列由来の `AuthorizationRequestParams`（すべて文字列）に正規化する。
 * `claims`（§5.5）は Request Object 内では JSON オブジェクトで渡されるため、既存の
 * `parseClaimsRequest` が扱えるよう JSON 文字列へ再シリアライズする。
 */
const REQUEST_OBJECT_OVERRIDE_KEYS = [
  'redirect_uri',
  'scope',
  'state',
  'nonce',
  'prompt',
  'display',
  'max_age',
  'ui_locales',
  'claims_locales',
  'acr_values',
  'login_hint',
  'id_token_hint',
  'audience',
  'code_challenge',
  'code_challenge_method',
] as const;

function mergeRequestObjectParams(
  params: AuthorizationRequestParams,
  roClaims: Record<string, unknown>,
): AuthorizationRequestParams {
  const overrides: Record<string, string> = {};
  for (const key of REQUEST_OBJECT_OVERRIDE_KEYS) {
    const value = roClaims[key];
    if (value === undefined) continue;
    if (typeof value === 'string') {
      overrides[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      overrides[key] = String(value);
    }
    // Arrays / nested objects are not valid for these scalar parameters; ignore.
  }

  // OIDC Core 1.0 §5.5: inside a Request Object, `claims` is a JSON object (not a
  // JSON-encoded string). Re-serialize so parseClaimsRequest can consume it.
  const claimsValue = roClaims['claims'];
  if (typeof claimsValue === 'string') {
    overrides['claims'] = claimsValue;
  } else if (
    typeof claimsValue === 'object' &&
    claimsValue !== null &&
    !Array.isArray(claimsValue)
  ) {
    overrides['claims'] = JSON.stringify(claimsValue);
  }

  // Query params (all strings) overlaid with the request object overrides; the
  // original inputs are left untouched.
  return { ...params, ...overrides };
}

/**
 * `claims` リクエストパラメータをパースする（機能単位のステップ関数）。
 * OIDC Core 1.0 §5.5: JSON 文字列で渡される。`userinfo` / `id_token` のみ採用し、
 * 値が `null` または `{ essential?, value?, values? }` 形式以外のメンバーは無視する。
 * `claims` が無ければ undefined を返す。
 *
 * maxLength は `JSON.parse` の前に課す最大長（未認証 DoS 対策）。
 * 未指定なら {@link DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH}。
 */
export function parseClaimsRequestParameter(
  effectiveParams: AuthorizationRequestParams,
  redirectUri: string,
  state?: string,
  maxLength: number = DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH,
): ClaimsParameter | undefined {
  const raw = effectiveParams.claims;
  if (raw === undefined) return undefined;

  // 信頼できない入力のサイズ上限を JSON.parse の「前」に課す。
  // 認可エンドポイントは未認証・公開で、巨大／深ネストの claims をパースさせると
  // CPU・メモリを枯渇させられる（アプリ層 DoS）。OWASP API4:2023 / RFC 9700 §2.5。
  // 巨大入力をエラー文言にエコーしない（sanitizeErrorDescription 経路と整合）。
  if (raw.length > maxLength) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'claims parameter exceeds the maximum allowed length',
      redirectUri,
      state,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'claims parameter must be a JSON object',
      redirectUri,
      state,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'claims parameter must be a JSON object',
      redirectUri,
      state,
    );
  }

  const result: ClaimsParameter = {};
  const obj = parsed as Record<string, unknown>;
  const userinfo = sanitizeClaimsMember(obj['userinfo']);
  if (userinfo) result.userinfo = userinfo;
  const idToken = sanitizeClaimsMember(obj['id_token']);
  if (idToken) result.id_token = idToken;
  return result;
}

function sanitizeClaimsMember(
  value: unknown,
): Record<string, ClaimRequestValue> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, ClaimRequestValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null) {
      result[key] = null;
    } else if (typeof entry === 'object' && !Array.isArray(entry)) {
      result[key] = entry as ClaimRequestValue;
    }
    // Other shapes (strings, numbers, arrays) are silently dropped.
  }
  return result;
}
