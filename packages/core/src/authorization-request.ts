/**
 * Authentication Request（認可リクエスト）のバリデーション
 * OIDC Core 1.0 Section 3.1.2 / OAuth 2.1 に準拠
 */
import { parseAcrValues } from './acr.js';
import { clientAllowsRefreshTokenGrant } from './client-grant-types.js';
import { sanitizeErrorDescription } from './error-utils.js';
import { isLoopbackHostname } from './loopback.js';
import { parseRequestObject, RequestObjectError } from './request-object.js';
import {
  normalizeResponseType,
  responseTypeIncludes,
  type AuthorizationResponseType,
} from './response-type.js';
import { findUnregisteredClientScopes, parseScope } from './scope.js';
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
  // OIDC Core 1.0 Section 6.3: returned when the request_uri is unreachable or
  // yields invalid data, or the request parameter carries an invalid Request Object.
  InvalidRequestUri = 'invalid_request_uri',
  InvalidRequestObject = 'invalid_request_object',
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
   * verified against the keys the client registered for the request_object
   * purpose (passed to resolveRequestObjectParams) and its claims supersede the
   * OAuth query parameters. Discovery advertises `request_parameter_supported: true`.
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
   * OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: 省略時の既定は `["code"]`。
   * 登録外の response_type は OAuth 2.1 §4.1.2.1 の `unauthorized_client` で拒否される。
   * Implicit Flow（OIDC Core 1.0 §3.2）を使わせるクライアントには `id_token` /
   * `id_token token` を登録する。値の順序は問わない（`token id_token` でもよい）。
   */
  responseTypes?: string[];
  /**
   * このクライアントが Token Endpoint で使用してよい grant_type の一覧。
   * OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: 既定は `["authorization_code"]`。
   * 認可エンドポイントはこれを `offline_access` の付与判定に使う（OIDC Core 1.0 §11 の
   * ユーザー同意条件とは独立した、クライアント登録上の権限という軸）。
   * {@link TokenClientInfo.grantTypes} と同じ値であり、生成コードのように 1 つの
   * クライアントレコードを両エンドポイントで共有する場合は 1 箇所に書けばよい。
   */
  grantTypes?: string[];
  /**
   * このクライアントが要求してよい scope の一覧（RFC 7591 §2 の `scope`）。
   * 登録すると、一覧に無い scope の要求は {@link validateClientScope} が `invalid_scope` で拒否する。
   * 省略時はクライアント単位の制限を掛けない。`openid` や `offline_access` も、要求させるなら一覧に含める。
   * {@link TokenClientInfo.scope} と同じ値。
   */
  scope?: string[];
  /**
   * クライアント登録メタデータ `default_max_age`（秒）。
   * OIDC Dynamic Client Registration 1.0 §2: リクエストに `max_age` が無い場合の
   * 既定の再認証鮮度として OP 側で適用する。`max_age` リクエストパラメータが
   * 来た場合はそちらが優先（上書き）される（Core 1.0 §3.1.2.1）。
   * 値は非負整数（秒）でなければならず、不正値は server_error として拒否される。
   * `default_max_age` は OPTIONAL なメタデータであり、未指定の場合はフォールバックを行わない。
   */
  defaultMaxAge?: number;
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
  /**
   * `clientId` の登録済みクライアントの情報を返す。
   *
   * 返す情報は、認可リクエストの検証に使うもの（`redirectUris`、要求してよいスコープなど）である。
   * 登録されていないクライアントなら `null` を返す。
   * 返す `ClientInfo.clientId` は、引数の `clientId` と一致する必要がある。
   */
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
  context: { promptValues: string[]; client: ClientInfo },
) => boolean | Promise<boolean>;

/**
 * `offline_access` の既定許可ロジック。
 *
 * 独立した 2 軸の AND を取る。
 *
 * 1. OIDC Core 1.0 §11 が明示する**エンドユーザーの同意**（`prompt=consent`）
 * 2. RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2 の**クライアント登録上の権限**
 *    （`grant_types` に `refresh_token` を含むこと。既定は `["authorization_code"]`）
 *
 * 2 を見ないと、`refresh_token` grant を登録していないクライアントへ Refresh Token を
 * 発行してしまう。その Refresh Token は `validateClientGrantType` が
 * `unauthorized_client` で拒否するため一度も使えず、クライアントに長期資格情報を
 * 保存させるだけになる（RFC 9700 §4.14）。しかも失敗するのは発行時ではなく
 * クライアントが実際に更新を試みた時点なので、設定ミスの発見が遅れる。
 */
export const defaultIsOfflineAccessGranted: OfflineAccessGrantedCallback = (
  _request,
  { promptValues, client },
) => promptValues.includes('consent') && clientAllowsRefreshTokenGrant(client);

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
  /**
   * 検証済みの response_type（{@link normalizeResponseType} の形）。`code` は
   * Authorization Code Flow、`id_token` / `id_token token` は Implicit Flow
   * （OIDC Core 1.0 §3.2）。
   */
  responseType: AuthorizationResponseType;
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
  /**
   * OIDC Core 1.0 §3.1.2.1: 要求された acr 値（優先順、空白区切り）。
   * {@link validateAcrValuesParameter} が構文を検証し、1 つの空白で連結し直した値。
   */
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

// OIDC Core 1.0 §3.1.2.1 does not define the characters of an acr value. Like
// scope, acr_values is a space-separated list, so each value follows the
// scope-token syntax of RFC 6749 §3.3: 1*( %x21 / %x23-5B / %x5D-7E ).
// Besides spaces, control and non-ASCII characters, that leaves out the double
// quote and the backslash: acr values are echoed in the acr claim and, per
// RFC 9470 §3, in the quoted-string of a WWW-Authenticate challenge.
const ACR_VALUE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

