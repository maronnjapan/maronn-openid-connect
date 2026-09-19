/**
 * Sign in with Google（Google Identity Services）を OP のログイン手段として組み込むときのエラー型。
 *
 * `httpStatusCode` は生成コードが応答ステータスを決めるための目安。core の
 * `AuthTransactionError` と同じ形（`code` + `httpStatusCode`）にしてあり、生成コードは
 * 同じ catch 節で扱える。
 */
export enum GoogleLoginErrorCode {
  // --- redirect mode の POST（login_uri）に関するもの ---
  /** POST 本文に `credential` が無い。 */
  MissingCredential = 'missing_credential',
  /**
   * `g_csrf_token` Cookie が無い。
   * Google のドキュメント（サーバーサイドでの ID トークン検証 / CSRF 対策）が示す
   * Double Submit Cookie 検証の 1 段目。
   */
  CsrfTokenMissingInCookie = 'csrf_token_missing_in_cookie',
  /** POST 本文に `g_csrf_token` が無い（Double Submit Cookie 検証の 2 段目）。 */
  CsrfTokenMissingInBody = 'csrf_token_missing_in_body',
  /** Cookie と POST 本文の `g_csrf_token` が一致しない（Double Submit Cookie 検証の 3 段目）。 */
  CsrfTokenMismatch = 'csrf_token_mismatch',

  // --- ID トークンの検証に関するもの ---
  /**
   * google-auth-library が ID トークンを受け入れなかった（形式・署名・`iss`・`aud`・
   * `exp` / `iat`）。ライブラリのエラーは `cause` に入れ、`message` はそのまま引き継ぐ。
   */
  InvalidIdToken = 'invalid_id_token',
  /** Google の公開鍵を取得できない（ネットワーク障害など）。ライブラリのエラーは `cause` に入れる。 */
  SigningKeyUnavailable = 'signing_key_unavailable',
  /** `hd`（ホストされたドメイン）が許可したドメインと一致しない。 */
  InvalidHostedDomain = 'invalid_hosted_domain',
  /** `email_verified` が true ではない（`requireVerifiedEmail` 指定時）。 */
  EmailNotVerified = 'email_not_verified',
  /** `nonce` が無い、または期待値と一致しない。 */
  InvalidNonce = 'invalid_nonce',

  // --- OP のログイントランザクションへの束縛に関するもの ---
  /** `nonce` に対応するログイン試行の記録が無い（この OP が発行した nonce ではない、または使用済み）。 */
  LoginNonceNotFound = 'login_nonce_not_found',
  /** `nonce` に対応するログイン試行の記録が期限切れ。 */
  LoginNonceExpired = 'login_nonce_expired',

  // --- OP のユーザーとの対応付けに関するもの ---
  /** 検証済みの Google アカウントに対応する OP の subject が無い。 */
  AccountNotLinked = 'account_not_linked',
}

/**
 * Google ログイン処理のエラー。
 */
export class GoogleLoginError extends Error {
  public readonly code: GoogleLoginErrorCode;

  constructor(code: GoogleLoginErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GoogleLoginError';
    this.code = code;
  }

  /**
   * HTTP ステータスコードの目安。
   *
   * - 400: リクエストの形が想定と違う。Google のドキュメントの CSRF 検証サンプルは
   *   3 つの失敗（Cookie 無し / 本文無し / 不一致）をいずれも 400 で止めており、それに合わせる。
   *   nonce の不備も「この OP が始めたログイン試行ではない」という意味で core の
   *   `transaction_not_found` と同じ 400 にする
   * - 401: 提示された資格情報（ID トークン）を受け入れられない
   * - 403: 資格情報は正しいが、この OP がそのアカウントを受け入れない（`hd` 不一致・未連携など）
   * - 503: Google の公開鍵を取得できず検証そのものができない（一時的な障害）
   */
  get httpStatusCode(): number {
    switch (this.code) {
      case GoogleLoginErrorCode.MissingCredential:
      case GoogleLoginErrorCode.CsrfTokenMissingInCookie:
      case GoogleLoginErrorCode.CsrfTokenMissingInBody:
      case GoogleLoginErrorCode.CsrfTokenMismatch:
      case GoogleLoginErrorCode.InvalidNonce:
      case GoogleLoginErrorCode.LoginNonceNotFound:
      case GoogleLoginErrorCode.LoginNonceExpired:
        return 400;
      case GoogleLoginErrorCode.InvalidIdToken:
        return 401;
      case GoogleLoginErrorCode.InvalidHostedDomain:
      case GoogleLoginErrorCode.EmailNotVerified:
      case GoogleLoginErrorCode.AccountNotLinked:
        return 403;
      case GoogleLoginErrorCode.SigningKeyUnavailable:
        return 503;
    }
  }
}
