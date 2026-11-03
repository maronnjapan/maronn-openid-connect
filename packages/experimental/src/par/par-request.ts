/**
 * Pushed Authorization Requests (PAR) — RFC 9126 §2
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * PAR エンドポイントの処理。「合成関数＋ステップ関数」の二層構成とし、
 * CLI 生成コードはステップ関数を順に呼び出して処理を組み立てられるようにする。
 */
import {
  AuthorizationError,
  AuthorizationErrorCode,
  TokenError,
  TokenErrorCode,
  extractClientCredentials,
  generateRandomString,
  parseClaimsRequestParameter,
  rejectUnsupportedRequestParams,
  resolveAuthenticatedTokenClient,
  resolveAuthorizationRedirectUri,
  resolveClientForAuthorization,
  resolveMaxAge,
  sanitizeErrorDescription,
  validateAuthorizationCodePkce,
  validateAuthorizationScope,
  validateClientAuthMethod,
  validateDisplayParameter,
  validatePromptParameter,
  validateRegisteredRedirectUris,
  validateResponseType,
  verifyClientSecret,
  type AuthorizationRequestParams,
  type ClientResolver,
  type TokenClientResolver,
} from '@maronn-openid-connect/core';
import { PAR_REQUEST_URI_PREFIX } from './store.js';
import type {
  PushedAuthorizationRecord,
  PushedAuthorizationRequestStore,
} from './store.js';

/**
 * PAR エンドポイントのエラーコード。
 * RFC 9126 §2.3: token endpoint と同じ形式のエラーレスポンスを返す。
 */
export type ParErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_scope'
  | 'unauthorized_client'
  | 'unsupported_response_type';

/**
 * PAR エンドポイントのエラー。
 *
 * バックチャネルのエンドポイントなのでリダイレクトは行わず、常に JSON で返す
 * （リダイレクト先情報を持たないのは意図的な設計）。
 */
export class ParError extends Error {
  readonly code: ParErrorCode;
  readonly errorDescription: string;

  constructor(code: ParErrorCode, errorDescription: string) {
    // RFC 6749 §5.2: error_description は安全な文字集合に限定する。
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'ParError';
    this.code = code;
    this.errorDescription = sanitized;
  }

  /** RFC 6749 §5.2: クライアント認証失敗のみ 401、それ以外は 400。 */
  get statusCode(): 400 | 401 {
    return this.code === 'invalid_client' ? 401 : 400;
  }

  /** RFC 6749 §5.2: 401 の場合のみ Basic チャレンジを返す（token endpoint と同挙動）。 */
  get wwwAuthenticate(): string | undefined {
    return this.code === 'invalid_client' ? 'Basic realm="Client Authentication"' : undefined;
  }
}

/** PAR エンドポイントの成功レスポンス（RFC 9126 §2.2）。 */
export interface PushedAuthorizationResponse {
  /** `urn:ietf:params:oauth:request_uri:<reference-value>` */
  requestUri: string;
  /** request_uri の有効期間（秒） */
  expiresIn: number;
}

/** {@link validatePushedAuthorizationParams} のオプション。 */
export interface PushedAuthorizationValidationOptions {
  /**
   * OIDF Basic OP static-client conformance 互換。true かつ confidential client が
   * PKCE を完全に省略した場合だけ省略を許容する。認可エンドポイントと同じ値を渡すこと。
   */
  allowNonPkceAuthorizationCodeFlow?: boolean;
  /**
   * `claims` パラメータ（OIDC Core 1.0 §5.5）を `JSON.parse` する前に課す最大長。
   * 未指定なら core の `DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH`。
   */
  maxClaimsParameterLength?: number;
}

