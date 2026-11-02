/**
 * Google の ID トークンの検証。
 *
 * 検証の本体は Google 公式の `google-auth-library`（`OAuth2Client.verifyIdToken`）に委ねる。
 * Google のドキュメント「サーバーサイドで Google ID トークンを検証する」の Node.js サンプルと
 * 同じ経路で、次をライブラリが行う。
 *
 *   - Google の公開鍵の取得と、レスポンスの `Cache-Control` に従ったキャッシュ（鍵のローテーション追随）
 *   - 署名の検証
 *   - `aud` がアプリのクライアント ID（複数可）と一致すること
 *   - `iss` が `accounts.google.com` または `https://accounts.google.com` であること
 *   - `exp` が経過していないこと（`iat` が未来でないことも含む）
 *
 * 公開鍵のエンドポイントや検証ルールが Google 側で変わっても、このパッケージではなく
 * ライブラリの更新で追随する。ドキュメントが「任意」としている `hd` の確認と、
 * このパッケージ固有の `email_verified` / `nonce` の確認だけをここで行う。
 */
import { gaxios, OAuth2Client } from 'google-auth-library';
import type { OAuth2ClientOptions, TokenPayload } from 'google-auth-library';

import { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';

/**
 * 検証済み ID トークンのペイロード。google-auth-library の `TokenPayload` そのもの。
 *
 * `sub` がユーザーの一意な識別子であり、`email` はユーザーが変更できるためアカウントの
 * キーには使わないこと。
 */
export type GoogleIdTokenPayload = TokenPayload;

/**
 * ID トークンを検証して、検証済みのペイロードを返すインターフェース。
 *
 * 既定の実装は {@link createGoogleIdTokenVerifier}（google-auth-library）。テストや
 * 特殊な環境では差し替えられる。
 */
export interface GoogleIdTokenVerifier {
  /**
   * @param idToken Google が発行した ID トークン
   * @param clientId `aud` と突き合わせるクライアント ID（複数可）
   * @throws {GoogleLoginError} `invalid_id_token` / `signing_key_unavailable`
   */
  verify(idToken: string, clientId: string | readonly string[]): Promise<GoogleIdTokenPayload>;
}

export interface GoogleIdTokenVerifierOptions {
  /**
   * 検証に使う `OAuth2Client`。省略時は `clientOptions` から生成する。
   * 公開鍵のキャッシュはインスタンスが持つので、プロセスごとに 1 つを使い回すこと。
   */
  client?: OAuth2Client;
  /**
   * `OAuth2Client` のコンストラクタオプション（`transporter` / `transporterOptions` /
   * `endpoints` など）。プロキシ経由で Google に到達する構成や、テストで公開鍵の
   * 取得先を差し替えるときに使う。`client` を渡した場合は無視する。
   */
  clientOptions?: OAuth2ClientOptions;
}

/**
 * 値が空でない文字列なら `true` を返す。
 *
 * 型ガードなので、`true` を返したあとは `value` を `string` として扱える。
 * 長さだけを見るので、空白だけの文字列にも `true` を返す。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 文字列か文字列の配列を、新しい配列にして返す。
 *
 * 文字列は要素が 1 つの配列にし、配列は複製する。
 * 要素の重複は取り除かない。
 * 投げる `TypeError` のメッセージは `label` で始まる。
 *
 * @throws {TypeError} `value` が空文字か空の配列のとき、または空文字や文字列でない要素を含むとき
 */
function normalizeList(value: string | readonly string[], label: string): string[] {
  const list = typeof value === 'string' ? [value] : [...value];
  if (list.length === 0 || !list.every(isNonEmptyString)) {
    throw new TypeError(`${label} must be a non-empty string or a non-empty array of non-empty strings`);
  }
  return list;
}

/**
 * 検証のエラーを `GoogleLoginError` に変換して返す。
 *
 * Google の公開鍵を取得できなかったことを示すエラーは `signing_key_unavailable`（503）にする。
 * gaxios の HTTP エラーと、メッセージが `Failed to retrieve verification certificates` で始まるエラー（ライブラリが公開鍵の取得の失敗に付ける文言）がこれに当たる。
 * 鍵を取得できないのは一時的な障害であり、トークンが不正だったわけではないので、`invalid_id_token` と分ける。
 *
 * それ以外のエラーは、トークンを受け入れなかったものとして `invalid_id_token`（401）にする。
 * どちらの場合も、元のエラーを `cause` に入れ、そのメッセージをそのまま使う。
 */
function toGoogleLoginError(error: unknown): GoogleLoginError {
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof gaxios.GaxiosError ||
    message.startsWith('Failed to retrieve verification certificates')
  ) {
    return new GoogleLoginError(GoogleLoginErrorCode.SigningKeyUnavailable, message, { cause: error });
  }
  return new GoogleLoginError(GoogleLoginErrorCode.InvalidIdToken, message, { cause: error });
}

