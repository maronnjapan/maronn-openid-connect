/**
 * 認証リクエストコンテキスト復元
 * Authentication Requestの受信から認可コード発行までの間のコンテキストを管理する
 *
 * 動的パス方式（Auth Transaction ID方式）により、
 * サーバーサイドKVストアにAuthentication Requestパラメータを一時保存し、
 * ランダム生成されたIDをURLパスに埋め込むことで認証フロー全体を通じてコンテキストを維持する。
 */

import { AuthorizationError, AuthorizationErrorCode } from './authorization-request.js';
import type { ValidatedAuthorizationRequest } from './authorization-request.js';
import { sha256, timingSafeEqual } from './crypto-utils.js';
import { splitScope } from './scope.js';
import type { ClaimsParameter } from './userinfo.js';

// --- Session Types ---

export interface SessionInfo {
  subject: string;
  authTime: number;
  /**
   * このセッションの識別子（任意）。
   * online refresh token（`offline_access` 無しで発行する Refresh Token）を
   * このセッションへ束縛するために、認可コードへ引き継ぐ値。
   * セッション識別子を外部へ出したくない実装は省略してよく、その場合は
   * online refresh token が発行されない（offline_access のみで発行される）。
   */
  sessionId?: string;
}

export interface SessionResolver {
  resolve(request: Request): Promise<SessionInfo | null>;
}

/**
 * コンセント済みかどうかを解決するインターフェース
 * OIDC Core 1.0 Section 3.1.2.1: prompt=none ではコンセント済みでない場合
 * consent_required を返す必要がある。
 */
export interface ConsentResolver {
  /**
   * 要求スコープが付与済みスコープの部分集合（要求 ⊆ 付与）のときのみ true。
   * 部分一致を true としてはならない（MUST NOT）。未承認スコープを承認済みと
   * 誤認すると、ユーザーが許可していないスコープへ暗黙に昇格してしまうため。
   */
  hasConsent(subject: string, clientId: string, scopes: string[]): Promise<boolean>;
  /**
   * subject が clientId に対して scopes を承認したことを記録する（既存の付与済み
   * スコープにマージする）。任意実装: 同意を永続化せず毎回同意を求める実装では
   * 省略してよい。OIDC Core 1.0 Section 3.1.2.4。
   */
  recordConsent?(subject: string, clientId: string, scopes: string[]): Promise<void>;
  /**
   * subject が clientId に付与した同意をすべて失効させる。任意実装。
   */
  revokeConsent?(subject: string, clientId: string): Promise<void>;
}

// --- Error Types ---

/**
 * Auth Transactionのエラーコード
 */
export enum AuthTransactionErrorCode {
  TransactionNotFound = 'transaction_not_found',
  TransactionExpired = 'transaction_expired',
  InvalidCsrfToken = 'invalid_csrf_token',
  MaxAttemptsExceeded = 'max_attempts_exceeded',
  /**
   * トランザクションが、それを開始した User-Agent 以外から提示された。
   * 詳細は {@link validateTransactionBinding}。
   */
  InvalidTransactionBinding = 'invalid_transaction_binding',
}

/**
 * Auth Transactionのエラー
 */
export class AuthTransactionError extends Error {
  public readonly code: AuthTransactionErrorCode;

  constructor(code: AuthTransactionErrorCode, message: string) {
    super(message);
    this.name = 'AuthTransactionError';
    this.code = code;
  }

  /**
   * HTTPステータスコード
   */
  get httpStatusCode(): number {
    switch (this.code) {
      case AuthTransactionErrorCode.TransactionNotFound:
        return 400;
      case AuthTransactionErrorCode.TransactionExpired:
        return 400;
      case AuthTransactionErrorCode.InvalidCsrfToken:
        return 403;
      case AuthTransactionErrorCode.MaxAttemptsExceeded:
        return 429;
      // 束縛不一致は「このトランザクションの持ち主か確認できていない」状態であり、
      // 認証情報の誤りではないため 403 ではなく 400 で止める。
      case AuthTransactionErrorCode.InvalidTransactionBinding:
        return 400;
    }
  }
}

// --- Data Types ---

/**
 * Auth Transaction
 * Authentication Requestのコンテキストを保持するデータ構造
 */
export interface AuthTransaction {
  // Authentication Requestパラメータ（必須）
  clientId: string;
  redirectUri: string;
  /**
   * 認可リクエストで redirect_uri が明示されていたか。
   * OIDC Core 1.0 Section 3.1.3.2: 明示時は Token Endpoint で MUST 一致。
   */
  redirectUriExplicit: boolean;
  responseType: string;
  scope: string;
  state?: string;

