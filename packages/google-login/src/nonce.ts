/**
 * Google ログインを OP の認証トランザクションへ束縛する nonce。
 *
 * GIS の redirect mode は `login_uri` へ `credential` と `g_csrf_token` しか送らないため、
 * どの認証トランザクション（core の Auth Transaction ID 方式）のログインとして届いた POST
 * なのかを本文から知る手段が無い。`login_uri` は Google Cloud コンソールに登録した
 * リダイレクト URI と完全一致する必要があり、クエリでトランザクション ID を運ぶこともできない。
 *
 * そこでログイン画面を描画するときに CSPRNG の nonce を発行し、
 *
 *   - nonce → トランザクション ID の対応をサーバー側ストアに保存する（TTL はトランザクションと同じ）
 *   - 同じ nonce を GIS の `data-nonce` に埋める
 *
 * とすると、Google が ID トークンの `nonce` クレームにその値を載せて返す。login_uri では
 * 署名検証を通った ID トークンの `nonce` でストアを引き、対応するトランザクションを復元する。
 * nonce は単回使用（引いた時点で削除）なので、同じ ID トークンを再送しても 2 度目は
 * `login_nonce_not_found` になる。
 *
 * この束縛は「Google が署名したトークンの中の値」でトランザクションを引くため、
 * 攻撃者が自分の Google アカウントのトークンを被害者のトランザクションに差し込むには
 * 被害者のログイン画面に埋まった nonce を知る必要がある。これは core の CSRF トークン
 * （ログインフォームに埋まる）と同じ露出範囲である。
 */
import { generateRandomString } from '@maronn-openid-connect/core';

import { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';

/** ストアキーのプレフィックス。core の `auth_txn:` と同じ発想で、他の記録と衝突させない。 */
const STORE_KEY_PREFIX = 'google_login_nonce:';

/** nonce のバイト長。base64url で 43 文字になる。 */
const NONCE_BYTE_LENGTH = 32;

/** nonce に対応するログイン試行の記録。 */
export interface GoogleLoginNonceRecord {
  /** この nonce を埋めたログイン画面が属する認証トランザクションの ID。 */
  transactionId: string;
  /** 記録の期限（Unix timestamp, ミリ秒）。トランザクションの `expiresAt` と同じ。 */
  expiresAt: number;
}

/**
 * nonce の記録を保存する KV ストアの契約。core の `AuthTransactionStore` と同じ形。
 *
 * 実装は `ttlSeconds` を過ぎた記録を返さなくてよい（返しても
 * {@link consumeGoogleLoginNonce} が期限切れとして拒否する）。
 */
export interface GoogleLoginNonceStore {
  /**
   * `key` のレコードを返し、なければ `null` を返す。
   *
   * 期限切れのレコードにも `null` を返してよい。
   * 返しても、{@link consumeGoogleLoginNonce} が期限切れとして拒否する。
   */
  get(key: string): Promise<GoogleLoginNonceRecord | null>;
  /**
   * レコードを `key` に `ttlSeconds` 秒の期限で保存する。
   *
   * 同じキーのレコードがあれば置き換える。
   */
  put(key: string, record: GoogleLoginNonceRecord, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface IssueGoogleLoginNonceOptions {
  /** ログイン画面が属する認証トランザクションの ID。 */
  transactionId: string;
  /** トランザクションの期限（Unix timestamp, ミリ秒）。nonce はこれより長く生きない。 */
  expiresAt: number;
  store: GoogleLoginNonceStore;
  /** 発行時刻。既定は現在時刻。テストでの差し替え用。 */
  now?: Date;
}

/**
 * トランザクションに対応付けた `nonce` を発行する。
 *
 * ログイン画面を描画するときに呼ぶ。
 * 32 バイトの乱数から `nonce` を作り、`google_login_nonce:` に `nonce` を続けたキーで、トランザクション ID と有効期限（`expiresAt`）のレコードを `options.store` に保存する。
 * ストアに渡す有効期間は、`expiresAt` までの残り時間を秒に切り上げた値で、短くても 1 秒にする。
 *
 * 返した `nonce` は、ログイン画面の設定（`./sign-in` の `buildGoogleSignInAttributes`）の `nonce` に渡す。
 * Google がその値を ID トークンの `nonce` クレームに入れて返すので、`login_uri` の処理でトランザクションを特定できる。
 *
 * @returns 発行した `nonce`（base64url で 43 文字）
 */
export async function issueGoogleLoginNonce(options: IssueGoogleLoginNonceOptions): Promise<string> {
  const now = (options.now ?? new Date()).getTime();
  const nonce = generateRandomString(NONCE_BYTE_LENGTH);
  const remainingTtlMs = options.expiresAt - now;
  const ttlSeconds = Math.max(1, Math.ceil(remainingTtlMs / 1000));

  await options.store.put(
    `${STORE_KEY_PREFIX}${nonce}`,
    { transactionId: options.transactionId, expiresAt: options.expiresAt },
    ttlSeconds,
  );
  return nonce;
}

/**
 * `nonce` のレコードを取り出して削除し、返す。
 *
 * レコードは 1 回しか使えず、2 回目の呼び出しは `login_nonce_not_found` になる。
 * 期限を判定する前に削除するので、期限切れのレコードもストアに残らない。
 *
 * ID トークンの署名を検証したあとに呼ぶ必要がある。
 * 検証の前に呼ぶと、`nonce` を知っているだけの第三者が偽のトークンでレコードを消費し、ログインを妨害できてしまう。
 *
 * @param nonce 検証済みの ID トークンの `nonce` クレームの値
 * @param store `nonce` のレコードを保存したストア
 * @param now 期限切れを判定する時刻（既定は現在時刻）
 * @throws {GoogleLoginError} `login_nonce_not_found`: レコードがないとき（この OP が発行していないか、使用済みの `nonce`）
 * @throws {GoogleLoginError} `login_nonce_expired`: レコードの有効期限が `now` 以前のとき
 */
export async function consumeGoogleLoginNonce(
  nonce: string,
  store: GoogleLoginNonceStore,
  now?: Date,
): Promise<GoogleLoginNonceRecord> {
  const key = `${STORE_KEY_PREFIX}${nonce}`;
  const record = await store.get(key);
  if (!record) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.LoginNonceNotFound,
      'Google login attempt not found. The login page may have expired or the credential was already used.',
    );
  }

  // `nonce` を 1 回しか使えないように、レコードを削除する。
  // 期限を判定する前に削除するので、期限切れのレコードもストアに残らない。
  await store.delete(key);

  if (record.expiresAt <= (now ?? new Date()).getTime()) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.LoginNonceExpired,
      'Google login attempt has expired. Please start the authorization flow again.',
    );
  }
  return record;
}