/** PAR エンドポイント処理のコンテキスト。 */
export interface PushedAuthorizationRequestContext {
  /** フォームボディのパラメータ（application/x-www-form-urlencoded） */
  params: Record<string, string>;
  /** Authorization ヘッダの値（client_secret_basic 用）。無ければ空文字 */
  authorizationHeader?: string;
  /** クライアント解決。認可リクエスト検証とクライアント認証の両方に使う */
  clientResolver: ClientResolver & TokenClientResolver;
  store: PushedAuthorizationRequestStore;
  /** {@link validatePushedAuthorizationParams} へ渡すオプション */
  validationOptions: PushedAuthorizationValidationOptions;
  /** request_uri の有効期間（秒）。既定 60、許容範囲 5〜600 */
  expiresInSeconds?: number;
  /** 現在時刻。テストと決定的な期限計算のために注入できる */
  now?: Date;
}

/** RFC 9126 §2.2: expires_in は "typically ... between 5 and 600 seconds"。 */
const MIN_EXPIRES_IN_SECONDS = 5;
const MAX_EXPIRES_IN_SECONDS = 600;
const DEFAULT_EXPIRES_IN_SECONDS = 60;

/** RFC 9126 §2.2 / §7.1: 参照値は暗号論的乱数で生成する（32 バイト = 256 ビット）。 */
const REFERENCE_VALUE_BYTE_LENGTH = 32;

/**
 * 有効期間が 5〜600 秒の整数でなければ例外を投げる。
 *
 * 検証するのは `request_uri` の有効期間（秒）で、範囲は RFC 9126 §2.2 が典型的な値として挙げる 5〜600 秒である。
 * 生成されたコードは設定を読み込むとき（起動時）にこの関数を呼び、範囲外の設定では、リクエストを処理する前に失敗させる。
 *
 * @throws {RangeError} 5〜600 の整数でないとき
 * @spec RFC 9126 §2.2
 */
export function assertParExpiresInSeconds(seconds: number): void {
  const isValid =
    Number.isInteger(seconds) &&
    seconds >= MIN_EXPIRES_IN_SECONDS &&
    seconds <= MAX_EXPIRES_IN_SECONDS;
  if (!isValid) {
    throw new RangeError(
      `expiresInSeconds must be an integer between ${MIN_EXPIRES_IN_SECONDS} and ${MAX_EXPIRES_IN_SECONDS} (RFC 9126 §2.2), received ${seconds}`,
    );
  }
}

/**
 * `request_uri` か `request` があれば例外を投げる。
 *
 * どちらも、PAR のリクエストボディに含めてはならないパラメータとして拒否する。
 * - `request_uri` は、PAR のリクエストに含めてはならない（RFC 9126 §2.1 の MUST NOT）。
 * - `request`（リクエストオブジェクト、JAR）は、PAR と併用する機能をこの実装が持たないので拒否する。
 *
 * @throws {ParError} `invalid_request`: `request_uri` か `request` が含まれるとき
 * @spec RFC 9126 §2.1
 */
export function rejectForbiddenParParams(params: Record<string, string>): void {
  if (params['request_uri'] !== undefined) {
    throw new ParError(
      'invalid_request',
      'request_uri MUST NOT be included in a pushed authorization request',
    );
  }
  if (params['request'] !== undefined) {
    throw new ParError(
      'invalid_request',
      'The request parameter (Request Object) is not supported by this pushed authorization request endpoint',
    );
  }
}

/**
 * クライアントを認証し、そのクライアント ID を返す。
 *
 * 認証の規則はトークンエンドポイントと同じである（RFC 9126 §2.1）。
 * ボディからは `client_id` と `client_secret` だけを使い、認証情報の取り出し、複数の認証方式の判定、検証は、core の {@link extractClientCredentials} から始まる関数にすべて任せる。
 * そのため、次の規則もトークンエンドポイントと同じになる:
 * - `Authorization` ヘッダーは `Basic` スキームだけを認証に使う。
 *   ほかのスキームのヘッダー（ゲートウェイが付ける `Bearer` など）は無視し、ボディの認証情報で認証する。
 * - 空文字列の `client_secret` は、送られなかったものとして扱う（RFC 6749 §3.2）。
 * - `Basic` ヘッダーと、ボディの空でない `client_secret` を両方送ると、複数の認証方式を使ったとして `invalid_request` にする（OAuth 2.1 §2.3）。
 * - ボディの `client_id`（RFC 9126 §2.1 で認可リクエストのパラメータとして必須）を `Basic` ヘッダーと一緒に送ったときは、core が `Basic` ヘッダーのクライアント ID と一致することを確かめる。
 *   `request_uri` は、PAR のリクエストを送ったクライアントに結び付くためである（RFC 9126 §2.2）。
 *
 * @returns 認証したクライアントの ID
 * @throws {ParError} `invalid_client`: 認証に失敗したとき（クライアント ID がない、クライアントが登録されていない、シークレットが一致しないなど）
 * @throws {ParError} `invalid_request`: 複数の認証方式を使ったとき、ボディの `client_id` が `Basic` ヘッダーと食い違うとき
 * @spec RFC 9126 §2.1
 */
