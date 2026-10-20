/**
 * Implicit Flow（OIDC Core 1.0 §3.2）
 *
 * Implicit Flow では、認可エンドポイントが ID Token（response_type=id_token token では
 * アクセストークンも）を直接返し、トークンエンドポイントを使わない。認可コードも
 * Refresh Token も発行しない（RFC 6749 §4.2.2）。
 *
 * このモジュールは Implicit Flow に固有の認可リクエストの検証（nonce、redirect_uri、
 * response_mode）と、認可エンドポイントが返すパラメータの組み立てを提供する。
 * response_type の受理は {@link validateResponseType}、ID Token とアクセストークンの
 * 発行は Authorization Code Flow と同じ部品（buildIdTokenPayload、computeAtHash、
 * buildAccessTokenPayload など）で行う。
 */
import { AuthorizationError, AuthorizationErrorCode } from './authorization-request.js';
import { isLoopbackHostname } from './loopback.js';
import { responseTypeIncludes } from './response-type.js';

/**
 * OIDC Core 1.0 §3.2.2.1: Implicit Flow の認可リクエストには nonce が必須
 * （ID Token を認可エンドポイントから返すため、リプレイの検知に使う）。
 * 欠落と空文字は、リダイレクト可能な invalid_request とする。
 */
export function requireNonce(
  nonce: string | undefined,
  redirectUri: string,
  state?: string,
): string {
  if (!nonce) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'Missing required parameter: nonce',
      redirectUri,
      state,
    );
  }
  return nonce;
}

/**
 * OIDC Core 1.0 §3.2.2.1: Implicit Flow の redirect_uri は http スキームを使ってはならない。
 * ネイティブアプリだけは、ホスト名が localhost か 127.0.0.1 / [::1] のループバックの http を
 * 使ってよい。トークンが TLS の無い経路を通らないようにするための規則である。
 *
 * この OP はクライアントの application_type（OIDC Dynamic Client Registration 1.0 §2）を
 * 持たないため、public client（OAuth 2.1 §2.1）をネイティブアプリとして扱う。clientType が
 * 未登録のクライアントは confidential として扱う。
 *
 * redirect_uri は登録済みの値と照合した後に渡す。違反はその redirect_uri へ返す
 * invalid_request とする（エラーの応答はトークンを含まない）。
 */
export function validateImplicitRedirectUri(
  redirectUri: string,
  clientType: 'confidential' | 'public' | undefined,
  state?: string,
): void {
  const colonIndex = redirectUri.indexOf(':');
  const scheme = redirectUri.slice(0, colonIndex + 1).toLowerCase();
  if (scheme !== 'http:') return;

  let hostname: string | undefined;
  try {
    hostname = new URL(redirectUri).hostname;
  } catch {
    hostname = undefined;
  }
  if (clientType === 'public' && hostname !== undefined && isLoopbackHostname(hostname)) return;

  throw new AuthorizationError(
    AuthorizationErrorCode.InvalidRequest,
    'redirect_uri of the Implicit Flow must use https, or http on a loopback host for a public client',
    redirectUri,
    state,
  );
}

/**
 * Implicit Flow の response_mode を検証する。
 *
 * - 指定が無ければ既定の応答モード（fragment）で返すので、何もしない
 * - `query` は拒否する。OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5 は
 *   id_token と id_token token の応答を query で返すことを禁じ（"the query encoding MUST NOT
 *   be used"）、§7 は ID Token とアクセストークンをクエリに載せることを禁じる
 * - supportedResponseModes（OP がこのリクエストに答える応答モード）に無い値も拒否する。
 *   要求された応答モードを黙って別のモードに置き換えない
 *
 * どの拒否もリダイレクト可能な invalid_request とする。呼び出し側は、エラーをリクエストの
 * 既定の応答モード（fragment）で返す（OIDC Core 1.0 §3.2.2.6）。
 */
