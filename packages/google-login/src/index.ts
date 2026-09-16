/**
 * Sign in with Google（Google Identity Services, redirect mode）を
 * `@maronn-openid-connect/core` で組んだ OpenID Provider のログイン手段として使うための拡張。
 *
 * 単体で使う package ではない。core の認証トランザクション（`getAuthTransaction` /
 * `completeAuthTransaction`）と組み合わせ、CLI 生成コードのログイン画面と login_uri
 * ルートから各ステップ関数を呼び出す想定で API を切っている。
 *
 * 参照ドキュメント:
 *   - Google ログインからの移行（redirect mode）
 *     https://developers.google.com/identity/gsi/web/guides/migration#redirect-mode_1
 *   - サーバーサイドで Google ID トークンを検証する
 *     https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
 */

export { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';

export {
  // ログイン画面: 「Google でログイン」ボタン（redirect mode）
  buildGoogleSignInMarkup,
  assertGoogleLoginUri,
  escapeHtmlAttribute,
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
  GOOGLE_SIGN_IN_CSP_SOURCES,
} from './sign-in-markup.js';

export type {
  GoogleSignInButtonOptions,
  GoogleSignInMarkupOptions,
} from './sign-in-markup.js';

export {
  // ログイン画面: 認証トランザクションへの束縛（nonce の発行と消費）
  issueGoogleLoginNonce,
  consumeGoogleLoginNonce,
} from './nonce.js';

export type {
  GoogleLoginNonceRecord,
  GoogleLoginNonceStore,
  IssueGoogleLoginNonceOptions,
} from './nonce.js';

export {
  // login_uri: redirect mode の POST の読み取りと Double Submit Cookie 検証のステップ関数
  parseGoogleRedirectCredential,
  parseGoogleCsrfTokenCookie,
  validateGoogleCsrfToken,
  readGoogleLoginParam,
  GOOGLE_CREDENTIAL_PARAM,
  GOOGLE_CSRF_TOKEN_PARAM,
  GOOGLE_CSRF_TOKEN_COOKIE,
  GOOGLE_SELECT_BY_PARAM,
} from './redirect-credential.js';

export type {
  GoogleLoginParamsSource,
  GoogleRedirectCredential,
} from './redirect-credential.js';

export {
  // login_uri: ID トークン検証のステップ関数（verifyGoogleIdToken はこれらの合成）
  verifyGoogleIdToken,
  decodeGoogleIdToken,
  resolveGoogleSigningKey,
  verifyGoogleIdTokenSignature,
  validateGoogleIdTokenAudience,
  validateGoogleIdTokenIssuer,
  validateGoogleIdTokenExpiration,
  validateGoogleHostedDomain,
  validateGoogleEmailVerified,
  validateGoogleIdTokenNonce,
  GOOGLE_ID_TOKEN_ISSUERS,
  GOOGLE_ID_TOKEN_SIGNING_ALG,
  DEFAULT_GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS,
} from './id-token.js';

export type {
  DecodedGoogleIdToken,
  GoogleIdTokenHeader,
  GoogleIdTokenPayload,
  GoogleIdTokenTimeOptions,
  VerifiedGoogleIdToken,
  VerifyGoogleIdTokenOptions,
} from './id-token.js';

export {
  // Google の公開鍵（JWK Set）の取得とキャッシュ
  createGoogleCertsKeyProvider,
  createStaticGoogleSigningKeyProvider,
  parseCacheControlMaxAge,
  parseJwkSet,
  GOOGLE_CERTS_URL,
  DEFAULT_CERTS_CACHE_TTL_SECONDS,
  DEFAULT_CERTS_MIN_REFRESH_INTERVAL_MS,
} from './certs.js';

export type {
  GoogleCertsKeyProvider,
  GoogleCertsKeyProviderOptions,
  GoogleJwk,
  GoogleSigningKeyProvider,
} from './certs.js';

export {
  // OP のユーザーとの対応付け
  resolveGoogleLoginSubject,
} from './account-resolver.js';

export type {
  GoogleAccountResolver,
} from './account-resolver.js';

export {
  // login_uri の処理を Google のドキュメントの順序で合成した関数
  handleGoogleLoginRedirect,
} from './login-redirect.js';

export type {
  GoogleLoginRedirectContext,
  GoogleLoginRedirectResult,
} from './login-redirect.js';
