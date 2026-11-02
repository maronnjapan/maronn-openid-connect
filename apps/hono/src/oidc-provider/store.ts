/**
 * The storage contract of the provider: what the endpoints read and write,
 * and nothing about where it is kept.
 *
 * db/ implements it. The provider is generated with one kind of database
 * (--db): db/memory keeps everything in this process, db/sql in SQL tables,
 * db/kv in a key-value store. Pass your own ProviderStores through the
 * storage option of createApp() / applyOidc() to keep the data elsewhere.
 */
import type {
  AccessTokenInfo,
  AuthTransactionStore,
  AuthorizationCodeInfo,
  RefreshTokenInfo,
  UserClaims,
} from '@maronn-openid-connect/core';

export type Awaitable<T> = T | Promise<T>;

/**
 * The login result handed from the login step to the consent step, per
 * transaction.
 */
export interface AuthSessionInfo {
  subject: string;
  authTime: number;
  /**
   * このログインで確立（または再利用）したブラウザセッションの識別子。
   * consent 画面を経て発行する認可コードへ引き継ぎ、online refresh token を
   * そのセッションに結び付けるために使う。
   */
  sessionId?: string;
}

/**
 * The browser (OP) session - OIDC Core 1.0 Section 3.1.2.3. It lasts across
 * authorization requests, keyed by the session id of the session cookie
 * (cookies.ts), and is what makes SSO, prompt=none and max_age work.
 */
export interface BrowserSessionInfo {
  subject: string;
  authTime: number;
}

/** An account of a user at an upstream identity provider, such as Google. */
export interface FederatedIdentity {
  /** The upstream identity provider ('google'). */
  provider: string;
  /** The subject at the upstream provider (its sub claim), which it never reassigns. */
  subject: string;
  /** The claims the provider asserted about the account. sub is the OP's own and is left out. */
  claims: Omit<UserClaims, 'sub'>;
}

/** A sign-in at an upstream identity provider that a transaction waits for. */
export interface UpstreamLogin {
  provider: string;
  transactionId: string;
  /** Unix time in milliseconds; the record is gone after it (the transaction's expiresAt). */
  expiresAt: number;
}

/**
 * The authorization transactions: core's AuthTransactionStore, and how a
 * transaction ended when the authorization endpoint returned its tokens
 * itself.
 */
export interface TransactionStorage extends AuthTransactionStore {
  /**
   * トークンを発行したことをトランザクションに記録する。
   *
   * 認可エンドポイントが、認可コードを介さずにトークンを返したときに呼ぶ。
   * インプリシットフローは、ID トークンを認可エンドポイントから返す（OIDC Core 1.0 §3.2.2.5）。
   * 認可コードフローのトランザクションは、認可コードを交換したときに同じ状態になる。
   * トランザクションがどう終わったかを保存しないストアは、このメソッドを省いてよい。
   */
  recordTokenIssued?(transactionId: string): Awaitable<void>;
}

export interface AuthorizationCodeStorage {
  /**
   * 認可コードを、発行した内容とともに保存する。
   *
   * 発行した内容は、クライアント、リダイレクト URI、スコープ、有効期限などである。
   * 同じ認可コードのレコードがあれば置き換える。
   */
  set(code: string, info: AuthorizationCodeInfo): Awaitable<void>;
  /**
   * 認可コードのレコードを返す。
   *
   * 保存されていない認可コードと、期限切れの認可コードには `undefined` を返す。
   * 使用済みの認可コードも、`used: true` のレコードとして返す。
   */
  get(code: string): Awaitable<AuthorizationCodeInfo | undefined>;
  /**
   * 認可コードを使用済みにする。
   *
   * レコードは削除しない。
   * 再提示された認可コードを使用済みとして見つけ、そのグラントを失効させるためである（OAuth 2.1 §4.1.2、RFC 9700 §4.13）。
   * 見つからない認可コードと使用済みの認可コードには `TokenError`（`invalid_grant`）を投げるので、同じ認可コードを提示した二つのリクエストのうち、トークンを受け取るのは一つだけになる。
   */
  consume(code: string): Awaitable<void>;
  delete(code: string): Awaitable<void>;
}

export interface AccessTokenStorage {
  /**
   * 発行したアクセストークンを保存する。
   *
   * サブジェクト、クライアント、スコープ、有効期限とともに保存し、UserInfo エンドポイント、イントロスペクション、トークンの失効で見つけられるようにする。
   */
  set(token: string, info: AccessTokenInfo): Awaitable<void>;
  get(token: string): Awaitable<AccessTokenInfo | undefined>;
  delete(token: string): Awaitable<void>;
  /**
   * グラントのアクセストークンをすべて失効させる。
   *
   * 認可コードが再提示されたときに使う（OAuth 2.1 §4.1.2）。
   */
  revokeByGrantId(grantId: string): Awaitable<void>;
  /**
   * アクセストークンを一つ失効させる。
   *
   * @spec RFC 7009
   */
  revoke(token: string): Awaitable<void>;
}