const VALID_CODE_CHALLENGE_METHODS = ['S256'] as const;

// RFC 7636 Section 4.2: For S256, code_challenge = BASE64URL-ENCODE(SHA256(...)).
// SHA-256 produces 32 bytes whose base64url-no-padding encoding is always 43 characters.
const CODE_CHALLENGE_S256_LENGTH = 43;
// base64url alphabet (no padding): [A-Za-z0-9\-_]
const CODE_CHALLENGE_S256_PATTERN = /^[A-Za-z0-9\-_]+$/;

/**
 * `redirect_uri` が登録済みなら true を返す。
 *
 * まず、登録済みの URI と文字列として完全に一致するかを比べる（RFC 3986 §6.2.1 の単純な文字列比較）。
 * 一致しなければ、パブリッククライアント（ネイティブアプリなど）に限り、ループバックアドレスの URI をポート番号の違いを無視して比べる。
 * このときは、どちらのホストもループバックアドレスで、スキーム、ホスト名、パス、クエリがすべて一致する必要がある。
 * コンフィデンシャルクライアントと、`clientType` を指定していないクライアントには、安全側に倒して完全一致だけを認める（OAuth 2.1 §10.3.3）。
 *
 * @spec RFC 3986 §6.2.1
 * @spec OAuth 2.1 §10.3.3
 */