export function validateImplicitResponseMode(
  responseMode: string | undefined,
  supportedResponseModes: readonly string[],
  redirectUri: string,
  state?: string,
): void {
  if (responseMode === undefined) return;

  if (responseMode === 'query') {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'response_mode=query must not be used with the Implicit Flow',
      redirectUri,
      state,
    );
  }

  if (!supportedResponseModes.includes(responseMode)) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      `Unsupported response_mode: ${responseMode}`,
      redirectUri,
      state,
    );
  }
}

/**
 * OIDC Core 1.0 §5.4: アクセストークンを発行しない response_type（`id_token`）では、
 * scope 値（profile / email / address / phone）が要求するクレームを ID Token で返す。
 * アクセストークンを発行する response_type では、それらは UserInfo エンドポイントが返す。
 * `token` を含む response_type は認可エンドポイントが、`code` を含む response_type
 * （Hybrid Flow の `code id_token` など）はトークンエンドポイントがアクセストークンを発行する。
 */
export function returnsScopeClaimsInIdToken(responseType: string): boolean {
  return (
    responseTypeIncludes(responseType, 'id_token') &&
    !responseTypeIncludes(responseType, 'token') &&
    !responseTypeIncludes(responseType, 'code')
  );
}

/**
 * {@link buildImplicitResponseParameters} の入力。
 */
export interface ImplicitResponseParametersInput {
  /** 発行した ID Token（OIDC Core 1.0 §3.2.2.5: REQUIRED）。 */
  idToken: string;
  /** 発行したアクセストークン。response_type=id_token token のときだけ渡す。 */
  accessToken?: string;
  /** アクセストークンの有効期間（秒）。 */
  expiresIn?: number;
  /** アクセストークンに付与した scope。 */
  scope?: string[];
  /** 認可リクエストの state。リクエストにあった場合は REQUIRED。 */
  state?: string;
}

/**
 * OIDC Core 1.0 §3.2.2.5: Implicit Flow の成功応答のパラメータを組み立てる。
 *
 * - access_token / token_type（`Bearer`）/ expires_in: アクセストークンを発行したときだけ
 * - scope: 付与した scope（RFC 6749 §4.2.2。要求と異なりうるため、アクセストークンを
 *   発行したときは常に含める）
 * - id_token / state
 *
 * Refresh Token は含めない（RFC 6749 §4.2.2: MUST NOT）。iss（RFC 9207 §2）は応答モードが
 * 加える。値はすべて文字列（応答はフラグメントやフォームに載る）。
 */
export function buildImplicitResponseParameters(
  input: ImplicitResponseParametersInput,
): Record<string, string> {
  const parameters: Record<string, string> = {};
  if (input.accessToken !== undefined) {
    parameters['access_token'] = input.accessToken;
    parameters['token_type'] = 'Bearer';
    if (input.expiresIn !== undefined) {
      parameters['expires_in'] = String(input.expiresIn);
    }
    if (input.scope !== undefined) {
      parameters['scope'] = input.scope.join(' ');
    }
  }
  parameters['id_token'] = input.idToken;
  if (input.state !== undefined) {
    parameters['state'] = input.state;
  }
  return parameters;
}

/**
 * パラメータを redirect_uri のフラグメントに載せた URL を返す。
 * RFC 6749 §4.2.2 / OAuth 2.0 Multiple Response Type Encoding Practices §2.1: フラグメントの
 * 値は application/x-www-form-urlencoded で符号化する。値の無いパラメータは載せない。
 * redirect_uri のクエリはそのまま残す（RFC 6749 §3.1.2）。登録済みの redirect_uri は
 * フラグメントを含まない（{@link validateRegisteredRedirectUris}）。
 *
 * フラグメントはブラウザがサーバーへ送らず、Referer にも載らないため、Implicit Flow の
 * トークンはクライアントのページのスクリプトだけが読む。
 */
export function buildFragmentResponseUrl(
  redirectUri: string,
  parameters: Readonly<Record<string, string | undefined>>,
): string {
  const fragment = new URLSearchParams();
  for (const [name, value] of Object.entries(parameters)) {
    if (value) fragment.set(name, value);
  }
  const url = new URL(redirectUri);
  url.hash = fragment.toString();
  return url.toString();
}