export async function authenticateParClient(context: {
  params: Record<string, string>;
  authorizationHeader?: string;
  clientResolver: TokenClientResolver;
}): Promise<string> {
  const { params, clientResolver } = context;
  return runClientAuthentication({
    params: { client_id: params['client_id'], client_secret: params['client_secret'] },
    authorizationHeader: context.authorizationHeader ?? '',
    clientResolver,
  });
}

/**
 * core の関数でクライアントを認証し、ID を返す。
 *
 * core の関数を、認証情報の取り出し、クライアントの取得、認証方式の照合、シークレットの照合の順に呼び、提示されたクライアント ID を返す。
 * core が投げた `TokenError` は `ParError` に変換して投げ、それ以外の例外はそのまま投げる。
 *
 * @throws {ParError} クライアント認証に失敗したとき
 */
async function runClientAuthentication(context: {
  params: Record<string, string | undefined>;
  authorizationHeader: string;
  clientResolver: TokenClientResolver;
}): Promise<string> {
  try {
    const presented = extractClientCredentials({
      params: context.params,
      authorizationHeader: context.authorizationHeader,
    });
    const client = await resolveAuthenticatedTokenClient(presented.clientId, context.clientResolver);
    validateClientAuthMethod(client, presented);
    await verifyClientSecret(client, presented.clientSecret);
    return presented.clientId;
  } catch (error) {
    throw toParError(error);
  }
}

/**
 * パラメータを認可エンドポイントと同じ規則で検証する。
 *
 * 認可サーバーは、PAR のリクエストを、認可エンドポイントに送られた認可リクエストと同じように検証しなければならない（RFC 9126 §2.1 の MUST）。
 *
 * 認可エンドポイントの生成されたコードと同じ順序で core の関数を呼び、パラメータを拒否する検証だけを行う。
 * `scope` の絞り込みのように値を組み立てる処理は、`request_uri` を展開した後に認可エンドポイントが行う。
 * PAR はリクエストオブジェクト（`request`）と併用しないので（{@link rejectForbiddenParParams}）、`request` は解析せずに拒否する。
 *
 * core が投げた `AuthorizationError` と `TokenError` は {@link ParError} に変換して投げ、リダイレクトはしない（RFC 9126 §2.3）。
 * core の `request_not_supported` のように PAR にないエラーコードは、`invalid_request` になる。
 * それ以外の例外（クライアントのリゾルバが投げた例外など）は、変換せずにそのまま投げる。
 *
 * @throws {ParError} パラメータの検証に失敗したとき
 * @spec RFC 9126 §2.1
 * @spec RFC 9126 §2.3
 */