function matchRedirectUri(
  requestUri: string,
  registeredUris: string[],
  clientType?: 'confidential' | 'public'
): boolean {
  // まず、登録済みの URI と完全に一致するかを比べる。
  if (registeredUris.includes(requestUri)) {
    return true;
  }

  // ループバックのポート番号の違いを許すのは、パブリッククライアントに限る。
  if (clientType !== 'public') {
    return false;
  }

  // ループバックアドレスなら、ポート番号の違いを無視して比べる。
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
    // URL として解析できなければ、一致しないとみなす。
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
 * 登録済みの `redirect_uri` が安全かを検査する。
 *
 * `ClientResolver` が返した URI を一つずつ検査し、次のどれかに当てはまると `server_error` の `AuthorizationError` を投げる:
 * - フラグメント（`#`）を含む。`redirect_uri` はフラグメントを含んではならない（OIDC Core 1.0 §3.1.2.1）。
 * - スキームがない。
 * - スキームが危険なもの（`javascript:`、`data:`、`file:`、`vbscript:`、`blob:`）である（OAuth 2.0 Security BCP、RFC 8252 §8.5）。
 * - スキームが `http:` で、URL として解析できないか、ホストがループバックアドレスでない（OIDC Core 1.0 §3.1.2.1、RFC 8252 §8.4）。
 *
 * 登録の設定ミスを早く見つけるための検査であり、エラーはリダイレクトで返さない。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec OAuth 2.0 Security BCP
 * @spec RFC 8252 §8.5
 * @spec RFC 8252 §8.4
 */
export function validateRegisteredRedirectUris(registeredUris: string[]): void {
  for (const uri of registeredUris) {
    if (uri.includes('#')) {
      throw new AuthorizationError(
        AuthorizationErrorCode.ServerError,
        `Registered redirect_uri must not contain fragment: ${uri}`
      );
    }

    // 先頭から最初の `:` までをスキームとして取り出し、小文字にする。
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

    // `http://` は、ホストがループバックアドレス（`localhost`、`127.0.0.0/8`、`[::1]`）でなければ拒否する。
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
 * 使う `redirect_uri` を決めて返す。
 *
 * リクエストに `redirect_uri` があれば、登録済みの URI と照合し、一致すればその値を返す。
 * リクエストにないときは、登録済みの URI が一つならそれを返す。
 * 次のときは、リダイレクトしない `invalid_request` の `AuthorizationError` を投げる:
 * - リクエストの `redirect_uri` がフラグメント（`#`）を含む。
 * - リクエストの `redirect_uri` が登録済みの URI のどれとも一致しない。
 * - リクエストに `redirect_uri` がなく、登録済みの URI が一つでない（ないか、複数ある）。
 */
export function resolveRedirectUri(
  requestRedirectUri: string | undefined,
  registeredUris: string[],
  clientType?: 'confidential' | 'public'
): string {
  if (requestRedirectUri !== undefined) {
    // フラグメントを含む `redirect_uri` を拒否する。
    if (requestRedirectUri.includes('#')) {
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequest,
        'redirect_uri must not contain fragment'
      );
    }

    // 登録済みの URI と照合する。
    if (!matchRedirectUri(requestRedirectUri, registeredUris, clientType)) {
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequest,
        'redirect_uri not registered'
      );
    }

    return requestRedirectUri;
  }

  // `redirect_uri` が省略されていれば、登録済みの URI が一つのときだけそれを使う。
  if (registeredUris.length === 1) {
    return registeredUris[0] as string;
  }

  // 登録済みの URI が一つでなければ（複数あるときなど）、`redirect_uri` は省略できない。
  throw new AuthorizationError(
    AuthorizationErrorCode.InvalidRequest,
    'redirect_uri is required when multiple redirect URIs are registered'
  );
}

/**
 * 認可リクエストの `redirect_uri` を決めて返す。
 *
 * リクエストに `redirect_uri` があれば、クライアントの登録済みの URI と照合する（RFC 3986 §6.2.1 の単純な文字列比較）。
 * ループバックアドレスのポート番号の違いを許すのは、パブリッククライアントだけである。
 * リクエストにないときは、登録済みの URI が一つならそれを使い、そうでなければエラーにする。
 * 照合は `resolveRedirectUri()` が行う。
 *
 * このステップより前のエラーは、リダイレクト先を信頼できないので、リダイレクトせずに投げる。
 * このステップで決めた `redirect_uri` を、以降のステップにエラーのリダイレクト先として渡す。
 *
 * @spec RFC 3986 §6.2.1
 */
export function resolveAuthorizationRedirectUri(
  effectiveParams: Pick<AuthorizationRequestParams, 'redirect_uri'>,
  client: Pick<ClientInfo, 'redirectUris' | 'clientType'>,
): string {
  return resolveRedirectUri(
    effectiveParams.redirect_uri,
    client.redirectUris,
    client.clientType,
  );
}

/**
 * `prompt` パラメータがあれば検証して値の配列を返す。
 *
 * `prompt` がなければ `undefined` を返す。
 * あれば値を空白で分け、`none`、`login`、`consent`、`select_account` 以外の値があるときと、`none` をほかの値と併用しているときは、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export function validatePromptParameter(
  effectiveParams: Pick<AuthorizationRequestParams, 'prompt'>,
  redirectUri: string,
  state?: string
): string[] | undefined {
  if (effectiveParams.prompt === undefined) {
    return undefined;
  }
  return validatePrompt(effectiveParams.prompt, redirectUri, state);
}

/**
 * `prompt` の値を検証し、配列にして返す。
 *
 * 値を空白で分け（`parsePromptValues()`）、定義済みの値だけであること（`validatePromptValues()`）と、`none` をほかの値と併用していないこと（`validatePromptNoneNotCombined()`）を確かめる。
 * どちらかに反すると、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export function validatePrompt(
  promptValue: string,
  redirectUri: string,
  state?: string
): string[] {
  const values = parsePromptValues(promptValue);
  validatePromptValues(values, redirectUri, state);
  validatePromptNoneNotCombined(values, redirectUri, state);
  return values;
}

/**
 * `prompt` の値を空白で分けて配列で返す。
 *
 * 空白が連続してできる空の要素は取り除く。
 * 値の妥当性は検査しない。
 */
export function parsePromptValues(promptValue: string): string[] {
  return promptValue.split(' ').filter((value) => value.length > 0);
}

/**
 * `prompt` の値が不正なら `invalid_request` を投げる。
 *
 * `none`、`login`、`consent`、`select_account` 以外の値があるときに、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export function validatePromptValues(
  promptValues: readonly string[],
  redirectUri: string,
  state?: string
): void {
  for (const value of promptValues) {
    if (!(VALID_PROMPT_VALUES as readonly string[]).includes(value)) {
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequest,
        `Invalid prompt value: ${value}`,
        redirectUri,
        state
      );
    }
  }
}

/**
 * `none` を併用していれば `invalid_request` を投げる。
 *
 * `prompt` の値に `none` とほかの値が両方あるときに、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export function validatePromptNoneNotCombined(
  promptValues: readonly string[],
  redirectUri: string,
  state?: string
): void {
  if (promptValues.includes('none') && promptValues.length > 1) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'prompt value "none" must not be combined with other values',
      redirectUri,
      state
    );
  }
}

/**
 * `max_age` を検証し、秒数を返す。
 *
 * 値を `Number()` で数値に変換し、非負の整数でなければ、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 */
export function validateMaxAge(
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
 * 登録された `default_max_age` を検証して返す。
 *
 * `default_max_age` は秒数を表す非負の整数でなければならない（OIDC Dynamic Client Registration 1.0 §2）。
 * この値はリクエストではなくクライアントの登録メタデータから来るので、不正な値は設定ミス（サーバー側のエラー）として扱い、リダイレクトせずに `server_error` の `AuthorizationError` を投げる。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 */
export function validateDefaultMaxAge(defaultMaxAge: number): number {
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
 * 適用する `max_age` を決めて返す。
 *
 * リクエストに `max_age` があれば、検証してその値を返す（OIDC Core 1.0 §3.1.2.1）。
 * なければ、クライアントの登録の `default_max_age` を検証して返す（OIDC Dynamic Client Registration 1.0 §2）。
 * どちらもなければ `undefined` を返し、認証からの経過時間を制限しない。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec OIDC Dynamic Client Registration 1.0 §2
 */
export function resolveMaxAge(
  effectiveParams: Pick<AuthorizationRequestParams, 'max_age'>,
  client: Pick<ClientInfo, 'defaultMaxAge'>,
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
 * PKCE のパラメータを検証し、検証した値を返す。
 *
 * `code_challenge` と `code_challenge_method` がともにあり、方式が `S256` で、`code_challenge` が 43 文字の base64url であることを確かめる。
 * どれかに反すると、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 *
 * @spec OAuth 2.1 §4.1.1
 * @spec OAuth 2.1 §7.5
 */
export function validateCodeChallenge(
  codeChallenge: string | undefined,
  codeChallengeMethod: string | undefined,
  redirectUri: string,
  state?: string
): { codeChallenge: string; codeChallengeMethod: 'S256' } {
  const requiredCodeChallenge = requireCodeChallenge(codeChallenge, redirectUri, state);
  const requiredMethod = requireCodeChallengeMethod(codeChallengeMethod, redirectUri, state);
  const method = validateCodeChallengeMethod(requiredMethod, redirectUri, state);
  validateS256CodeChallenge(requiredCodeChallenge, redirectUri, state);

  return {
    codeChallenge: requiredCodeChallenge,
    codeChallengeMethod: method,
  };
}

/**
 * `code_challenge` があることを確かめて返す。
 *
 * ないとき（空文字列を含む）は、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 *
 * @spec OAuth 2.1 §4.1.1
 */
export function requireCodeChallenge(
  codeChallenge: string | undefined,
  redirectUri: string,
  state?: string
): string {
  if (!codeChallenge) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'Missing required parameter: code_challenge',
      redirectUri,
      state
    );
  }
  return codeChallenge;
}

/**
 * `code_challenge_method` があることを確かめて返す。
 *
 * ないとき（空文字列を含む）は、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 * RFC 7636 §4.3 の既定値 `plain` で補わないので、省略は拒否する。
 *
 * @spec RFC 7636 §4.3
 */
export function requireCodeChallengeMethod(
  codeChallengeMethod: string | undefined,
  redirectUri: string,
  state?: string
): string {
  if (!codeChallengeMethod) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'Missing required parameter: code_challenge_method',
      redirectUri,
      state
    );
  }
  return codeChallengeMethod;
}

