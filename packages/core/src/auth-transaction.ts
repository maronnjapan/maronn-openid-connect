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
   * 未設定のトランザクションは束縛検証をスキップする（後方互換）。
   *
   * 詳細は {@link validateTransactionBinding}。
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
   * 生成した値を渡す。省略時は束縛検証を行わないトランザクションになる。
   */
  bindingHash?: string;
}

/**
 * ValidatedAuthorizationRequestからAuthTransactionを作成する
 *
 * @param validatedRequest バリデーション済みの認可リクエスト
 * @param csrfToken CSRFトークン
 * @param ttlMsOrOptions TTL（ミリ秒）またはオプション。デフォルト TTL: 600,000（10分）
 *                       数値を渡す旧シグネチャは後方互換のため維持している。
 * @returns AuthTransaction
 */
export function createAuthTransaction(
  validatedRequest: ValidatedAuthorizationRequest,
  csrfToken: string,
  ttlMsOrOptions: number | CreateAuthTransactionOptions = DEFAULT_TTL_MS
): AuthTransaction {
  const options: CreateAuthTransactionOptions =
    typeof ttlMsOrOptions === 'number' ? { ttlMs: ttlMsOrOptions } : ttlMsOrOptions;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

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
  store: AuthTransactionStore
): Promise<AuthTransaction> {
  const key = `${STORE_KEY_PREFIX}${txnId}`;
  const transaction = await store.get(key);

  if (!transaction) {
    throw new AuthTransactionError(
      AuthTransactionErrorCode.TransactionNotFound,
      'Auth transaction not found. The session may have expired.'
    );
  }

  if (transaction.expiresAt <= Date.now()) {
    throw new AuthTransactionError(
      AuthTransactionErrorCode.TransactionExpired,
      'Auth transaction has expired. Please start the authorization flow again.'
    );
  }

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
  transaction: AuthTransaction,
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
 * 後方互換: `bindingHash` を持たないトランザクション（束縛導入前に発行されたもの、
 * または生成コードから束縛を外した構成）は検証をスキップする。
 *
 * @param transaction Auth Transaction
 * @param presentedBindingSecret Cookie から取り出した秘密値。未提示なら undefined
 * @throws {AuthTransactionError} 束縛が一致しない、または未提示の場合
 */
export async function validateTransactionBinding(
  transaction: AuthTransaction,
  presentedBindingSecret: string | undefined,
): Promise<void> {
  if (transaction.bindingHash === undefined) {
    return;
  }

  if (!presentedBindingSecret) {
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
  store: AuthTransactionStore,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS
): Promise<LoginFailureResult> {
  const key = `${STORE_KEY_PREFIX}${txnId}`;
  transaction.failedAttempts++;

  if (transaction.failedAttempts >= maxAttempts) {
    await store.delete(key);
    return {
      canRetry: false,
      failedAttempts: transaction.failedAttempts,
      maxAttempts,
    };
  }

  const remainingTtlMs = transaction.expiresAt - Date.now();
  const remainingTtlSeconds = Math.max(1, Math.ceil(remainingTtlMs / 1000));
  await store.put(key, transaction, remainingTtlSeconds);

  return {
    canRetry: true,
    failedAttempts: transaction.failedAttempts,
    maxAttempts,
  };
}

/**
 * checkPromptNone のオプション
 */
export interface PromptNoneOptions {
  /**
   * id_token_hint を呼び出し側で事前に検証して取り出した subject。
   * 渡された場合、解決したセッションの subject と一致しなければ login_required。
   * 未指定なら hint 検証は行わない。
   *
   * Why: ID Token の署名・iss・aud・exp 検証は呼び出し側責務とすることで、
   * core を JWT 検証実装から疎結合に保つ。core は受け取った subject を信頼する。
   */
  verifiedHintSubject?: string;
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
  transaction: AuthTransaction,
  sessionResolver: SessionResolver,
  request: Request,
): Promise<SessionInfo> {
  const session = await sessionResolver.resolve(request);
  if (!session) {
    throw new AuthorizationError(
      AuthorizationErrorCode.LoginRequired,
      'No active session found. Silent authentication failed.',
      transaction.redirectUri,
      transaction.state
    );
  }
  return session;
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
  transaction: AuthTransaction,
  session: SessionInfo,
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
  transaction: AuthTransaction,
  session: SessionInfo,
  consentResolver?: ConsentResolver,
): Promise<void> {
  if (!consentResolver) return;

  const scopes = transaction.scope.split(' ').filter(Boolean);
  const hasConsent = await consentResolver.hasConsent(
    session.subject,
    transaction.clientId,
    scopes,
  );
  if (!hasConsent) {
    throw new AuthorizationError(
      AuthorizationErrorCode.ConsentRequired,
      'Consent has not been granted. Silent authentication cannot show consent UI.',
      transaction.redirectUri,
      transaction.state,
    );
  }
}

/**
 * prompt=none 時のサイレント認証チェック
 * OIDC Core 1.0 Section 3.1.2.1
 *
 * 各ステップ関数を仕様順に合成した後方互換 API。CLI が生成する Provider は
 * この合成関数ではなく個々のステップ関数を順に呼び出すため、利用者は検証を
 * 削除したり独自処理を差し込んだりできる。
 *
 * セッションなし → login_required をスロー（{@link resolvePromptNoneSession}）
 * hint 不一致 → login_required をスロー（{@link validatePromptNoneIdTokenHint}）
 * コンセント無し → consent_required をスロー（{@link validatePromptNoneConsent}）
 * いずれも通過すればセッション情報を返却する。
 *
 * @param transaction Auth Transaction
 * @param sessionResolver セッションを解決するリゾルバ
 * @param request 元の HTTP リクエスト（cookie/JWT などからセッション解決に使用）
 * @param consentResolver コンセント済みかを判定するリゾルバ（任意）
 * @param options id_token_hint などの追加オプション
 * @returns SessionInfo
 * @throws {AuthorizationError} login_required または consent_required
 */
export async function checkPromptNone(
  transaction: AuthTransaction,
  sessionResolver: SessionResolver,
  request: Request,
  consentResolver?: ConsentResolver,
  options?: PromptNoneOptions,
): Promise<SessionInfo> {
  const session = await resolvePromptNoneSession(transaction, sessionResolver, request);
  validatePromptNoneIdTokenHint(transaction, session, options?.verifiedHintSubject);
  await validatePromptNoneConsent(transaction, session, consentResolver);
  return session;
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
 * @returns 再認証が必要な場合 true
 */
export function requiresReauthentication(maxAge: number, authTime: number): boolean {
  // OIDC Core §3.1.2.1: max_age=0 は必ず再認証。負値も安全側（再認証）へ倒す。
  if (maxAge <= 0) return true;
  const now = Math.floor(Date.now() / 1000);
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
  store: AuthTransactionStore
): Promise<AuthorizationResponseParams> {
  const key = `${STORE_KEY_PREFIX}${txnId}`;

  // ワンタイム性の担保: 認可コード発行前にトランザクションを削除
  await store.delete(key);

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
