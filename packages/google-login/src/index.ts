/**
 * Sign in with Google（Google Identity Services, redirect mode）を
 * `@maronn-openid-connect/core` で組んだ OpenID Provider のログイン手段として使うための拡張。
 *
 * 単体で使う package ではない。core の認証トランザクション（`getAuthTransaction` /
 * `completeAuthTransaction`）と組み合わせ、CLI 生成コードのログイン画面と login_uri
 * ルートから各ステップ関数を呼び出す想定で API を切っている。
 *
 * ID トークンの検証は Google 公式の google-auth-library（`OAuth2Client.verifyIdToken`）に
 * 委ねる。このエントリポイント（サーバー側）は redirect mode の POST の読み取り、
 * Double Submit Cookie の検証、core の認証トランザクションへの束縛（nonce）を担う。
 *
 * ログイン画面（フロント側）の UI は生成しない。GIS の redirect mode に必要な設定属性は
 * `@maronn-openid-connect/google-login/sign-in`（Node 非依存のサブパス）が組み立て、
 * それをどう描くか（プレーン HTML / React / Vue）は利用側が決める。
 *
 * 参照ドキュメント:
 *   - Google ログインからの移行（redirect mode）
 *     https://developers.google.com/identity/gsi/web/guides/migration#redirect-mode_1
 *   - サーバーサイドで Google ID トークンを検証する
 *     https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
 */

export { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';

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
  // login_uri: ID トークン検証（本体は google-auth-library）と、その後の任意ステップ
  verifyGoogleIdToken,
  createGoogleIdTokenVerifier,
  getDefaultGoogleIdTokenVerifier,
  validateGoogleHostedDomain,
  validateGoogleEmailVerified,
  validateGoogleIdTokenNonce,
} from './id-token.js';

export type {
  GoogleIdTokenPayload,
  GoogleIdTokenVerifier,
  GoogleIdTokenVerifierOptions,
  VerifyGoogleIdTokenOptions,
} from './id-token.js';

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
