/**
 * What the authorization endpoint decides, and the authorization responses it
 * sends back to the client.
 */
import {
  sanitizeErrorDescription,
  type AuthorizationRequestParams,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import {
  plainQueryResponse,
  type AuthorizationResponse,
  type AuthorizationResponseMode,
} from './response-mode.js';

/** What the authorization endpoint decided; page.ts turns it into HTTP. */
export type AuthorizationOutcome =
  /** Malformed transport: OAuth error JSON (400), no transaction exists yet. */
  | { kind: 'bad_request'; error: string; errorDescription: string }
  /**
   * The authorization response for the client — code or redirectable error,
   * in the response mode the request asked for: a redirect, or a form the
   * browser posts.
   */
  | { kind: 'authorization_response'; response: AuthorizationResponse }
  /**
   * Interactive authentication is needed: continue on the login screen. cookies
   * carries the transaction cookie; transactionId is also carried in the screen URL.
   */
  | { kind: 'login'; transactionId: string; cookies: string[] }
  /** The End-User is signed in but consent is needed: continue on the consent screen. */
  | { kind: 'consent'; transactionId: string; cookies: string[] }
  /** OIDC Core 1.0 §3.1.2.2: the error cannot be redirected and stays on the OP. */
  | { kind: 'error'; error: string; errorDescription?: string }
  /** An unexpected failure: OAuth error JSON (500). */
  | { kind: 'server_error' };

/**
 * The request parameters as parsed: the fields OIDC Core 1.0 §3.1.2.1 names,
 * plus every other parameter the client sent.
 */
export type AuthorizationRequestInput = AuthorizationRequestParams & Record<string, string>;

/** The transaction the pipeline created, with the lifetime its cookie gets. */
export interface AuthorizationTransaction {
  transactionId: string;
  transaction: AuthTransaction;
  transactionTtlSeconds: number;
}

/**
 * `client_id` が文字列のオブジェクトなら `true` を返す。
 *
 * `true` のとき、引数の型を `AuthorizationRequestParams` に絞る。
 * 確かめるのは `client_id` だけで、PKCE のパラメータは後で core の関数が検証する。
 * そのため、OIDF の適合性テストとの互換モード（`allowNonPkceAuthorizationCodeFlow`）では、PKCE のパラメータを省いたリクエストを意図して通せる。
 */
export function isAuthorizationRequestParams(
  params: unknown,
): params is AuthorizationRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p['client_id'] === 'string';
}

/**
 * エラーの認可レスポンスを組み立てて返す。
 *
 * レスポンスには `error`、`error_description`、`state` を入れる。
 * `errorDescription` は省略でき、渡されたときは RFC 6749 §5.2 が許す文字以外を `?` に置き換えてから使う。
 * 説明文にリクエストの値が入っても、制御文字などをレスポンスに紛れ込ませないためである。
 *
 * `responseMode` が無ければ、値のあるパラメータをリダイレクト URI のクエリに設定し、`iss` も設定する（RFC 9207 §2）。
 * クライアントは `iss` で、レスポンスを作った発行者を確かめられる。
 *
 * リクエストが機能のレスポンスモードを求めていたとき（`responseMode` があるとき）は、同じパラメータをそのモードで返す。
 * 例えば JARM では、パラメータを一つの JWT に入れて署名し、その JWT の `iss` クレームで発行者を示す（RFC 9700 §2.1 は、発行者を示す仕組みとして JARM を認めている）。
 * `form_post` のレスポンスモードでは、`iss` を含むパラメータを HTML のフォームからブラウザに送らせる。
 *
 * @spec OIDC Core 1.0 §3.1.2.6
 * @spec RFC 6749 §4.1.2.1
 */
export async function buildErrorResponse(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  error: string,
  state: string | undefined,
  errorDescription: string | undefined,
  issuer: string,
): Promise<AuthorizationResponse> {
  // 説明文の、RFC 6749 §5.2 が許す文字以外を `?` に置き換える。
  // どのレスポンスモードで返す場合も、置き換えはここで一度だけ行う。
  const description = errorDescription
    ? sanitizeErrorDescription(errorDescription)
    : undefined;
  const parameters = { error, error_description: description, state };
  if (responseMode) {
    return responseMode.respond(redirectUri, parameters);
  }
  return plainQueryResponse(redirectUri, parameters, issuer);
}

/**
 * 認可コードを含む認可レスポンスを組み立てて返す。
 *
 * レスポンスには `code` と `state` を入れる。
 * `responseMode` が無ければ、値のあるパラメータをリダイレクト URI のクエリに設定し、`iss` も設定する。
 * リクエストが機能のレスポンスモードを求めていたとき（`responseMode` があるとき）は、同じパラメータをそのモードで返す。
 *
 * @spec OIDC Core 1.0 §3.1.2.5
 * @spec RFC 9207 §2
 */
export async function buildSuccessResponse(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  code: string,
  state: string | undefined,
  issuer: string,
): Promise<AuthorizationResponse> {
  const parameters = { code, state };
  if (responseMode) {
    return responseMode.respond(redirectUri, parameters);
  }
  return plainQueryResponse(redirectUri, parameters, issuer);
}