  // Authentication Requestパラメータ（任意）
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  prompt?: string;
  maxAge?: number;
  acrValues?: string;
  loginHint?: string;
  /** OIDC Core 1.0 §3.1.2.1: preferred languages for the login/consent UI (BCP47, space-delimited). OP MAY honor. */
  uiLocales?: string;
  /** OIDC Core 1.0 §5.2: preferred languages for claim values (BCP47, space-delimited). */
  claimsLocales?: string;
  idTokenHint?: string;
  audience?: string[];
  /** OIDC Core 1.0 §5.5: parsed claims request, propagated to the auth code. */
  claims?: ClaimsParameter;

  // トランザクションメタデータ
  csrfToken: string;
  createdAt: number;   // Unix timestamp (ms)
  expiresAt: number;   // Unix timestamp (ms)
  failedAttempts: number;
  /**
   * トランザクションを開始した User-Agent に配る秘密値のハッシュ（SHA-256, base64url）。
   * Cookie 値そのものを保存しないことで、store 漏洩だけでは横取りできないようにする。
   * User-Agent への束縛を使わない構成では設定しない。設定のないトランザクションは
   * {@link validateTransactionBinding} が拒否する。
   */
  bindingHash?: string;
}

/**
 * Auth Transaction Store インターフェース
 * KVストアの抽象化。環境に応じて実装を差し替える。
 */
