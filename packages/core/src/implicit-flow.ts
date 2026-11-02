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
 * `nonce` があればそのまま返す。
 *
 * インプリシットフローの認可リクエストでは、`nonce` が必須である（OIDC Core 1.0 §3.2.2.1）。
 * 認可エンドポイントから ID トークンを返すので、`nonce` をリプレイの検知に使う。
 *
 * @spec OIDC Core 1.0 §3.2.2.1
 * @throws {AuthorizationError} `invalid_request`: `nonce` がないか空文字列のとき（リダイレクトで返せる）
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
 * `redirect_uri` が `http` なら原則として拒否する。
 *
 * インプリシットフローの `redirect_uri` は、`http` のスキームを使ってはならない（OIDC Core 1.0 §3.2.2.1）。
 * 例外はネイティブアプリで、ホスト名がループバック（`localhost`、`127.` で始まる IPv4 アドレス、`[::1]`）の `http` は使ってよい。
 * トークンが TLS で保護されない通信を通らないようにするための規則である。
 * スキームが `http` でなければ、何も確かめない。
 *
 * この OP のクライアントの情報には `application_type`（OIDC Dynamic Client Registration 1.0 §2）がないので、パブリッククライアント（OAuth 2.1 §2.1）をネイティブアプリとして扱う。
 * `clientType` が登録されていないクライアントは、コンフィデンシャルクライアントとして扱う。
 *
 * `redirect_uri` は、登録済みの値と照合してから渡す。
 * 違反は、その `redirect_uri` へ返す `invalid_request` にする（エラーレスポンスはトークンを含まない）。
 *
 * @spec OIDC Core 1.0 §3.2.2.1
 * @throws {AuthorizationError} `invalid_request`: スキームが `http` で、パブリッククライアントのループバックの URL でもないとき（リダイレクトで返せる）
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
 * インプリシットフローの `response_mode` を検証する。
 *
 * 次のように判定する。
 * - 指定がなければ、既定のレスポンスモード（フラグメント）で返すので、何もしない
 * - `query` は拒否する
 * - `supportedResponseModes`（OP がこのリクエストへの応答に使えるレスポンスモード）にない値も拒否する
 *
 * `query` を拒否するのは、`id_token` と `id_token token` のレスポンスをクエリで返してはならない（MUST NOT）と OAuth 2.0 Multiple Response Type Encoding Practices §3 と §5 が定め、同 §7 が ID トークンとアクセストークンをクエリに含めることを禁じているためである。
 * 対応していない値を拒否するのは、要求されたレスポンスモードを、知らせずに別のモードに置き換えないためである。
 *
 * どちらの拒否も、リダイレクトで返せる `invalid_request` である。
 * 呼び出し側は、そのエラーをリクエストの既定のレスポンスモード（フラグメント）で返す（OIDC Core 1.0 §3.2.2.6）。
 *
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §3
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §5
 * @spec OIDC Core 1.0 §3.2.2.6
 * @throws {AuthorizationError} `invalid_request`: `response_mode` が `query` のとき、または `supportedResponseModes` にないとき
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
 * `response_type` が `id_token` だけなら true を返す。
 *
 * 正確には、`response_type` が `id_token` を含み、`token` も `code` も含まないときに true を返す。
 * このときはアクセストークンを発行しないので、スコープの値（`profile`、`email`、`address`、`phone`）が要求するクレームを ID トークンで返す（OIDC Core 1.0 §5.4）。
 * アクセストークンを発行する `response_type` では、それらのクレームは UserInfo エンドポイントが返す。
 * `token` を含む `response_type` では認可エンドポイントが、`code` を含む `response_type`（ハイブリッドフローの `code id_token` など）ではトークンエンドポイントがアクセストークンを発行する。
 *
 * @spec OIDC Core 1.0 §5.4
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
 * インプリシットフローの成功時のパラメータを返す。
 *
 * 値はフラグメントやフォームに入るので、すべて文字列にする。
 * 含めるパラメータは次のとおりである。
 * - `access_token`、`token_type`（`Bearer`）: アクセストークンを渡したときだけ含める
 * - `expires_in`、`scope`: アクセストークンを渡し、それぞれの値も渡したときだけ含める
 * - `id_token`: 常に含める
 * - `state`: 渡したときだけ含める
 *
 * 付与したスコープは要求と異なることがあるので、アクセストークンを発行したときは `scope` を常に渡す前提である（RFC 6749 §4.2.2）。
 *
 * リフレッシュトークンは含めない（RFC 6749 §4.2.2 の MUST NOT）。
 * `iss`（RFC 9207 §2）は、レスポンスモードの処理が加える。
 *
 * @spec OIDC Core 1.0 §3.2.2.5
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
 * パラメータをフラグメントに入れた URL を返す。
 *
 * パラメータは `application/x-www-form-urlencoded` の形式で符号化し、`redirect_uri` のフラグメントにする（RFC 6749 §4.2.2、OAuth 2.0 Multiple Response Type Encoding Practices §2.1）。
 * 値が `undefined` か空文字列のパラメータは含めない。
 * `redirect_uri` のクエリはそのまま残す（RFC 6749 §3.1.2）。
 * 登録済みの `redirect_uri` はフラグメントを含まない（{@link validateRegisteredRedirectUris}）。
 *
 * ブラウザはフラグメントをサーバーへ送らず、`Referer` にも含めないので、インプリシットフローのトークンを読めるのはクライアントのページのスクリプトだけになる。
 *
 * @spec RFC 6749 §4.2.2
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §2.1
 * @throws {TypeError} `redirectUri` を URL として解析できないとき
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