/**
 * `S256` 以外の方式なら `invalid_request` を投げる。
 *
 * `code_challenge_method` が `S256` なら、その値を返す。
 * `plain` はセキュリティ上の理由で拒否する。
 * エラーはリダイレクトで返す。
 *
 * @spec OAuth 2.1 §4.1.1
 * @spec OAuth 2.1 §7.5
 */
export function validateCodeChallengeMethod(
  codeChallengeMethod: string,
  redirectUri: string,
  state?: string
): 'S256' {
  if (!(VALID_CODE_CHALLENGE_METHODS as readonly string[]).includes(codeChallengeMethod)) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      `Unsupported code_challenge_method: ${codeChallengeMethod}`,
      redirectUri,
      state
    );
  }
  return codeChallengeMethod as 'S256';
}

/**
 * `code_challenge` の形式を検証する。
 *
 * `S256` の `code_challenge` は 43 文字の base64url（パディングなし）でなければならず、長さか文字がこれに合わなければ、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 * トークンエンドポイントで `code_verifier` と比べるときまで待たずに、ここで形式の誤りを見つける。
 *
 * @spec RFC 7636 §4.2
 */
export function validateS256CodeChallenge(
  codeChallenge: string,
  redirectUri: string,
  state?: string
): void {
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
}

/**
 * 認可リクエストの PKCE を検証し、検証した値を返す。
 *
 * OAuth 2.1 では PKCE（`S256`）が必須なので、`code_challenge` と `code_challenge_method` を `validateCodeChallenge()` で検証する。
 * 例外として、`options.allowNonPkceAuthorizationCodeFlow` が true で、コンフィデンシャルクライアントが PKCE のパラメータを両方とも省略したときだけ、省略を認めて空のオブジェクトを返す。
 * この例外は、OIDF の適合性テストのうち、静的に登録したクライアントで OP の基本機能を試すテストに合わせるためである。
 *
 * @spec OAuth 2.1 §4.1.1
 * @spec OAuth 2.1 §7.5
 */