/**
 * ID トークンを検証する `GoogleIdTokenVerifier` を作る。
 *
 * 返すオブジェクトの `verify()` は、google-auth-library の `OAuth2Client.verifyIdToken` で ID トークンを検証し、ペイロードを返す。
 * 手順は Google のドキュメントの Node.js のサンプルと同じで、`new OAuth2Client()`、`client.verifyIdToken({ idToken, audience })`、`ticket.getPayload()` の順に呼ぶ。
 * `options.client` を渡せばその `OAuth2Client` を使い、渡さなければ `options.clientOptions` で新しく作る。
 *
 * `verify()` は次のときに投げる。
 * - `clientId` が空のとき: `TypeError`
 * - ID トークンが空文字のとき: `invalid_id_token`（ライブラリは呼ばない）
 * - ライブラリが検証に失敗したとき: {@link GoogleLoginError} に変換したエラー（`invalid_id_token` か `signing_key_unavailable`）
 * - ペイロードがないとき: `invalid_id_token`
 */
export function createGoogleIdTokenVerifier(
  options: GoogleIdTokenVerifierOptions = {},
): GoogleIdTokenVerifier {
  const client = options.client ?? new OAuth2Client(options.clientOptions);

  return {
    async verify(idToken, clientId) {
      const audience = normalizeList(clientId, 'clientId');
      if (!isNonEmptyString(idToken)) {
        throw new GoogleLoginError(GoogleLoginErrorCode.InvalidIdToken, 'ID token is empty');
      }

      let payload: TokenPayload | undefined;
      try {
        const ticket = await client.verifyIdToken({ idToken, audience });
        payload = ticket.getPayload();
      } catch (error) {
        throw toGoogleLoginError(error);
      }
      if (payload === undefined) {
        throw new GoogleLoginError(GoogleLoginErrorCode.InvalidIdToken, 'ID token has no payload');
      }
      return payload;
    },
  };
}

let defaultVerifier: GoogleIdTokenVerifier | undefined;

/**
 * プロセスで共有する ID トークンの検証器を返す。
 *
 * 初めて呼ばれたときに {@link createGoogleIdTokenVerifier} で既定のオプションのまま作り、以後は同じ {@link GoogleIdTokenVerifier} を返す。
 * Google の公開鍵のキャッシュは `OAuth2Client` のインスタンスにあり、`Cache-Control` の期間は公開鍵を取得し直さない。
 * 検証のたびに作り直すと、そのたびに公開鍵を取得することになる。
 */
export function getDefaultGoogleIdTokenVerifier(): GoogleIdTokenVerifier {
  defaultVerifier ??= createGoogleIdTokenVerifier();
  return defaultVerifier;
}

/**
 * `hd` が許可したドメインのどれかであることを検証する。
 *
 * ログインを組織のアカウントに限るときに使う、任意の検証である。
 * `hd` は、アカウントを管理する組織のドメインを示すクレームで、個人の Google アカウントには付かない。
 * Google のドキュメントによれば、組織のユーザーだけを受け入れる場合は `hd` を確かめる必要がある。
 *
 * `hostedDomain` を渡さなければ何も確かめない。
 * 渡した場合は、`hd` のないトークン（個人の Google アカウント）も拒否する。
 *
 * @throws {GoogleLoginError} `invalid_hosted_domain`: `hd` がないか、`hostedDomain` のどれとも一致しないとき
 * @throws {TypeError} `hostedDomain` が空文字か空の配列のとき、または空文字を含むとき
 */