export async function validatePushedAuthorizationParams(
  params: Record<string, string>,
  clientResolver: ClientResolver,
  options: PushedAuthorizationValidationOptions = {},
): Promise<void> {
  const request = params as unknown as AuthorizationRequestParams;
  try {
    const client = await resolveClientForAuthorization(request, clientResolver);
    validateRegisteredRedirectUris(client.redirectUris);
    const redirectUri = resolveAuthorizationRedirectUri(request, client);
    const state = request.state;
    rejectUnsupportedRequestParams(request, redirectUri, state, {
      requestParameterSupported: false,
    });
    validateResponseType(request, client, redirectUri, state);
    validateAuthorizationScope(request, request, redirectUri, state);
    validateAuthorizationCodePkce(request, client, redirectUri, state, {
      allowNonPkceAuthorizationCodeFlow: options.allowNonPkceAuthorizationCodeFlow,
    });
    validatePromptParameter(request, redirectUri, state);
    validateDisplayParameter(request, redirectUri, state);
    resolveMaxAge(request, client, redirectUri, state);
    parseClaimsRequestParameter(request, redirectUri, state, options.maxClaimsParameterLength);
  } catch (error) {
    throw toParError(error);
  }
}

/**
 * 保存対象から必ず除外するクライアント認証パラメータ。
 *
 * PAR ボディはクライアント認証情報と認可リクエストパラメータが同居する。認証情報を
 * レコードへ残すと、シークレットがストア（永続層・ログ・バックアップ）に残り、さらに
 * 認可エンドポイントで展開されたパラメータにも混入する。認証は保存前に完了しているため
 * 保持する必要はない。
 */
const CLIENT_AUTHENTICATION_PARAMS = ['client_secret', 'client_assertion', 'client_assertion_type'];

/**
 * `request_uri` を発行し、レコードを保存して返す。
 *
 * `request_uri` は、URN の接頭辞に、32 バイトの暗号論的な乱数を base64url にした参照値を付けた値である（RFC 9126 §2.2、§7.1）。
 * 有効期限は、作成時刻（`now`、既定は現在時刻）に `expiresInSeconds`（既定は 60 秒）を足した時刻である。
 * `expiresInSeconds` は {@link assertParExpiresInSeconds} で検証する。
 *
 * `params` の `client_id` は認証したクライアントの値（`clientId`）で置き換えて保存し、クライアント認証のパラメータ（`client_secret`、`client_assertion`、`client_assertion_type`）は保存しない。
 * 保存しないのは、シークレットがストアに残り（ログやバックアップにも残り）、認可エンドポイントで展開したパラメータにも混ざるのを防ぐためである。
 * 認証は保存の前に済んでいるので、保存しておく必要もない。
 * 呼び出し側が渡したオブジェクトは変更しない。
 *
 * @throws {RangeError} `expiresInSeconds` が 5〜600 の整数でないとき
 * @spec RFC 9126 §2.2
 */
export async function createPushedAuthorizationRecord(options: {
  clientId: string;
  params: Record<string, string>;
  store: PushedAuthorizationRequestStore;
  expiresInSeconds?: number;
  now?: Date;
}): Promise<PushedAuthorizationRecord> {
  const expiresInSeconds = options.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
  assertParExpiresInSeconds(expiresInSeconds);

  const storedParams: Record<string, string> = { ...options.params, client_id: options.clientId };
  for (const name of CLIENT_AUTHENTICATION_PARAMS) {
    delete storedParams[name];
  }

  const createdAt = options.now ?? new Date();
  const record: PushedAuthorizationRecord = {
    requestUri: PAR_REQUEST_URI_PREFIX + generateRandomString(REFERENCE_VALUE_BYTE_LENGTH),
    clientId: options.clientId,
    params: storedParams,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + expiresInSeconds * 1000),
  };
  await options.store.save(record);
  return record;
}

/**
 * レコードから 201 レスポンスのボディを組み立てて返す。
 *
 * `requestUri` にはレコードの `requestUri` を、`expiresIn` には有効期限と作成時刻の差を秒に丸めた値を入れる。
 *
 * @spec RFC 9126 §2.2
 */
export function buildPushedAuthorizationResponse(
  record: PushedAuthorizationRecord,
): PushedAuthorizationResponse {
  return {
    requestUri: record.requestUri,
    expiresIn: Math.round((record.expiresAt.getTime() - record.createdAt.getTime()) / 1000),
  };
}