export function validateAuthorizationCodePkce(
  effectiveParams: Pick<AuthorizationRequestParams, 'code_challenge' | 'code_challenge_method'>,
  client: Pick<ClientInfo, 'clientType'>,
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
 * `client_id` の登録済みクライアントを取得して返す。
 *
 * どの検証もリダイレクト先が決まる前に行うので、エラーはリダイレクトせずに `AuthorizationError` として投げる:
 * - `client_id` がない（空文字列を含む）ときは `invalid_request`。
 * - クライアントが登録されていないときは `invalid_request`。
 * - `ClientResolver` が別の `clientId` のクライアントを返したときは `server_error`。
 */
export async function resolveClientForAuthorization(
  params: Pick<AuthorizationRequestParams, 'client_id'>,
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

  // `ClientResolver` の実装が、問い合わせた `clientId` のクライアントを返したかを実行時に確かめる。
  // 別のクライアントのデータが混ざる不具合を見つけるためである。
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
 * リクエストオブジェクトを検証し、パラメータを返す。
 *
 * `request` パラメータがなければ、クエリパラメータのコピーをそのまま返す。
 * あれば、`request` パラメータで値として渡された署名付きのリクエストオブジェクト（JWS）を、クライアントが `request_object` の用途に登録した公開鍵（`options.jwks`）で検証する。
 * 検証できたら、リクエストオブジェクトのクレームでクエリの値を上書きしたパラメータと、そのクレームを返す。
 * 公開鍵は呼び出し側が `ClientKeyResolver` で取得するが、`request` パラメータがあるときだけ取得すれば足りる。
 * 受け付ける署名アルゴリズム（`options.supportedSigningAlgs`）の既定値は `RS256` だけで、署名のない（`alg` が `none` の）リクエストオブジェクトは、`options.allowUnsigned` が true でなければ拒否する。
 *
 * 検証に失敗したリクエストオブジェクト（壊れた JWT、対応していない `alg`、鍵の不一致、署名の不一致）は信頼できないので、中の `redirect_uri` も信用しない。
 * そのため、リダイレクトせずに `invalid_request_object` の `AuthorizationError` を投げる（OIDC Core 1.0 §6.3）。
 *
 * `response_type` と `client_id` は OAuth 2.0 のリクエスト構文の値を正とするので、上書きしない。
 * 両者の一致は、あとの {@link validateRequestObjectConsistency} で検証する。
 *
 * @spec OIDC Core 1.0 §6.1
 * @spec OIDC Core 1.0 §6.3
 */
export async function resolveRequestObjectParams(
  params: AuthorizationRequestParams,
  options: {
    /**
     * 署名の検証に使う、クライアントが request_object の用途に登録した公開鍵。
     * 無い（空を含む）まま署名付き Request Object を受け取ると invalid_request_object で拒否する。
     */
    jwks?: JwkSet;
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
      jwks: options.jwks,
      supportedSigningAlgs:
        options.supportedSigningAlgs ?? [
          ...DEFAULT_REQUEST_OBJECT_SIGNING_ALGS,
        ],
      allowUnsigned: options.allowUnsigned ?? false,
    });
  } catch (e) {
    if (e instanceof RequestObjectError) {
      // 不正なリクエストオブジェクトは `invalid_request_object` で報告する（OIDC Core 1.0 §6.3）。
      // リクエストオブジェクトを直すべきことを、`request` パラメータの使用をやめるべきことを示す `request_not_supported` と区別して伝えるためである。
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequestObject,
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
 * 未対応のパラメータがあれば例外を投げる。
 *
 * 次のパラメータがあると、それぞれのエラーコードの `AuthorizationError` を投げる:
 * - `request`: `options.requestParameterSupported` が false の構成でだけ `request_not_supported`（OIDC Core 1.0 §6.1、§6.3）。既定では対応しているものとして扱い、拒否しない。
 * - `request_uri`: 対応していないので `request_uri_not_supported`（OIDC Core 1.0 §6.2、§6.3）。
 * - `registration`: 対応していないので `registration_not_supported`（OIDC Core 1.0 §3.1.2.1、§7.2.1、§3.1.2.6）。
 *
 * どれもリダイレクト先が決まったあとのエラーなので、リダイレクトで返す。
 *
 * @spec OIDC Core 1.0 §6.1
 * @spec OIDC Core 1.0 §6.2
 * @spec OIDC Core 1.0 §6.3
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec OIDC Core 1.0 §7.2.1
 * @spec OIDC Core 1.0 §3.1.2.6
 */
export function rejectUnsupportedRequestParams(
  params: Pick<AuthorizationRequestParams, 'request' | 'request_uri' | 'registration'>,
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
 * リクエストオブジェクトとクエリの整合性を検証する。
 *
 * `response_type` と `client_id` は、OAuth 2.0 のリクエスト構文（クエリ）で送ることが必須（MUST）である（OIDC Core 1.0 §6.1）。
 * リクエストオブジェクトにもこれらが含まれていて、クエリの値と一致しない（クエリにないときを含む）ときは、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 * `response_type` は値の順序を問わずに比べる。
 * ほかのパラメータは、リクエストオブジェクトの値を優先する規則に従って、リクエストオブジェクト側の値を使う。
 * `requestObjectClaims` が `undefined`（`request` パラメータがない）なら何もしない。
 *
 * @spec OIDC Core 1.0 §6.1
 */
export function validateRequestObjectConsistency(
  params: Pick<AuthorizationRequestParams, 'response_type' | 'client_id'>,
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
  // 値の順序は問わないので、`token id_token` は `id_token token` と一致するとみなす（OAuth 2.0 Multiple Response Type Encoding Practices §1.2）。
  if (
    roResponseType !== undefined &&
    (params.response_type === undefined ||
      normalizeResponseType(roResponseType) !== normalizeResponseType(params.response_type))
  ) {
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
 * `response_type` を検証し、正規化した値を返す。
 *
 * 次のときは、リダイレクトで返す `AuthorizationError` を投げる:
 * - `response_type` がないときは `invalid_request`（OAuth 2.1 §4.1.2.1）。
 * - `supportedResponseTypes` にない値は、OP 全体で対応していないので `unsupported_response_type`。
 * - クライアントが登録していない値は、そのクライアントに許されていないので `unauthorized_client`。登録がないクライアントの既定値は `["code"]` である（OIDC Dynamic Client Registration 1.0 §2、RFC 7591 §2）。
 *
 * `supportedResponseTypes` の既定値は `["code"]`（認可コードフローだけ）である。
 * インプリシットフロー（OIDC Core 1.0 §3.2）にも応答する OP は `id_token` と `id_token token` を、ハイブリッドフロー（OIDC Core 1.0 §3.3）にも応答する OP は `code id_token`、`code token`、`code id_token token` を加えて渡す。
 *
 * 値の順序は問わず（OAuth 2.0 Multiple Response Type Encoding Practices §1.2）、{@link normalizeResponseType} の形で返す（`token id_token` は `id_token token` になる）。
 *
 * `response_type` は OAuth 2.0 のリクエスト構文の値を正とするので、リクエストオブジェクトを適用する前のクエリパラメータ（`params`）を渡す（OIDC Core 1.0 §6.1）。
 *
 * @spec OAuth 2.1 §4.1.2.1
 * @spec OIDC Core 1.0 §3.2
 * @spec OIDC Core 1.0 §3.3
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §1.2
 * @spec OIDC Core 1.0 §6.1
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @spec RFC 7591 §2
 */
export function validateResponseType(
  params: Pick<AuthorizationRequestParams, 'response_type'>,
  client: Pick<ClientInfo, 'responseTypes'>,
  redirectUri: string,
  state?: string,
  supportedResponseTypes: readonly AuthorizationResponseType[] = ['code'],
): AuthorizationResponseType {
  const responseType = validateSupportedResponseType(
    params.response_type,
    redirectUri,
    state,
    supportedResponseTypes,
  );
  validateClientResponseType(responseType, client.responseTypes, redirectUri, state);
  return responseType;
}

/**
 * `scope` を検証し、重複を除いた配列を返す。
 *
 * `scope` は、リクエストオブジェクトがあっても OAuth 2.0 のリクエスト構文（クエリ、`queryParams`）で送る必要があり、クエリになければ `invalid_request` を投げる（OIDC Core 1.0 §6.1）。
 * 有効な値（`effectiveParams`。リクエストオブジェクトを使わないならクエリと同じものを渡す）を空白で分けて重複を除き、`openid` が含まれなければ `invalid_scope` を投げる（OIDC Core 1.0 §3.1.2.1）。
 * どちらのエラーも、リダイレクトで返す `AuthorizationError` である。
 *
 * @spec OIDC Core 1.0 §6.1
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export function validateAuthorizationScope(
  queryParams: Pick<AuthorizationRequestParams, 'scope'>,
  effectiveParams: Pick<AuthorizationRequestParams, 'scope'>,
  redirectUri: string,
  state?: string,
): string[] {
  const queryScopeValue = requireAuthorizationScope(queryParams.scope, redirectUri, state);

  const scopeValue = effectiveParams.scope ?? queryScopeValue;
  // 空白区切りの `scope` を集合として扱い、最初に現れた順を保ったまま重複を取り除く（RFC 6749 §3.3）。
  // トークンエンドポイント（`refresh_token` グラント）と同じ扱いであり、重複を取り除いても権限は変わらない。
  const scope = parseScope(scopeValue);
  validateOpenIdScope(scope, redirectUri, state);

  return scope;
}

/**
 * `offline_access` を許可するか判定し、スコープを返す。
 *
 * 許可の条件を満たさない `offline_access` の要求は無視しなければならない（MUST）ので、スコープから取り除く（OIDC Core 1.0 §11）。
 * 条件は `isOfflineAccessGranted` で判定する。
 * 既定の {@link defaultIsOfflineAccessGranted} は、`prompt` に `consent` が含まれ、かつクライアントが `refresh_token` グラントを登録しているときに許可する。
 * `isOfflineAccessGranted` を差し替えれば、独自の許可の条件を使える。
 *
 * ただし、`response_type` が認可コードを返さない場合（インプリシットフローの `id_token` と `id_token token`）は、`isOfflineAccessGranted` の結果によらず必ず取り除く。
 * OP は、認可コードが返る `response_type` をクライアントが使っていない限り、`offline_access` の要求を無視しなければならない（OIDC Core 1.0 §11）。
 *
 * スコープに `offline_access` がなければ、何もせずにそのまま返す。
 * 引数は書き換えない。
 *
 * @spec OIDC Core 1.0 §11
 */
export async function applyOfflineAccessPolicy(
  scope: string[],
  effectiveParams: AuthorizationRequestParams,
  promptValues: string[] | undefined,
  client: ClientInfo,
  isOfflineAccessGranted: OfflineAccessGrantedCallback = defaultIsOfflineAccessGranted,
): Promise<string[]> {
  if (!scope.includes('offline_access')) {
    return scope;
  }

  // `response_type` が `code` を含まなければ、`offline_access` を必ず取り除く。
  // インプリシットフローではリフレッシュトークンを返さないので（RFC 6749 §4.2.2）、どの許可の条件を満たしても `offline_access` は意味を持たない。
  if (!responseTypeIncludes(effectiveParams.response_type, 'code')) {
    return filterOfflineAccessScope(scope, false);
  }

  const granted = await isOfflineAccessGranted(effectiveParams, {
    promptValues: promptValues ?? [],
    client,
  });
  return filterOfflineAccessScope(scope, granted);
}

/**
 * `display` を検証して返す。
 *
 * `display` は省略できる（OPTIONAL）が、指定するなら `page`、`popup`、`touch`、`wap` のどれかでなければならない（OIDC Core 1.0 §3.1.2.1）。
 * それ以外の値なら、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 * `display` がなければ `undefined` を返す。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export function validateDisplayParameter(
  effectiveParams: Pick<AuthorizationRequestParams, 'display'>,
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
 * `acr_values` を検証し、空白一つで区切り直して返す。
 *
 * `acr_values` は省略できる（OPTIONAL）パラメータで、要求する `acr` の値を優先順に空白で区切って並べる（OIDC Core 1.0 §3.1.2.1）。
 * 各値の構文は {@link validateAcrValues} が検査し、構文に合わなければ、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 * 返す文字列でも、値の優先順は変えない。
 *
 * OP がその認証コンテキストを満たせるかは検査しない。
 * 満たした `acr` はトークンエンドポイントで決め、ID トークンとアクセストークンの `acr` クレームに入れる。
 *
 * パラメータがないときと、値が一つもない（空文字列か空白だけの）ときは `undefined` を返す。
 * 値のないパラメータは、省略されたものとして扱うためである（RFC 6749 §3.1）。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec RFC 6749 §3.1
 */
export function validateAcrValuesParameter(
  effectiveParams: Pick<AuthorizationRequestParams, 'acr_values'>,
  redirectUri: string,
  state?: string,
): string | undefined {
  if (effectiveParams.acr_values === undefined) {
    return undefined;
  }
  const acrValues = parseAcrValues(effectiveParams.acr_values);
  if (acrValues.length === 0) {
    return undefined;
  }
  validateAcrValues(acrValues, redirectUri, state);
  return acrValues.join(' ');
}

/**
 * `acr` の値の構文を検証する。
 *
 * 各値が、スコープの値と同じ構文（RFC 6749 §3.3 の `scope-token`）であることを確かめる。
 * 空の値と、空白、制御文字、ASCII 以外の文字、二重引用符、バックスラッシュを含む値があれば、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 *
 * @spec RFC 6749 §3.3
 */
export function validateAcrValues(
  acrValues: readonly string[],
  redirectUri: string,
  state?: string,
): void {
  for (const value of acrValues) {
    if (!ACR_VALUE_PATTERN.test(value)) {
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequest,
        'acr_values must be space-separated values of visible ASCII characters other than double quote and backslash',
        redirectUri,
        state
      );
    }
  }
}

/**
 * `audience` を空白で分けて配列で返す。
 *
 * `audience` がなければ `undefined` を返す。
 * 空白が連続してできる空の要素は取り除くので、値が空白だけなら空の配列を返す。
 */
export function parseAudienceParameter(
  effectiveParams: Pick<AuthorizationRequestParams, 'audience'>,
): string[] | undefined {
  const audienceValue = effectiveParams.audience;
  if (audienceValue === undefined) {
    return undefined;
  }
  return audienceValue.split(' ').filter((a) => a.length > 0);
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

/**
 * リクエストオブジェクトで上書きしたパラメータを返す。
 *
 * クエリの値（`params`）を、リクエストオブジェクトのクレーム（`roClaims`）で上書きする（OIDC Core 1.0 §6.1）。
 * 上書きするのは `redirect_uri`、`scope`、`state`、`nonce`、`prompt`、`display`、`max_age`、`ui_locales`、`claims_locales`、`acr_values`、`login_hint`、`id_token_hint`、`audience`、`code_challenge`、`code_challenge_method`、`claims` で、`response_type` と `client_id` は上書きしない。
 * クレームの値が文字列ならそのまま使い、数値と真偽値は文字列に直し、配列とオブジェクトは無視する。
 * `claims` だけは、配列でないオブジェクトなら JSON の文字列に直し、文字列ならそのまま使う（OIDC Core 1.0 §5.5）。
 * 引数は書き換えず、新しいオブジェクトを返す。
 * 署名は検証しないので、検証済みのクレームを渡す。
 *
 * @spec OIDC Core 1.0 §6.1
 * @spec OIDC Core 1.0 §5.5
 */
export function mergeRequestObjectParams(
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
    // 配列とオブジェクトは、一つの値をとるこれらのパラメータには使えないので無視する。
  }

  // リクエストオブジェクトの中の `claims` は、JSON の文字列ではなく JSON のオブジェクトである（OIDC Core 1.0 §5.5）。
  // `parseClaimsRequestParameter()` が扱えるように、JSON の文字列に直す。
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

  // すべて文字列のクエリパラメータに、リクエストオブジェクトの値を重ねる。
  // 元の引数は書き換えない。
  return { ...params, ...overrides };
}

/**
 * `claims` パラメータを解析し、クレームの要求を返す。
 *
 * `claims` は JSON の文字列で渡される（OIDC Core 1.0 §5.5）。
 * 採用するのは `userinfo` と `id_token` のメンバーだけで、各メンバーの中では、値が `null` かオブジェクト（`{ essential?, value?, values? }` の形を想定する）のクレーム要求だけを残し、オブジェクトの中身は検査しない。
 * `claims` がなければ `undefined` を返す。
 *
 * 次のときは、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる:
 * - 長さが `maxLength` を超える。
 * - JSON として解析できない。
 * - 解析した値が JSON のオブジェクトでない。
 *
 * `maxLength` は `JSON.parse` の前に課す長さの上限で、認証されていない相手からのサービス妨害（DoS）を防ぐ。
 * 既定値は {@link DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH} である。
 *
 * @spec OIDC Core 1.0 §5.5
 */
export function parseClaimsRequestParameter(
  effectiveParams: Pick<AuthorizationRequestParams, 'claims'>,
  redirectUri: string,
  state?: string,
  maxLength: number = DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH,
): ClaimsParameter | undefined {
  const raw = effectiveParams.claims;
  if (raw === undefined) return undefined;

  // 信頼できない入力の長さの上限を、`JSON.parse` の前に確かめる。
  // 認可エンドポイントは認証なしで公開されており、巨大な `claims` や入れ子の深い `claims` を解析させると、CPU とメモリを枯渇させられる（アプリケーション層の DoS。OWASP API4:2023、RFC 9700 §2.5）。
  // 巨大な入力は、エラーの説明文に含めない（`sanitizeErrorDescription()` を通す扱いと揃える）。
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

/**
 * `null` かオブジェクトのクレーム要求だけを残して返す。
 *
 * 受け取るのは、`claims` パラメータの `userinfo` か `id_token` のメンバーである。
 * メンバーが JSON のオブジェクトでない（`null`、配列、文字列など）ときは `undefined` を返す。
 * 値が文字列、数値、真偽値、配列のクレーム要求は黙って捨て、値がオブジェクトなら中身（`essential`、`value`、`values`）を検査せずに残す。
 * 結果は新しいオブジェクトで返す。
 *
 * @spec OIDC Core 1.0 §5.5.1
 */
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
    // 文字列、数値、真偽値、配列の値は黙って捨てる。
  }
  return result;
}

/**
 * 対応する `response_type` か検証し、正規化して返す。
 *
 * OP が対応する値は `supportedResponseTypes`（既定値は `["code"]`）で渡す。
 * `response_type` がないときは `invalid_request` を、対応していない値なら `unsupported_response_type` を、リダイレクトで返す `AuthorizationError` として投げる（OAuth 2.1 §4.1.2.1）。
 * 値の順序は問わず（OAuth 2.0 Multiple Response Type Encoding Practices §1.2）、{@link normalizeResponseType} の形で返す。
 * クライアントの登録との照合は {@link validateClientResponseType} が行う。
 *
 * @spec OAuth 2.1 §4.1.2.1
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §1.2
 */
export function validateSupportedResponseType(
  responseType: string | undefined,
  redirectUri: string,
  state?: string,
  supportedResponseTypes: readonly AuthorizationResponseType[] = ['code'],
): AuthorizationResponseType {
  if (!responseType) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'Missing required parameter: response_type',
      redirectUri,
      state
    );
  }

  const normalized = normalizeResponseType(responseType);
  const supported = supportedResponseTypes.find((candidate) => candidate === normalized);
  if (supported === undefined) {
    throw new AuthorizationError(
      AuthorizationErrorCode.UnsupportedResponseType,
      `Unsupported response_type: ${responseType}`,
      redirectUri,
      state
    );
  }

  return supported;
}

/**
 * クライアントの登録と `response_type` を照合する。
 *
 * `response_type` がクライアントの登録（`responseTypes`）にないときは、リダイレクトで返す `unauthorized_client` の `AuthorizationError` を投げる。
 * 登録がなければ `code` だけを許す（OIDC Dynamic Client Registration 1.0 §2）。
 * 登録された値も順序を問わずに照合する（`token id_token` の登録は `id_token token` に一致する）。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 */
export function validateClientResponseType(
  responseType: string,
  responseTypes: readonly string[] | undefined,
  redirectUri: string,
  state?: string,
): void {
  // `response_type` をクライアントごとに許可しているかを確かめる。
  // クライアントがこの方法で認可コードを要求することを許されていないときは、`unauthorized_client` を返す（RFC 6749 §4.1.2.1、OAuth 2.1 §4.1.2.1）。
  // OP 全体で対応していない場合の `unsupported_response_type` とは区別する。
  const allowedResponseTypes = (responseTypes ?? ['code']).map(normalizeResponseType);
  if (!allowedResponseTypes.includes(normalizeResponseType(responseType))) {
    throw new AuthorizationError(
      AuthorizationErrorCode.UnauthorizedClient,
      `Client is not authorized to use response_type: ${responseType}`,
      redirectUri,
      state
    );
  }
}

/**
 * 未登録のスコープがあれば `invalid_scope` を投げる。
 *
 * クライアントの登録メタデータの `scope` は、そのクライアントが要求してよいスコープの一覧である（RFC 7591 §2）。
 * 一覧にないスコープを要求したときは、リダイレクトで返す `invalid_scope` の `AuthorizationError` を投げる（RFC 6749 §4.1.2.1）。
 * 一覧を登録していない（`undefined`）クライアントは検証しない。
 *
 * 要求されたスコープは、`offline_access` の許可の条件（OIDC Core 1.0 §11）を適用する前の値で渡す。
 * 登録外のスコープを要求したこと自体を誤りとして扱うので、あとで取り除かれる `offline_access` も照合する。
 *
 * @spec RFC 7591 §2
 * @spec RFC 6749 §4.1.2.1
 * @spec OIDC Core 1.0 §11
 */
export function validateClientScope(
  scope: readonly string[],
  registeredScope: readonly string[] | undefined,
  redirectUri: string,
  state?: string,
): void {
  const unregistered = findUnregisteredClientScopes(scope, registeredScope);
  if (unregistered.length > 0) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidScope,
      `Client is not registered for scope: ${unregistered.join(' ')}`,
      redirectUri,
      state
    );
  }
}