export function validateGoogleHostedDomain(
  payload: GoogleIdTokenPayload,
  hostedDomain?: string | readonly string[],
): void {
  if (hostedDomain === undefined) return;
  const allowed = normalizeList(hostedDomain, 'hostedDomain');
  if (!isNonEmptyString(payload.hd) || !allowed.includes(payload.hd)) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.InvalidHostedDomain,
      'ID token hd does not match the allowed hosted domain',
    );
  }
}

/**
 * `email_verified` が `true` であることを検証する。
 *
 * 任意の検証だが、メールアドレスで OP のユーザーと対応付ける構成では必須になる。
 * 確かめないと、メールアドレスを検証していない Google アカウントが、同じメールアドレスを使う他人の OP のアカウントに結び付いてしまうためである。
 *
 * 値が `true` そのもののときだけ通し、文字列の `"true"` やクレームがない場合は拒否する。
 *
 * @throws {GoogleLoginError} `email_not_verified`: `email_verified` が `true` でないとき
 */
export function validateGoogleEmailVerified(payload: GoogleIdTokenPayload): void {
  if (payload.email_verified !== true) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.EmailNotVerified,
      'ID token email is not verified',
    );
  }
}

/**
 * `nonce` クレームが期待値と一致することを検証する。
 *
 * `nonce` をストア（{@link consumeGoogleLoginNonce}）ではなく Cookie やセッションに保持する構成で使う、任意の検証である。
 * `expectedNonce` を渡さなければ何も確かめない。
 * 渡した場合は、`nonce` のないトークンも拒否する。
 *
 * @throws {GoogleLoginError} `invalid_nonce`: `nonce` がないか、`expectedNonce` と一致しないとき
 */
export function validateGoogleIdTokenNonce(payload: GoogleIdTokenPayload, expectedNonce?: string): void {
  if (expectedNonce === undefined) return;
  if (!isNonEmptyString(payload.nonce) || payload.nonce !== expectedNonce) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.InvalidNonce,
      'ID token nonce does not match the expected value',
    );
  }
}

export interface VerifyGoogleIdTokenOptions {
  /**
   * `aud` と突き合わせるクライアント ID。複数のクライアント（Web / Android / iOS）から
   * 同じバックエンドへ ID トークンが届く構成では配列で渡す。
   */
  clientId: string | readonly string[];
  /** 検証に使う verifier。既定は {@link getDefaultGoogleIdTokenVerifier}。 */
  verifier?: GoogleIdTokenVerifier;
  /** 指定すると `hd` がこのドメイン（のいずれか）と一致することを要求する。 */
  hostedDomain?: string | readonly string[];
  /** true なら `email_verified: true` を要求する。メールでアカウントを対応付ける構成向け。 */
  requireVerifiedEmail?: boolean;
  /** 指定すると `nonce` クレームがこの値と一致することを要求する。 */
  expectedNonce?: string;
}

/**
 * Google の ID トークンを検証し、ペイロードを返す。
 *
 * まず検証器（`options.verifier`）で ID トークンを検証する。
 * 既定の検証器（{@link getDefaultGoogleIdTokenVerifier}）は、google-auth-library で署名、`iss`、`aud`、有効期限を検証する。
 * 続けて、オプションで求めた項目だけを、`hd`（`hostedDomain`）、`email_verified`（`requireVerifiedEmail`）、`nonce`（`expectedNonce`）の順に確かめる。
 *
 * 生成されたコードは、この関数を使わずに、検証器と個々の検証の関数を順に呼んでもよい。
 *
 * @throws {GoogleLoginError} `invalid_id_token` か `signing_key_unavailable`: 検証器が ID トークンを受け入れなかったとき
 * @throws {GoogleLoginError} `invalid_hosted_domain`、`email_not_verified`、`invalid_nonce`: オプションで求めた確認に通らなかったとき
 */
export async function verifyGoogleIdToken(
  idToken: string,
  options: VerifyGoogleIdTokenOptions,
): Promise<GoogleIdTokenPayload> {
  const verifier = options.verifier ?? getDefaultGoogleIdTokenVerifier();
  const payload = await verifier.verify(idToken, options.clientId);

  validateGoogleHostedDomain(payload, options.hostedDomain);
  if (options.requireVerifiedEmail) {
    validateGoogleEmailVerified(payload);
  }
  validateGoogleIdTokenNonce(payload, options.expectedNonce);

  return payload;
}
