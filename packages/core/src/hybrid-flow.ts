/**
 * Hybrid Flow（OIDC Core 1.0 §3.3）
 *
 * Hybrid Flow では、認可エンドポイントが認可コードと一緒に ID Token（`code id_token`）、
 * アクセストークン（`code token`）、または両方（`code id_token token`）を返し、
 * クライアントはその認可コードをトークンエンドポイントで交換する（§3.3.3）。
 * 認可エンドポイントが返す応答の既定の応答モードはフラグメントで、query で返してはならない
 * （OAuth 2.0 Multiple Response Type Encoding Practices §5）。
 *
 * このモジュールは Hybrid Flow に固有の認可リクエストの検証（response_mode、nonce）と、
 * 認可エンドポイントが返すパラメータの組み立てを提供する。response_type の受理は
 * {@link validateResponseType}、認可コードの生成は {@link buildAuthorizationCodeData}、
 * ID Token とアクセストークンの発行は Authorization Code Flow と同じ部品（buildIdTokenPayload、
 * computeAtHash、computeCHash、buildAccessTokenPayload など）で行う。
 */
import { AuthorizationError, AuthorizationErrorCode } from './authorization-request.js';
import { requireNonce } from './implicit-flow.js';
import { responseTypeIncludes } from './response-type.js';

/**
 * `response_type` に応じて `nonce` を検証し、返す。
 *
 * `response_type` が `id_token` を含む（`code id_token` か `code id_token token`）なら、`nonce` は必須である（OIDC Core 1.0 §3.3.2.11）。
 * 認可エンドポイントから ID トークンを返すので、`nonce` をリプレイの検知に使う。
 * `nonce` がないか空文字列なら、リダイレクトで返せる `invalid_request` を投げる（{@link requireNonce}）。
 *
 * 認可エンドポイントが ID トークンを返さない `code token` では、認可コードフローと同じく `nonce` は任意で、受け取った値をそのまま返す（OpenID Connect Core 1.0 の正誤表の NonceNotes）。
 * OIDF の適合性テストの `oidcc-ensure-request-without-nonce-succeeds-for-code-flow` は、`code token` で `nonce` のないリクエストが成功することを確かめる。
 *
 * @spec OIDC Core 1.0 §3.3.2.11
 * @throws {AuthorizationError} `invalid_request`: `response_type` が `id_token` を含み、`nonce` がないか空文字列のとき（リダイレクトで返せる）
 */
export function requireHybridNonce(
  responseType: string,
  nonce: string | undefined,
  redirectUri: string,
  state?: string,
): string | undefined {
  if (!responseTypeIncludes(responseType, 'id_token')) return nonce;
  return requireNonce(nonce, redirectUri, state);
}

/**
 * ハイブリッドフローの `response_mode` を検証する。
 *
 * 次のように判定する。
 * - 指定がなければ、既定のレスポンスモード（フラグメント）で返すので、何もしない
 * - `query` は拒否する
 * - `supportedResponseModes`（OP がこのリクエストへの応答に使えるレスポンスモード）にない値も拒否する
 *
 * `query` を拒否するのは、`code id_token`、`code token`、`code id_token token` のレスポンスをクエリで返してはならない（MUST NOT）と OAuth 2.0 Multiple Response Type Encoding Practices §5 が定め、同 §7 が ID トークンとアクセストークンをクエリに含めることを禁じているためである。
 * 対応していない値を拒否するのは、要求されたレスポンスモードを、知らせずに別のモードに置き換えないためである。
 *
 * どちらの拒否も、リダイレクトで返せる `invalid_request` である。
 * 呼び出し側は、そのエラーをリクエストの既定のレスポンスモード（フラグメント）で返す（OIDC Core 1.0 §3.3.2.6）。
 *
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §5
 * @spec OIDC Core 1.0 §3.3.2.6
 * @throws {AuthorizationError} `invalid_request`: `response_mode` が `query` のとき、または `supportedResponseModes` にないとき
 */
export function validateHybridResponseMode(
  responseMode: string | undefined,
  supportedResponseModes: readonly string[],
  redirectUri: string,
  state?: string,
): void {
  if (responseMode === undefined) return;

  if (responseMode === 'query') {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'response_mode=query must not be used with the Hybrid Flow',
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
 * {@link buildHybridResponseParameters} の入力。
 */
export interface HybridResponseParametersInput {
  /** 発行した認可コード（OIDC Core 1.0 §3.3.2.5: 常に返す）。 */
  code: string;
  /** 発行した ID Token。response_type が `id_token` を含むときだけ渡す。 */
  idToken?: string;
  /** 発行したアクセストークン。response_type が `token` を含むときだけ渡す。 */
  accessToken?: string;
  /** アクセストークンの有効期間（秒）。 */
  expiresIn?: number;
  /** アクセストークンに付与した scope。 */
  scope?: string[];
  /** 認可リクエストの state。リクエストにあった場合は REQUIRED。 */
  state?: string;
}

/**
 * ハイブリッドフローの成功時のパラメータを返す。
 *
 * 認可レスポンスはインプリシットフロー（OIDC Core 1.0 §3.2.2.5）と同じ形で、認可コードが加わる。
 * 値はフラグメントやフォームに入るので、すべて文字列にする。
 * 含めるパラメータは次のとおりである。
 * - `code`: 常に含める
 * - `access_token`、`token_type`（`Bearer`）: アクセストークンを渡したときだけ含める
 * - `expires_in`、`scope`: アクセストークンを渡し、それぞれの値も渡したときだけ含める
 * - `id_token`: ID トークンを渡したときだけ含める
 * - `state`: 渡したときだけ含める
 *
 * 付与したスコープは要求と異なることがあるので、アクセストークンを発行したときは `scope` を常に渡す前提である（RFC 6749 §4.2.2）。
 *
 * リフレッシュトークンは含めない（RFC 6749 §4.2.2 の MUST NOT）。
 * リフレッシュトークンは、トークンエンドポイントが認可コードの交換で返す。
 * `iss`（RFC 9207 §2）は、レスポンスモードの処理が加える。
 *
 * @spec OIDC Core 1.0 §3.3.2.5
 */
export function buildHybridResponseParameters(
  input: HybridResponseParametersInput,
): Record<string, string> {
  const parameters: Record<string, string> = { code: input.code };
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
  if (input.idToken !== undefined) {
    parameters['id_token'] = input.idToken;
  }
  if (input.state !== undefined) {
    parameters['state'] = input.state;
  }
  return parameters;
}
