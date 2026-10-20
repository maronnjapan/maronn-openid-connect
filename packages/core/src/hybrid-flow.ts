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
 * OIDC Core 1.0 §3.3.2.11: Hybrid Flow で認可エンドポイントが ID Token を返す response_type
 * （`code id_token` / `code id_token token`）では nonce が必須（ID Token を認可エンドポイントから
 * 返すため、リプレイの検知に使う）。認可エンドポイントが ID Token を返さない `code token` では、
 * Authorization Code Flow と同じく任意である（OpenID Connect Core 1.0 errata の NonceNotes。
 * OIDF Conformance Suite の oidcc-ensure-request-without-nonce-succeeds-for-code-flow は
 * `code token` で nonce の無い要求が成功することを確かめる）。
 *
 * 欠落と空文字は、リダイレクト可能な invalid_request とする。
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
 * Hybrid Flow の response_mode を検証する。
 *
 * - 指定が無ければ既定の応答モード（fragment）で返すので、何もしない
 * - `query` は拒否する。OAuth 2.0 Multiple Response Type Encoding Practices §5 は
 *   `code id_token`、`code token`、`code id_token token` の応答を query で返すことを禁じ
 *   （"the query encoding MUST NOT be used"）、§7 は ID Token とアクセストークンをクエリに
 *   載せることを禁じる
 * - supportedResponseModes（OP がこのリクエストに答える応答モード）に無い値も拒否する。
 *   要求された応答モードを黙って別のモードに置き換えない
 *
 * どの拒否もリダイレクト可能な invalid_request とする。呼び出し側は、エラーをリクエストの
 * 既定の応答モード（fragment）で返す（OIDC Core 1.0 §3.3.2.6）。
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
 * OIDC Core 1.0 §3.3.2.5: Hybrid Flow の成功応答のパラメータを組み立てる。
 * 認可レスポンスは Implicit Flow（§3.2.2.5）と同じ形で、認可コードが加わる。
 *
 * - code: 常に
 * - access_token / token_type（`Bearer`）/ expires_in: アクセストークンを発行したときだけ
 * - scope: 付与した scope（RFC 6749 §4.2.2。要求と異なりうるため、アクセストークンを
 *   発行したときは常に含める）
 * - id_token: ID Token を発行したときだけ
 * - state
 *
 * Refresh Token は含めない（RFC 6749 §4.2.2: MUST NOT。トークンエンドポイントが認可コードの
 * 交換で返す）。iss（RFC 9207 §2）は応答モードが加える。値はすべて文字列（応答は
 * フラグメントやフォームに載る）。
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
