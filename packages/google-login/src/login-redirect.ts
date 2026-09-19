/**
 * login_uri（redirect mode の POST 先）の処理を、Google のドキュメントの順序で合成した関数。
 *
 *   1. `Cookie` / POST 本文から `g_csrf_token` を取り出し Double Submit Cookie を検証する
 *   2. `credential`（ID トークン）を google-auth-library で検証し（署名 → aud → iss → exp）、
 *      任意の `hd` / `email_verified` を確認する
 *   3. 検証済みトークンの `nonce` からログイン試行の記録を引き、認証トランザクション ID を復元する
 *
 * 返り値の `transactionId` を core の `getAuthTransaction` に渡すと、通常のログイン
 * （ユーザー名 + パスワード）と同じ経路で認証セッションの確立と同意ステップへ進める。
 *
 * 生成コードはこの合成関数ではなく個々のステップ関数を順に呼び出すため、利用者は
 * 検証を削除したり独自処理を差し込んだりできる。
 */
import { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';
import { verifyGoogleIdToken } from './id-token.js';
import type { GoogleIdTokenPayload, GoogleIdTokenVerifier } from './id-token.js';
import { consumeGoogleLoginNonce } from './nonce.js';
import type { GoogleLoginNonceStore } from './nonce.js';
import {
  parseGoogleCsrfTokenCookie,
  parseGoogleRedirectCredential,
  validateGoogleCsrfToken,
} from './redirect-credential.js';
import type { GoogleLoginParamsSource } from './redirect-credential.js';

export interface GoogleLoginRedirectContext {
  /** POST 本文。 */
  params: GoogleLoginParamsSource;
  /** リクエストの `Cookie` ヘッダー。 */
  cookieHeader: string | null | undefined;
  /** `aud` と突き合わせるクライアント ID。 */
  clientId: string | readonly string[];
  /** ログイン画面の描画時に nonce を保存したストア。 */
  nonceStore: GoogleLoginNonceStore;
  /** ID トークンの verifier。既定はプロセス共有の google-auth-library 版。 */
  verifier?: GoogleIdTokenVerifier;
  /** 指定すると `hd` の一致を要求する。 */
  hostedDomain?: string | readonly string[];
  /** true なら `email_verified: true` を要求する。 */
  requireVerifiedEmail?: boolean;
  /** nonce の期限判定に使う現在時刻。既定は現在時刻。テストでの差し替え用。 */
  now?: Date;
}

export interface GoogleLoginRedirectResult {
  /** この Google ログインが属する認証トランザクションの ID。core の `getAuthTransaction` に渡す。 */
  transactionId: string;
  /** 検証済みの Google アカウント（ID トークンのペイロード）。 */
  account: GoogleIdTokenPayload;
  /** POST 本文の `select_by`。 */
  selectBy?: string;
}

/**
 * login_uri へ届いた POST を検証し、認証トランザクション ID と Google アカウントを返す。
 *
 * @throws {GoogleLoginError} 検証失敗時
 */
export async function handleGoogleLoginRedirect(
  context: GoogleLoginRedirectContext,
): Promise<GoogleLoginRedirectResult> {
  const cookieToken = parseGoogleCsrfTokenCookie(context.cookieHeader);
  const credential = parseGoogleRedirectCredential(context.params);
  validateGoogleCsrfToken(credential.csrfToken, cookieToken);

  const account = await verifyGoogleIdToken(credential.credential, {
    clientId: context.clientId,
    verifier: context.verifier,
    hostedDomain: context.hostedDomain,
    requireVerifiedEmail: context.requireVerifiedEmail,
  });

  const nonce = account.nonce;
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.InvalidNonce,
      'ID token does not carry the nonce issued for this login page',
    );
  }
  const record = await consumeGoogleLoginNonce(nonce, context.nonceStore, context.now);

  const result: GoogleLoginRedirectResult = {
    transactionId: record.transactionId,
    account,
  };
  if (credential.selectBy !== undefined) {
    result.selectBy = credential.selectBy;
  }
  return result;
}