export interface RefreshTokenStorage {
  /**
   * 発行したリフレッシュトークンを保存する。
   *
   * グラント、サブジェクト、クライアント、スコープ、有効期限とともに保存する。
   */
  set(token: string, info: RefreshTokenInfo): Awaitable<void>;
  get(token: string): Awaitable<RefreshTokenInfo | undefined>;
  /**
   * リフレッシュトークンを使用済みにする。
   *
   * ローテーションで置き換えたリフレッシュトークンに使う。
   * レコードは削除しない。
   * 再提示されたリフレッシュトークンを見つけて、そのグラントを失効させるためである（OAuth 2.1 §4.3.1、RFC 9700 §4.13）。
   * 見つからないリフレッシュトークンと使用済みのリフレッシュトークンには `TokenError`（`invalid_grant`）を投げる。
   */
  consume(token: string): Awaitable<void>;
  delete(token: string): Awaitable<void>;
  /**
   * グラントのリフレッシュトークンをすべて失効させる。
   *
   * ローテーションで使用済みになったものも含める（OAuth 2.1 §4.1.2）。
   */
  revokeByGrantId(grantId: string): Awaitable<void>;
  /**
   * リフレッシュトークンを一つ失効させる。
   *
   * @spec RFC 7009
   */
  revoke(token: string): Awaitable<void>;
}

export interface AuthSessionStorage {
  /**
   * トランザクションでログインしたユーザーを保存する。
   *
   * サブジェクト、ログインした時刻、ブラウザセッションの ID を保存し、同意のステップがそれを読む。
   */
  set(transactionId: string, info: AuthSessionInfo): Awaitable<void>;
  /**
   * トランザクションでログインしたユーザーを返す。
   *
   * まだ誰もログインしていないとき、またはレコードの期限が切れたときは `undefined` を返す。
   */
  get(transactionId: string): Awaitable<AuthSessionInfo | undefined>;
  delete(transactionId: string): Awaitable<void>;
}

export interface BrowserSessionStorage {
  /**
   * セッション ID をキーに、OP のセッションを保存する。
   *
   * 保存するのは、ログインしたユーザーのサブジェクトと、ログインした時刻である。
   */
  set(sessionId: string, info: BrowserSessionInfo): Awaitable<void>;
  /**
   * セッション ID に対応する OP のセッションを返す。
   *
   * セッションがないとき、または期限が切れたときは `undefined` を返す。
   */
  get(sessionId: string): Awaitable<BrowserSessionInfo | undefined>;
  delete(sessionId: string): Awaitable<void>;
}

/**
 * The scopes a user granted to a client, so prompt=none can confirm consent
 * without UI (OIDC Core 1.0 Section 3.1.2.1), and the grants issued under it,
 * so removing access revokes their tokens.
 */
export interface ConsentStorage {
  grant(subject: string, clientId: string, scopes: string[]): Awaitable<void>;
  /**
   * 要求したスコープがすべて同意済みなら true を返す。
   *
   * 一部のスコープだけが同意済みのときと、`scopes` が空のときは `false` を返す。
   */
  hasConsent(subject: string, clientId: string, scopes: string[]): Awaitable<boolean>;
  /**
   * クライアントへの同意にグラント ID を記録する。
   *
   * 同じグラント ID は一度だけ記録し、記録したグラント ID は `revoke()` が返す。
   */
  recordGrant(subject: string, clientId: string, grantId: string): Awaitable<void>;
  /**
   * 同意を削除し、記録したグラント ID を返す。
   *
   * 呼び出し側は、返したグラント ID のトークンを失効させる。
   */
  revoke(subject: string, clientId: string): Awaitable<string[]>;
}

export interface UserStorage {
  /**
   * ユーザー名とパスワードが合えば、クレームを返す。
   *
   * 登録されていないユーザー、パスワードの誤り、パスワードを持たないユーザーには `undefined` を返す。
   * 返すクレームには、保存したパスワードのハッシュが `password` として含まれる。
   */
  authenticate(
    username: string,
    password: string,
  ): Awaitable<(UserClaims & { password: string }) | undefined>;
  /**
   * サブジェクトのユーザーのクレームを返す。
   *
   * 登録されていないサブジェクトには `undefined` を返す。
   */
  getClaims(sub: string): Awaitable<UserClaims | undefined>;
  /**
   * 外部アカウントのユーザーを探すか作り、クレームを返す。
   *
   * ユーザーは、外部の ID プロバイダとそこでのサブジェクトの組で探し、メールアドレスでは探さない。
   * 見つからなければ新しいユーザーを作り（ジャストインタイムのプロビジョニング）、どちらの場合も外部の ID プロバイダが示したクレームを保存する。
   */
  linkFederatedIdentity(identity: FederatedIdentity): Awaitable<UserClaims>;
}

/** The upstream sign-ins in progress, found by the nonce the OP sent upstream. */
export interface UpstreamLoginStorage {
  find(nonce: string): Awaitable<UpstreamLogin | undefined>;
  save(nonce: string, login: UpstreamLogin): Awaitable<void>;
  delete(nonce: string): Awaitable<void>;
}

export interface ProviderStores {
  transactionStore: TransactionStorage;
  authCodeStore: AuthorizationCodeStorage;
  accessTokenStore: AccessTokenStorage;
  refreshTokenStore: RefreshTokenStorage;
  authSessionStore: AuthSessionStorage;
  browserSessionStore: BrowserSessionStorage;
  consentStore: ConsentStorage;
  userStore: UserStorage;
  upstreamLoginStore: UpstreamLoginStorage;
}

/** Stores per request: the request context in, the stores of that request out. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderStoresFactory = (context: any) => Awaitable<ProviderStores>;