export interface AuthTransactionStore {
  get(key: string): Promise<AuthTransaction | null>;
  put(key: string, transaction: AuthTransaction, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * 認証成功時に返却する認可レスポンスパラメータ
 */
export interface AuthorizationResponseParams {
  redirectUri: string;
  /** 認可リクエストで redirect_uri が明示されていたか (OIDC Core 1.0 Section 3.1.3.2) */
  redirectUriExplicit: boolean;
  state?: string;
  clientId: string;
  scope: string[];
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  audience?: string[];
  /**
   * OIDC Core 1.0 §3.1.2.1: requested `acr_values` (space-separated, in order of
   * preference). Forwarded to the authorization code / token endpoint so the
   * AcrResolver can receive it as `requestedAcrValues`.
   */
  acrValues?: string;
  /** OIDC Core 1.0 §5.5: claims request to forward to authorization code / token endpoint. */
  claims?: ClaimsParameter;
  /**
   * この値を作った Auth Transaction の ID。{@link completeAuthTransaction} が設定し、
   * 認可コードへ引き継がれる（どのトランザクションから発行したコードかを記録できる）。
   * 認可レスポンスのパラメータではないので、リダイレクト URL には載せない。
   */
  transactionId?: string;
}

/**
 * ログイン失敗時の結果
 */
export interface LoginFailureResult {
  canRetry: boolean;
  failedAttempts: number;
  maxAttempts: number;
}

// --- Constants ---

/** デフォルトのTTL（ミリ秒）: 10分 */
const DEFAULT_TTL_MS = 600_000;

/** デフォルトの最大認証試行回数 */
const DEFAULT_MAX_ATTEMPTS = 5;

/** ストアキーのプレフィックス */
const STORE_KEY_PREFIX = 'auth_txn:';

// --- Functions ---

/**
 * createAuthTransaction のオプション
 */
export interface CreateAuthTransactionOptions {
  /** TTL（ミリ秒）。デフォルト: 600,000（10分） */
  ttlMs?: number;
  /**
   * User-Agent に配る秘密値のハッシュ。{@link computeTransactionBindingHash} で
   * 生成した値を渡す。User-Agent への束縛を使わない構成では省略する。
   */
  bindingHash?: string;
}

/**
 * ValidatedAuthorizationRequestからAuthTransactionを作成する
 *
 * @param validatedRequest バリデーション済みの認可リクエスト
 * @param csrfToken CSRFトークン
 * @param options TTL（デフォルト: 600,000 ミリ秒 = 10分）と User-Agent 束縛のハッシュ
 * @returns AuthTransaction
 */
export function createAuthTransaction(
  validatedRequest: ValidatedAuthorizationRequest,
  csrfToken: string,
  options: CreateAuthTransactionOptions = {}
): AuthTransaction {
  return buildAuthTransaction(validatedRequest, {
    csrfToken,
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    now: Date.now(),
    bindingHash: options.bindingHash,
  });
}

/**
 * ストアからAuth Transactionを取得する
 * トランザクションが存在しないまたは期限切れの場合はエラーをスローする
 *
 * @param txnId Auth Transaction ID
 * @param store Auth Transaction Store
 * @returns AuthTransaction
 * @throws {AuthTransactionError} トランザクションが存在しないまたは期限切れの場合
 */
export async function getAuthTransaction(
  txnId: string,
  store: Pick<AuthTransactionStore, 'get'>
): Promise<AuthTransaction> {
  const key = `${STORE_KEY_PREFIX}${txnId}`;
  const transaction = await store.get(key);

  if (!transaction) {
    throw new AuthTransactionError(
      AuthTransactionErrorCode.TransactionNotFound,
      'Auth transaction not found. The session may have expired.'
    );
  }

  validateAuthTransactionExpiration(transaction.expiresAt, Date.now());

  return transaction;
}

/**
 * CSRFトークンを検証する
 *
 * @param transaction Auth Transaction
 * @param csrfToken 検証するCSRFトークン
 * @throws {AuthTransactionError} CSRFトークンが不正な場合
 */
export function validateCsrfToken(
  transaction: Pick<AuthTransaction, 'csrfToken'>,
  csrfToken: string
): void {
  if (!csrfToken || csrfToken !== transaction.csrfToken) {
    throw new AuthTransactionError(
      AuthTransactionErrorCode.InvalidCsrfToken,
      'Invalid CSRF token.'
    );
  }
}

/**
 * User-Agent へ配る秘密値から、トランザクションに保存する束縛ハッシュを求める。
 *
 * SHA-256 / base64url。秘密値そのものではなくハッシュを保存することで、
 * トランザクションストアが漏洩しても、そこから有効な Cookie 値を復元できない。
 *
 * @param bindingSecret User-Agent に Cookie で配る秘密値（CSPRNG 由来を想定）
 * @returns 束縛ハッシュ（base64url）
 */
export async function computeTransactionBindingHash(bindingSecret: string): Promise<string> {
  return sha256(bindingSecret);
}

/**
 * トランザクションが、それを開始した User-Agent から提示されたものかを検証する。
 *
 * OIDC Core 1.0 §3.1.2.3 / §3.1.2.4 は「認可リクエストを送ってきた User-Agent の
 * End-User」を認証し、その End-User から authorization decision を得ることを前提と
 * するが、同一性の保証手段は規定していない（実装責務）。ここでは認可エンドポイントで
 * Cookie として配った秘密値のハッシュ一致で担保する。
 *
 * これが無いと、`transaction_id` が漏れた場合（ブラウザ履歴・アクセスログ・画面共有
 * など）に第三者が同意画面から CSRF トークンを取得してフローを完了させられる。また、
 * 攻撃者が自分のクライアントで開始したトランザクションへ被害者を誘導し、被害者の
 * identity に対する認可コードを攻撃者のクライアントへ届かせることもできてしまう。
 * RP 側の `state` 検証では防げない類型であり、OP 側の束縛が唯一の防御になる。
 *
 * 比較は {@link timingSafeEqual} を使い、ハッシュの先頭一致長が応答時間に漏れない
 * ようにする。
 *
 * `bindingHash` を持たないトランザクションは、どの User-Agent が開始したかを確認できない
 * ため拒否する。束縛を使わない構成ではこの関数を呼ばないこと。
 *
 * @param transaction Auth Transaction
 * @param presentedBindingSecret Cookie から取り出した秘密値。未提示なら undefined
 * @throws {AuthTransactionError} 束縛が一致しない、未提示、またはトランザクションに束縛が無い場合
 */
export async function validateTransactionBinding(
  transaction: Pick<AuthTransaction, 'bindingHash'>,
  presentedBindingSecret: string | undefined,
): Promise<void> {
  if (transaction.bindingHash === undefined || !presentedBindingSecret) {
    throw new AuthTransactionError(
      AuthTransactionErrorCode.InvalidTransactionBinding,
      'This authorization transaction was not started by this browser.',
    );
  }

  const presentedHash = await computeTransactionBindingHash(presentedBindingSecret);
  if (!(await timingSafeEqual(presentedHash, transaction.bindingHash))) {
    throw new AuthTransactionError(
      AuthTransactionErrorCode.InvalidTransactionBinding,
      'This authorization transaction was not started by this browser.',
    );
  }
}

/**
 * ログイン失敗を処理する
 * 失敗回数をインクリメントし、最大試行回数に達した場合はトランザクションを削除する
 *
 * @param txnId Auth Transaction ID
 * @param transaction Auth Transaction
 * @param store Auth Transaction Store
 * @param maxAttempts 最大試行回数。デフォルト: 5
 * @returns LoginFailureResult
 */
export async function handleLoginFailure(
  txnId: string,
  transaction: AuthTransaction,
  store: Pick<AuthTransactionStore, 'put' | 'delete'>,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS
): Promise<LoginFailureResult> {
  const key = `${STORE_KEY_PREFIX}${txnId}`;
  const result = evaluateLoginFailure(transaction.failedAttempts, maxAttempts);
  transaction.failedAttempts = result.failedAttempts;

  if (!result.canRetry) {
    await store.delete(key);
    return result;
  }

  const remainingTtlSeconds = computeAuthTransactionTtlSeconds(transaction.expiresAt, Date.now());
  await store.put(key, transaction, remainingTtlSeconds);

  return result;
}

/**
 * prompt=none ステップ 1: アクティブなセッションを解決する
 * OIDC Core 1.0 Section 3.1.2.1
 *
 * prompt=none はユーザー操作を一切伴わないため、セッションが無い時点で
 * login_required を返す（ログイン画面へ遷移してはならない）。
 *
 * @param transaction Auth Transaction（エラーのリダイレクト先 / state に使用）
 * @param sessionResolver セッションを解決するリゾルバ
 * @param request 元の HTTP リクエスト（cookie/JWT などからセッション解決に使用）
 * @returns SessionInfo
 * @throws {AuthorizationError} login_required
 */
export async function resolvePromptNoneSession(
  transaction: Pick<AuthTransaction, 'redirectUri' | 'state'>,
  sessionResolver: SessionResolver,
  request: Request,
): Promise<SessionInfo> {
  return requirePromptNoneSession(
    await sessionResolver.resolve(request),
    transaction.redirectUri,
    transaction.state,
  );
}

/**
 * prompt=none ステップ 2: id_token_hint の subject とセッションの一致を検証する
 * OIDC Core 1.0 Section 3.1.2.1
 *
 * ID Token の署名・iss・aud・exp 検証は呼び出し側の責務（core を JWT 検証実装から
 * 疎結合に保つため）。ここでは検証済みの subject だけを受け取り、アクティブな
 * セッションの subject と一致するかを判定する。
 *
 * コンセント確認より前に実行すること: コンセント検索は session.subject をキーに
 * するため、hint 不一致のまま進むと「別ユーザーのコンセント」を見てしまう。
 *
 * @param transaction Auth Transaction
 * @param session 解決済みセッション
 * @param verifiedHintSubject 呼び出し側で検証済みの id_token_hint の subject。未指定なら検証しない
 * @throws {AuthorizationError} login_required
 */
export function validatePromptNoneIdTokenHint(
  transaction: Pick<AuthTransaction, 'redirectUri' | 'state'>,
  session: Pick<SessionInfo, 'subject'>,
  verifiedHintSubject: string | undefined,
): void {
  if (verifiedHintSubject !== undefined && verifiedHintSubject !== session.subject) {
    throw new AuthorizationError(
      AuthorizationErrorCode.LoginRequired,
      'id_token_hint subject does not match the active session.',
      transaction.redirectUri,
      transaction.state,
    );
  }
}

/**
 * prompt=none ステップ 3: 要求スコープが同意済みであることを検証する
 * OIDC Core 1.0 Section 3.1.2.1
 *
 * prompt=none では同意画面を表示できないため、未同意なら consent_required を返す。
 * consentResolver 未指定時は検証しない（同意を永続化しない構成向け）。
 *
 * @param transaction Auth Transaction
 * @param session 解決済みセッション
 * @param consentResolver コンセント済みかを判定するリゾルバ（任意）
 * @throws {AuthorizationError} consent_required
 */
export async function validatePromptNoneConsent(
  transaction: Pick<AuthTransaction, 'redirectUri' | 'state' | 'clientId' | 'scope'>,
  session: Pick<SessionInfo, 'subject'>,
  consentResolver?: ConsentResolver,
): Promise<void> {
  if (!consentResolver) return;

  const scopes = splitScope(transaction.scope);
  const hasConsent = await consentResolver.hasConsent(
    session.subject,
    transaction.clientId,
    scopes,
  );
  validatePromptNoneConsentGranted(hasConsent, transaction.redirectUri, transaction.state);
}

/**
 * 再認証が必要かどうかを判定する（max_age チェック）
 * OIDC Core 1.0 Section 3.1.2.1
 *
 * maxAge=0 は「End-User を必ずアクティブに再認証させる」を意味する。
 * auth_time は秒精度の NumericDate（Section 2）のため、ログインと認可が同一の
 * 壁時計秒内で起きると authTime === now となる。strict な `now - authTime > 0`
 * では 0 > 0 === false となり再認証されないので、maxAge<=0 を特別扱いする。
 *
 * @param maxAge 最大認証経過秒数（0 以下は常に再認証を強制）
 * @param authTime 最終認証時刻（Unix timestamp 秒）
 * @param now 現在時刻（Unix timestamp 秒）。省略時はシステム時刻
 * @returns 再認証が必要な場合 true
 */
export function requiresReauthentication(
  maxAge: number,
  authTime: number,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  // OIDC Core §3.1.2.1: max_age=0 は必ず再認証。負値も安全側（再認証）へ倒す。
  if (maxAge <= 0) return true;
  return now - authTime > maxAge;
}

/**
 * 認証成功時にAuth Transactionを完了させる
 * トランザクションを削除し（ワンタイム性の担保）、認可レスポンスに必要なパラメータを返す
 *
 * セキュリティ要件: トランザクション削除は認可コード発行の前に行うこと
 *
 * @param txnId Auth Transaction ID
 * @param transaction Auth Transaction
 * @param store Auth Transaction Store
 * @returns AuthorizationResponseParams
 */
export async function completeAuthTransaction(
  txnId: string,
  transaction: AuthTransaction,
  store: Pick<AuthTransactionStore, 'delete'>
): Promise<AuthorizationResponseParams> {
  const key = `${STORE_KEY_PREFIX}${txnId}`;

  // ワンタイム性の担保: 認可コード発行前にトランザクションを削除
  await store.delete(key);

  return { ...buildAuthorizationResponseParams(transaction), transactionId: txnId };
}

/**
 * Auth Transaction が期限切れでないことを検証する。expiresAt と now は Unix epoch ミリ秒。
 * expiresAt と now が等しい場合は期限切れとする。
 */
export function validateAuthTransactionExpiration(expiresAt: number, now: number): void {
  if (expiresAt <= now) {
    throw new AuthTransactionError(
      AuthTransactionErrorCode.TransactionExpired,
      'Auth transaction has expired. Please start the authorization flow again.'
    );
  }
}

/**
 * ログイン失敗後の失敗回数と再試行の可否を求める。トランザクションの書き換えや保存はしない。
 */
export function evaluateLoginFailure(
  failedAttempts: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): LoginFailureResult {
  const nextAttempts = failedAttempts + 1;
  return {
    canRetry: !(nextAttempts >= maxAttempts),
    failedAttempts: nextAttempts,
    maxAttempts,
  };
}

/**
 * Auth Transaction から認可レスポンスの組み立てに使う値を取り出す。
 * トランザクションは削除しないため、ワンタイム性は呼び出し側が削除して担保する。
 */
export function buildAuthorizationResponseParams(
  transaction: Pick<AuthTransaction,
    'redirectUri' | 'redirectUriExplicit' | 'clientId' | 'scope' | 'state' |
    'codeChallenge' | 'codeChallengeMethod' | 'nonce' | 'audience' | 'acrValues' | 'claims'>,
): AuthorizationResponseParams {
  const result: AuthorizationResponseParams = {
    redirectUri: transaction.redirectUri,
    redirectUriExplicit: transaction.redirectUriExplicit,
    clientId: transaction.clientId,
    scope: transaction.scope.split(' '),
  };

  if (transaction.state !== undefined) {
    result.state = transaction.state;
  }
  if (transaction.codeChallenge !== undefined) {
    result.codeChallenge = transaction.codeChallenge;
  }
  if (transaction.codeChallengeMethod !== undefined) {
    result.codeChallengeMethod = transaction.codeChallengeMethod;
  }
  if (transaction.nonce !== undefined) {
    result.nonce = transaction.nonce;
  }
  if (transaction.audience !== undefined) {
    result.audience = transaction.audience;
  }
  if (transaction.acrValues !== undefined) {
    result.acrValues = transaction.acrValues;
  }
  if (transaction.claims !== undefined) {
    result.claims = transaction.claims;
  }

  return result;
}

/**
 * 検証済みの認可リクエストから Auth Transaction を組み立てる。保存はしない。
 * 時刻と TTL はミリ秒で受け取り、createdAt と expiresAt に使う。
 */
export function buildAuthTransaction(
  validatedRequest: ValidatedAuthorizationRequest,
  options: {
    csrfToken: string;
    ttlMs: number;
    /** 現在時刻（Unix epoch ミリ秒） */
    now: number;
    /** User-Agent 束縛のハッシュ。生の秘密値は渡さない */
    bindingHash?: string;
  },
): AuthTransaction {
  const { csrfToken, ttlMs, now } = options;

  const transaction: AuthTransaction = {
    clientId: validatedRequest.clientId,
    redirectUri: validatedRequest.redirectUri,
    redirectUriExplicit: validatedRequest.redirectUriExplicit,
    responseType: validatedRequest.responseType,
    scope: validatedRequest.scope.join(' '),
    csrfToken,
    createdAt: now,
    expiresAt: now + ttlMs,
    failedAttempts: 0,
  };

  // オプションパラメータ
  if (validatedRequest.state !== undefined) {
    transaction.state = validatedRequest.state;
  }
  if (validatedRequest.nonce !== undefined) {
    transaction.nonce = validatedRequest.nonce;
  }
  if (validatedRequest.codeChallenge !== undefined) {
    transaction.codeChallenge = validatedRequest.codeChallenge;
  }
  if (validatedRequest.codeChallengeMethod !== undefined) {
    transaction.codeChallengeMethod = validatedRequest.codeChallengeMethod;
  }
  if (validatedRequest.prompt !== undefined) {
    transaction.prompt = validatedRequest.prompt.join(' ');
  }
  if (validatedRequest.maxAge !== undefined) {
    transaction.maxAge = validatedRequest.maxAge;
  }
  if (validatedRequest.acrValues !== undefined) {
    transaction.acrValues = validatedRequest.acrValues;
  }
  if (validatedRequest.loginHint !== undefined) {
    transaction.loginHint = validatedRequest.loginHint;
  }
  // OIDC Core §3.1.2.1 / §5.2: pass through the requested UI/claims locales so the
  // login/consent UI and claim rendering can honor them. core does not transform them.
  if (validatedRequest.uiLocales !== undefined) {
    transaction.uiLocales = validatedRequest.uiLocales;
  }
  if (validatedRequest.claimsLocales !== undefined) {
    transaction.claimsLocales = validatedRequest.claimsLocales;
  }
  if (validatedRequest.idTokenHint !== undefined) {
    transaction.idTokenHint = validatedRequest.idTokenHint;
  }
  if (validatedRequest.audience !== undefined) {
    transaction.audience = validatedRequest.audience;
  }
  if (validatedRequest.claims !== undefined) {
    transaction.claims = validatedRequest.claims;
  }
  // 生の秘密値は保存しない（ハッシュのみ）。store 漏洩で束縛を偽装できないようにするため。
  if (options.bindingHash !== undefined) {
    transaction.bindingHash = options.bindingHash;
  }

  return transaction;
}

/**
 * Auth Transaction の残り有効期間を、ストアの TTL に渡す秒数で返す。
 * expiresAt と now は Unix epoch ミリ秒。切り上げ、期限切れでも最小 1 秒とする。
 */
export function computeAuthTransactionTtlSeconds(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}

/**
 * OIDC Core 1.0 §3.1.2.1: prompt=none でアクティブなセッションがあることを確かめる。
 * セッションの解決は呼び出し側が行い、無ければ null を渡す。無い場合は login_required。
 */
export function requirePromptNoneSession<T>(
  session: T | null | undefined,
  redirectUri: string,
  state?: string,
): T {
  if (!session) {
    throw new AuthorizationError(
      AuthorizationErrorCode.LoginRequired,
      'No active session found. Silent authentication failed.',
      redirectUri,
      state
    );
  }
  return session;
}

/**
 * OIDC Core 1.0 §3.1.2.1: prompt=none で要求 scope への同意が済んでいることを検証する。
 * 同意の照会は呼び出し側が行い、結果を渡す。未同意なら consent_required。
 */
export function validatePromptNoneConsentGranted(
  hasConsent: boolean,
  redirectUri: string,
  state?: string,
): void {
  if (!hasConsent) {
    throw new AuthorizationError(
      AuthorizationErrorCode.ConsentRequired,
      'Consent has not been granted. Silent authentication cannot show consent UI.',
      redirectUri,
      state,
    );
  }
}