/**
 * クエリに `scope` があることを確かめて返す。
 *
 * リクエストオブジェクトを使う場合も、`scope` はクエリに必要である（OIDC Core 1.0 §6.1）。
 * ないとき（空文字列を含む）は、リダイレクトで返す `invalid_request` の `AuthorizationError` を投げる。
 *
 * @spec OIDC Core 1.0 §6.1
 */
export function requireAuthorizationScope(
  queryScopeValue: string | undefined,
  redirectUri: string,
  state?: string,
): string {
  if (!queryScopeValue) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'Missing required parameter: scope',
      redirectUri,
      state
    );
  }

  return queryScopeValue;
}

/**
 * `openid` がなければ `invalid_scope` を投げる。
 *
 * 解析済みのスコープに `openid` が含まれることを確かめる。
 * エラーは、リダイレクトで返す `AuthorizationError` である。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export function validateOpenIdScope(
  scope: readonly string[],
  redirectUri: string,
  state?: string,
): void {
  if (!scope.includes('openid')) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidScope,
      'scope must include openid',
      redirectUri,
      state
    );
  }
}

/**
 * 不許可なら `offline_access` を除いて返す。
 *
 * `granted` が true なら `scope` をそのまま返し、false なら `offline_access` を取り除いた新しい配列を返す（OIDC Core 1.0 §11）。
 * 許可するかどうかの判定はせず、引数の配列も書き換えない。
 *
 * @spec OIDC Core 1.0 §11
 */
export function filterOfflineAccessScope(scope: string[], granted: boolean): string[] {
  return granted ? scope : scope.filter((value) => value !== 'offline_access');
}