/**
 * PAR のリクエストを処理し、レスポンスのボディを返す。
 *
 * 禁止されたパラメータの拒否、クライアント認証、パラメータの検証、レコードの保存、レスポンスの組み立てを、この順に行う。
 * それぞれ、このファイルのほかの関数を呼ぶだけである。
 *
 * 生成されたコードは、通常この関数を使わずに、それぞれの関数を順に呼ぶ。
 * 検証を差し替えたり取り除いたりできるようにするためである。
 *
 * @throws {ParError} どれかの処理が失敗したとき
 * @throws {RangeError} `expiresInSeconds` が 5〜600 の整数でないとき
 * @spec RFC 9126 §2
 */
export async function handlePushedAuthorizationRequest(
  context: PushedAuthorizationRequestContext,
): Promise<PushedAuthorizationResponse> {
  rejectForbiddenParParams(context.params);

  const clientId = await authenticateParClient({
    params: context.params,
    authorizationHeader: context.authorizationHeader,
    clientResolver: context.clientResolver,
  });

  // `client_id` を、認証したクライアントの値に置き換えてから検証する。
  // ボディに `client_id` がないときも、検証で `client_id` を使えるようにするためである。
  const params = { ...context.params, client_id: clientId };
  await validatePushedAuthorizationParams(params, context.clientResolver, context.validationOptions);

  const record = await createPushedAuthorizationRecord({
    clientId,
    params,
    store: context.store,
    expiresInSeconds: context.expiresInSeconds,
    now: context.now,
  });

  return buildPushedAuthorizationResponse(record);
}

/**
 * core のエラーを `ParError` に変換して返す。
 *
 * `ParError` はそのまま返し、`TokenError` と `AuthorizationError` は、エラーコードを変換し、説明（`errorDescription`）を引き継いだ `ParError` にする。
 * それ以外の例外は、変換せずにそのまま返す。
 * 呼び出し側はそれをそのまま投げるので、例外は失われず、500 として扱われる。
 */
function toParError(error: unknown): unknown {
  if (error instanceof ParError) return error;
  if (error instanceof TokenError) return new ParError(toParErrorCodeFromToken(error.error), error.errorDescription);
  if (error instanceof AuthorizationError) {
    return new ParError(toParErrorCodeFromAuthorization(error.error), error.errorDescription);
  }
  return error;
}

/**
 * `TokenError` のコードを PAR 用に変換して返す。
 *
 * `invalid_client`、`unauthorized_client`、`invalid_scope` は同じコードを返し、それ以外（`invalid_grant`、`unsupported_grant_type` など）はすべて `invalid_request` にする。
 *
 * @spec RFC 9126 §2.3
 */
function toParErrorCodeFromToken(code: TokenErrorCode): ParErrorCode {
  switch (code) {
    case TokenErrorCode.InvalidClient:
      return 'invalid_client';
    case TokenErrorCode.UnauthorizedClient:
      return 'unauthorized_client';
    case TokenErrorCode.InvalidScope:
      return 'invalid_scope';
    default:
      return 'invalid_request';
  }
}

/**
 * `AuthorizationError` のコードを PAR 用に変換して返す。
 *
 * `invalid_scope`、`unauthorized_client`、`unsupported_response_type` は同じコードを返し、それ以外（`login_required` などのユーザーの操作が必要なことを示すコードや、`invalid_request_object` など）はすべて `invalid_request` にする。
 *
 * @spec RFC 9126 §2.3
 */
function toParErrorCodeFromAuthorization(code: AuthorizationErrorCode): ParErrorCode {
  switch (code) {
    case AuthorizationErrorCode.InvalidScope:
      return 'invalid_scope';
    case AuthorizationErrorCode.UnauthorizedClient:
      return 'unauthorized_client';
    case AuthorizationErrorCode.UnsupportedResponseType:
      return 'unsupported_response_type';
    default:
      // 残りのコードは、すべて `invalid_request` にする。
      // RFC 9126 §2.3 は PAR 固有のエラーコードを追加していない。
      // 認可エンドポイント固有の、ユーザーの操作が必要なことを示すコード（`login_required` など）は、PAR のリクエストの検証では発生しない。
      return 'invalid_request';
  }
}
