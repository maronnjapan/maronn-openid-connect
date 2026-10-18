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
 * request_uri の有効期間が RFC 9126 §2.2 の推奨レンジ内かを検証する。
 *
 * 生成コードは設定値の読み込み時（= 起動時）にこれを呼び、範囲外の設定を
 * リクエスト処理前に失敗させる。
 *
 * @throws {RangeError} 5〜600 の整数でない場合
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
 * ステップ 1: PAR ボディに含めてはならないパラメータを拒否する。
 *
 * - `request_uri`: RFC 9126 §2.1 の MUST NOT
 * - `request`: PAR と Request Object (JAR) の併用は本機能の非目標
 *
 * @throws {ParError} invalid_request
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
 * ステップ 2: クライアントを認証する（RFC 9126 §2.1: token endpoint と同一規則）。
 *
 * 資格情報の抽出・多重方式の判定・検証はすべて core の
 * {@link extractClientCredentials} 以降のステップへ委譲し、token endpoint と
 * 同一の規則を適用する:
 *
 * - ヘッダ認証は `Basic` スキームだけが対象で、他スキームのヘッダ（ゲートウェイが
 *   注入する `Bearer` など）は無視してボディの資格情報で認証する
 * - 空文字列の `client_secret` は「未提示」に正規化される（RFC 6749 §3.2）
 * - `Basic` とボディの `client_secret`（非空）の併用は OAuth 2.1 §2.3 の
 *   多重方式として invalid_request
 * - RFC 9126 §2.1 で必須の認可パラメータとしてボディに入る `client_id` は、
 *   `Basic` 併用時に core が Basic 側の client_id との一致を検証する
 *   （RFC 9126 §2.2: request_uri は pushed request を送ったクライアントに紐付く）
 *
 * @returns 認証されたクライアントID
 * @throws {ParError} invalid_client / invalid_request
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
 * core のクライアント認証ステップ関数を仕様順に実行し、TokenError を ParError へ写す。
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
 * ステップ 3: pushed されたパラメータを、認可エンドポイントと同じ規則で検証する。
 *
 * RFC 9126 §2.1: "The authorization server ... MUST validate the request as it would
 * an authorization request sent to the authorization endpoint."
 *
 * 認可エンドポイントの生成コードと同じ順序で core のステップ関数を呼び、パラメータを
 * 拒否するものだけを実行する（scope の絞り込みなど値を組み立てる処理は、request_uri を
 * 展開した認可エンドポイントが行う）。PAR は Request Object（`request`）と併用しない
 * （{@link rejectForbiddenParParams}）ため、`request` はパースせず request_not_supported
 * として拒否する。
 *
 * 失敗は必ず {@link ParError} になり、リダイレクトはしない（RFC 9126 §2.3）。
 *
 * @throws {ParError}
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
 * ステップ 4: 参照値（URN）を生成してレコードを保存する（RFC 9126 §2.2）。
 *
 * `params` の `client_id` は認証済みクライアントの値に正規化して保存し、クライアント
 * 認証パラメータ（`client_secret` 等）は保存しない。
 * 呼び出し側が渡したオブジェクトは変更しない。
 *
 * @throws {RangeError} expiresInSeconds が RFC 9126 §2.2 の推奨レンジ外
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

/** ステップ 5: 201 レスポンスのボディを組み立てる（RFC 9126 §2.2）。 */
export function buildPushedAuthorizationResponse(
  record: PushedAuthorizationRecord,
): PushedAuthorizationResponse {
  return {
    requestUri: record.requestUri,
    expiresIn: Math.round((record.expiresAt.getTime() - record.createdAt.getTime()) / 1000),
  };
}

/**
 * 合成関数: PAR エンドポイントの全処理（RFC 9126 §2）。
 *
 * 個々のステップ関数を仕様順に合成しただけの API。生成コードは通常この関数ではなく
 * ステップ関数を順に呼び出し、検証の差し替え・削除ができるようにする。
 *
 * @throws {ParError}
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

  // client_id を認証済みの値に正規化してから検証する（ボディ省略時にも成立させる）。
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
 * core のエラーを PAR エンドポイントのエラーへ写す。
 *
 * 未知の例外はそのまま再スローし、握りつぶさない（呼び出し側が 500 として扱う）。
 */
function toParError(error: unknown): unknown {
  if (error instanceof ParError) return error;
  if (error instanceof TokenError) return new ParError(toParErrorCodeFromToken(error.error), error.errorDescription);
  if (error instanceof AuthorizationError) {
    return new ParError(toParErrorCodeFromAuthorization(error.error), error.errorDescription);
  }
  return error;
}

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

function toParErrorCodeFromAuthorization(code: AuthorizationErrorCode): ParErrorCode {
  switch (code) {
    case AuthorizationErrorCode.InvalidScope:
      return 'invalid_scope';
    case AuthorizationErrorCode.UnauthorizedClient:
      return 'unauthorized_client';
    case AuthorizationErrorCode.UnsupportedResponseType:
      return 'unsupported_response_type';
    default:
      // RFC 9126 §2.3 は PAR 固有のエラーコードを追加しない。認可エンドポイント固有の
      // インタラクション系コード（login_required 等）は pushed request の検証では
      // 発生しないため、残りは invalid_request に集約する。
      return 'invalid_request';
  }
}
