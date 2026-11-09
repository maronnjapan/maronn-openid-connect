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
  /**
   * ログイン中の OP のセッションを探して返す。
   *
   * セッションは、リクエストの Cookie などから探す。
   * 返す値は、ログインしているエンドユーザーのサブジェクト、認証時刻、セッションの ID（任意）である。
   * セッションがないとき、または終了しているときは `null` を返す。
   */
  resolve(request: Request): Promise<SessionInfo | null>;
}

/**
 * コンセント済みかどうかを解決するインターフェース
 * OIDC Core 1.0 Section 3.1.2.1: prompt=none ではコンセント済みでない場合
 * consent_required を返す必要がある。
 */
export interface ConsentResolver {
  /**
   * 要求したスコープがすべて同意済みなら true を返す。
   *
   * `subject` が `clientId` に同意済みのスコープに、`scopes` がすべて含まれる（要求 ⊆ 同意済み）ときだけ true を返す。
   * 一部だけ同意済みのときに true を返してはならない（MUST NOT）。
   * 同意されていないスコープを同意済みとみなすと、エンドユーザーが許可していないスコープの権限まで、確認なしに与えてしまうためである。
   */
  hasConsent(subject: string, clientId: string, scopes: string[]): Promise<boolean>;
  /**
   * エンドユーザーが同意したスコープを記録する。
   *
   * `subject` が `clientId` に同意した `scopes` を、既存の同意済みのスコープに加えて記録する。
   * 実装は任意で、同意を保存せずに毎回同意を求める実装では省略してよい（OIDC Core 1.0 §3.1.2.4）。
   */
  recordConsent?(subject: string, clientId: string, scopes: string[]): Promise<void>;
  /**
   * `subject` が `clientId` に与えた同意をすべて失効させる。
   *
   * 実装は任意である。
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
  /**
   * `key` のトランザクションを返す。
   *
   * トランザクションがないとき、または有効期限が切れたときは `null` を返す。
   */
  get(key: string): Promise<AuthTransaction | null>;
  /**
   * トランザクションを `key` でストアに保存する。
   *
   * 同じ `key` の値があれば置き換え、`ttlSeconds` 秒後に期限切れにする。
   */
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

/** Reject missing or mismatched transaction IDs before looking up or changing a transaction. */
export function validateTransactionId(
  transactionId: string | undefined,
  references: readonly unknown[],
): asserts transactionId is string {
  if (!transactionId || references.length === 0 || references.some(
    (reference) => reference !== transactionId,
  )) {
    throw new AuthTransactionError(
      AuthTransactionErrorCode.InvalidTransactionBinding,
      'Invalid authorization transaction.',
    );
  }
}

/** Return the URL's transaction ID, or undefined when it is missing, empty or repeated. */
export function getTransactionIdFromUrl(url: string): string | undefined {
  const values = new URL(url).searchParams.getAll('transaction_id');
  return values.length === 1 ? values[0] || undefined : undefined;
}

/** Return a screen path with the transaction ID encoded in its query. */
export function buildTransactionPath(path: string, transactionId: string): string {
  return path + '?' + new URLSearchParams({ transaction_id: transactionId }).toString();
}

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
 * 認可リクエストからトランザクションを作って返す。
 *
 * 有効期間は `options.ttlMs`（既定値は 600,000 ミリ秒、つまり 10 分）で、現在時刻から数える。
 * 中身の組み立ては `buildAuthTransaction()` が行う。
 * ストアへの保存はしない。
 *
 * @param validatedRequest 検証済みの認可リクエスト。
 * @param csrfToken トランザクションに保存する CSRF トークン。
 * @param options 有効期間（ミリ秒）と、ブラウザへの結び付けに使うハッシュ（`bindingHash`）。
 * @returns 保存前のトランザクション。
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
 * 有効なトランザクションをストアから取得して返す。
 *
 * ストアのキーは、`txnId` の前に `auth_txn:` を付けた文字列である。
 *
 * @param txnId トランザクションの ID。
 * @param store トランザクションのストア。
 * @returns 有効期限内のトランザクション。
 * @throws {AuthTransactionError} `transaction_not_found`（ストアにトランザクションがないとき）か `transaction_expired`（有効期限を過ぎているとき）。
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
 * CSRF トークンが違えば `invalid_csrf_token` を投げる。
 *
 * @param transaction トランザクション。
 * @param csrfToken 検証する CSRF トークン。
 * @throws {AuthTransactionError} `invalid_csrf_token`: 提示された CSRF トークンが空か、トランザクションに保存した値と一致しないとき。
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
 * 秘密値の SHA-256 ハッシュを base64url で返す。
 *
 * 呼び出し側は結果を、トランザクションをブラウザに結び付けるためのハッシュ（`bindingHash`）としてトランザクションに保存する。
 * 秘密値そのものではなくハッシュを保存するので、トランザクションのストアが漏れても、そこから有効な Cookie の値を復元できない。
 *
 * @param bindingSecret ブラウザに Cookie で渡す秘密値（暗号論的に安全な乱数から作った値を想定する）。
 * @returns 結び付けのハッシュ（base64url）。
 */
export async function computeTransactionBindingHash(bindingSecret: string): Promise<string> {
  return sha256(bindingSecret);
}

/**
 * 開始したブラウザ以外からのトランザクションを拒否する。
 *
 * 認可エンドポイントで Cookie として渡した秘密値（`presentedBindingSecret`）のハッシュを求め、トランザクションに保存したハッシュ（`bindingHash`）と比べる。
 * 比較には {@link timingSafeEqual} を使い、ハッシュの先頭から一致した長さが応答時間から分からないようにする。
 *
 * `bindingHash` を持たないトランザクションは、どのブラウザが開始したかを確かめられないので拒否する。
 * ブラウザへの結び付けを使わない構成では、この関数を呼ばない。
 *
 * OIDC Core 1.0 §3.1.2.3 と §3.1.2.4 は、認可リクエストを送ってきたブラウザのエンドユーザーを認証し、そのエンドユーザーから認可の判断を得ることを前提にしているが、同じブラウザであることを保証する方法は定めていない。
 * その保証は実装に任されており、この関数は秘密値のハッシュの一致で保証する。
 *
 * この検証がないと、`transaction_id` が漏れたとき（ブラウザの履歴、アクセスログ、画面共有など）に、第三者が同意画面から CSRF トークンを取得してフローを完了できる。
 * また、攻撃者が自分のクライアントで開始したトランザクションに被害者を誘導すると、被害者のアカウントで発行された認可コードを攻撃者のクライアントが受け取れてしまう。
 * どちらも RP 側の `state` の検証では防げず、防げるのは OP 側の結び付けだけである。
 *
 * @param transaction トランザクション。
 * @param presentedBindingSecret Cookie から取り出した秘密値。提示されていなければ `undefined`。
 * @throws {AuthTransactionError} `invalid_transaction_binding`: ハッシュが一致しないとき、秘密値が提示されていないとき、またはトランザクションに `bindingHash` がないとき。
 * @spec OIDC Core 1.0 §3.1.2.3
 * @spec OIDC Core 1.0 §3.1.2.4
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
 * 失敗回数を数え、上限でトランザクションを削除する。
 *
 * トランザクションの失敗回数を 1 増やし、再試行できるかどうかと失敗回数を返す。
 * 失敗回数が `maxAttempts` に達したら、トランザクションをストアから削除する。
 * 達していなければ、失敗回数を更新したトランザクションを、残りの有効期間（秒）を指定してストアに保存し直す。
 * どちらの場合も、渡された `transaction` の `failedAttempts` を書き換える。
 *
 * @param txnId トランザクションの ID。
 * @param transaction トランザクション。
 * @param store トランザクションのストア。
 * @param maxAttempts ログインを試せる最大の回数。既定値は 5。
 * @returns 再試行できるかどうか、失敗回数、最大の回数。
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
 * ログイン中のセッションを取得して返す。
 *
 * `prompt=none` の認可リクエストで、`sessionResolver` からログイン中のセッションを取得する。
 * `prompt=none` はエンドユーザーの操作を一切伴わないので、セッションがなければログイン画面に移らず、`login_required` のエラーを返す必要がある。
 * エラーには、クライアントへリダイレクトで返すためのリダイレクト URI と `state` を付ける。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @param transaction トランザクション（エラーのリダイレクト先と `state` に使う）。
 * @param sessionResolver セッションを取得するリゾルバ。
 * @param request 元の HTTP リクエスト（Cookie や JWT からセッションを探すのに使う）。
 * @returns ログイン中のセッション。
 * @throws {AuthorizationError} `login_required`: ログイン中のセッションがないとき。
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
 * `id_token_hint` をセッションと照合する。
 *
 * `prompt=none` の認可リクエストで、呼び出し側が検証した `id_token_hint` のサブジェクトと、ログイン中のセッションのサブジェクトを比べる。
 * ID トークンの署名、`iss`、`aud`、`exp` の検証は呼び出し側が行う。
 * core を JWT の検証の実装から切り離しておくためである。
 *
 * この照合は、同意の確認より前に行う必要がある。
 * 同意はセッションのサブジェクトをキーにして探すので、ヒントが一致しないまま進むと、別のユーザーの同意を参照してしまう。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @param transaction トランザクション（エラーのリダイレクト先と `state` に使う）。
 * @param session 取得したセッション。
 * @param verifiedHintSubject 呼び出し側が検証した `id_token_hint` のサブジェクト。`undefined` なら照合しない。
 * @throws {AuthorizationError} `login_required`: サブジェクトが一致しないとき。
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
 * 未同意のスコープがあれば `consent_required` を投げる。
 *
 * `prompt=none` では同意画面を表示できないので、要求したスコープに同意がなければ `consent_required` のエラーを返す。
 * 同意済みかどうかは、`consentResolver.hasConsent()` に、セッションのサブジェクト、クライアント ID、要求したスコープを渡して確かめる。
 * `consentResolver` が渡されなければ確かめない（同意を保存しない構成のため）。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @param transaction トランザクション（クライアント ID、スコープ、エラーのリダイレクト先、`state` に使う）。
 * @param session 取得したセッション。
 * @param consentResolver 同意済みかどうかを判定するリゾルバ（任意）。
 * @throws {AuthorizationError} `consent_required`: 要求したスコープに同意がないとき。
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
 * 認証から `maxAge` 秒を超えていれば true を返す。
 *
 * 現在時刻（`now`）と最後の認証時刻（`authTime`）の差が `maxAge` より大きければ、再認証が必要として true を返す。
 * `maxAge` が 0 以下なら、経過時間によらず true を返す。
 *
 * `max_age=0` は、エンドユーザーを必ず再認証させることを意味する。
 * `auth_time` は秒単位の `NumericDate`（OIDC Core 1.0 §2）なので、ログインと認可が同じ秒のうちに起きると `authTime` と `now` が等しくなる。
 * このとき `now - authTime > 0` は偽になって再認証されないので、`maxAge` が 0 以下の場合を別に扱う。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @param maxAge 認証からの経過を許す最大の秒数。0 以下なら常に再認証を求める。
 * @param authTime 最後に認証した時刻（エポック秒）。
 * @param now 現在時刻（エポック秒）。省略するとシステムの時刻を使う。
 * @returns 再認証が必要なら true。
 */
export function requiresReauthentication(
  maxAge: number,
  authTime: number,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  // `maxAge` が 0 なら必ず再認証を求め、負の値も安全側に倒して再認証を求める（OIDC Core 1.0 §3.1.2.1）。
  if (maxAge <= 0) return true;
  return now - authTime > maxAge;
}

/**
 * トランザクションを削除し、認可レスポンスの値を返す。
 *
 * 認証に成功したときに呼ぶ。
 * トランザクションを削除しておくことで、同じトランザクションから認可コードを二度発行できないようにする。
 * そのため、この関数は認可コードを発行する前に呼ぶ必要がある。
 * 返す値には、`transactionId` としてトランザクションの ID を加える。
 *
 * @param txnId トランザクションの ID。
 * @param transaction トランザクション。
 * @param store トランザクションのストア。
 * @returns 認可レスポンスの組み立てに使う値。
 */
export async function completeAuthTransaction(
  txnId: string,
  transaction: AuthTransaction,
  store: Pick<AuthTransactionStore, 'delete'>
): Promise<AuthorizationResponseParams> {
  const key = `${STORE_KEY_PREFIX}${txnId}`;

  // 認可コードを発行する前にトランザクションを削除し、一度しか使えないようにする。
  await store.delete(key);

  return { ...buildAuthorizationResponseParams(transaction), transactionId: txnId };
}

/**
 * 期限切れなら `transaction_expired` を投げる。
 *
 * `expiresAt` が `now` 以下なら、トランザクションが期限切れとみなして `AuthTransactionError` を投げる。
 * `expiresAt` と `now` はエポックミリ秒で渡す。
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
 * 失敗回数を 1 増やし、再試行できるかを返す。
 *
 * 増やした失敗回数が `maxAttempts`（既定値は 5）未満なら、再試行できる（`canRetry` が true）。
 * トランザクションの書き換えや保存はしない。
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
 * トランザクションから認可レスポンスの値を取り出す。
 *
 * `scope` は空白で分けて配列にし、トランザクションにない省略可能な項目は含めない。
 * トランザクションは削除しないので、一度しか使えないようにするには、呼び出し側が削除する。
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
 * 認可リクエストと時刻からトランザクションを組み立てる。
 *
 * `createdAt` は `now`、`expiresAt` は `now` に `ttlMs` を足した値にし、`failedAttempts` は 0 にする。
 * 時刻と有効期間はミリ秒で受け取る。
 * `scope` と `prompt` は空白区切りの文字列にし、認可リクエストにない省略可能な項目は含めない。
 * ストアへの保存はしない。
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

  // 省略可能なパラメータは、認可リクエストにあるときだけ入れる。
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
  // 要求された画面の言語（`ui_locales`）とクレームの言語（`claims_locales`）を、変換せずにそのまま入れる（OIDC Core 1.0 §3.1.2.1、§5.2）。
  // ログイン画面、同意画面、クレームの表示で、これらの言語を使えるようにするためである。
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
  // ブラウザへの結び付けはハッシュだけを保存し、生の秘密値は保存しない。
  // ストアが漏れても、結び付けを偽装できないようにするためである。
  if (options.bindingHash !== undefined) {
    transaction.bindingHash = options.bindingHash;
  }

  return transaction;
}

/**
 * 残りの有効期間を、ストアに渡す秒数にして返す。
 *
 * `expiresAt` と `now` はエポックミリ秒で渡す。
 * 秒への換算は切り上げで、結果が 1 未満（期限切れを含む）なら 1 を返す。
 */
export function computeAuthTransactionTtlSeconds(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}

/**
 * セッションを返し、なければ `login_required` を投げる。
 *
 * `prompt=none` の認可リクエストで、ログイン中のセッションがあることを確かめる。
 * セッションの取得は呼び出し側が行い、なければ `null` を渡す。
 * エラーには、クライアントへリダイレクトで返すための `redirectUri` と `state` を付ける。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
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
 * 同意がなければ `consent_required` を投げる。
 *
 * `prompt=none` の認可リクエストで、要求したスコープへの同意が済んでいることを確かめる。
 * 同意の照会は呼び出し側が行い、結果を `hasConsent` で渡す。
 * エラーには、クライアントへリダイレクトで返すための `redirectUri` と `state` を付ける。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
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
