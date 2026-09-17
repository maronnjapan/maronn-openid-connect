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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeList(value: string | readonly string[], label: string): string[] {
  const list = typeof value === 'string' ? [value] : [...value];
  if (list.length === 0 || !list.every(isNonEmptyString)) {
    throw new TypeError(`${label} must be a non-empty string or a non-empty array of non-empty strings`);
  }
  return list;
}

/**
 * ライブラリのエラーを {@link GoogleLoginError} に写す。
 *
 * 公開鍵の取得失敗（gaxios の HTTP エラー。ライブラリは message に
 * "Failed to retrieve verification certificates" を前置する）は一時的な障害なので
 * `signing_key_unavailable`（503）、それ以外はトークン自体の拒否として `invalid_id_token`（401）。
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
 * google-auth-library の `OAuth2Client.verifyIdToken` で検証する {@link GoogleIdTokenVerifier} を作る。
 *
 * Google のドキュメントの Node.js サンプル
 * （`new OAuth2Client()` → `client.verifyIdToken({ idToken, audience })` → `ticket.getPayload()`）
 * をそのまま行い、失敗を {@link GoogleLoginError} に写す。
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
 * プロセスで共有する既定の {@link GoogleIdTokenVerifier}（初回呼び出し時に生成）。
 *
 * `OAuth2Client` は Google の公開鍵を `Cache-Control` の間キャッシュするので、
 * 検証のたびに作り直さず 1 つを使い回す。
 */
export function getDefaultGoogleIdTokenVerifier(): GoogleIdTokenVerifier {
  defaultVerifier ??= createGoogleIdTokenVerifier();
  return defaultVerifier;
}

/**
 * ステップ（任意）: `hd` が許可したホストされたドメインと一致することを検証する。
 *
 * Google のドキュメント: Google Workspace / Cloud organization のユーザーに制限する場合は
 * `hd` クレームを確認する。`hostedDomain` を渡さなければ何もしない。渡した場合、`hd` が無い
 * トークン（個人の Google アカウント）は拒否する。
 *
 * @throws {GoogleLoginError} `invalid_hosted_domain`
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
 * ステップ（任意）: `email_verified` が true であることを検証する。
 *
 * メールアドレスで OP のユーザーと対応付ける構成では、未検証のメールを持つ Google
 * アカウントが他人のアカウントへ結びつくのを防ぐために必須。
 *
 * @throws {GoogleLoginError} `email_not_verified`
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
 * ステップ（任意）: `nonce` が期待値と一致することを検証する。
 *
 * `expectedNonce` を渡さなければ何もしない。渡した場合、`nonce` が無いトークンは拒否する。
 * nonce をストア（{@link consumeGoogleLoginNonce}）ではなく Cookie やセッションで持つ
 * 構成向け。
 *
 * @throws {GoogleLoginError} `invalid_nonce`
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
 * Google の ID トークンを検証し、検証済みのペイロードを返す。
 *
 * google-auth-library による検証（署名 → `aud` → `iss` → `exp`）のあと、任意の
 * `hd` / `email_verified` / `nonce` を確認する。生成コードはこの合成関数ではなく
 * verifier と個々のステップ関数を順に呼び出してもよい。
 *
 * @throws {GoogleLoginError} 検証失敗時
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
