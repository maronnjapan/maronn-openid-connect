import type { GoogleLoginOutcome } from './outcome.js';
import { discardSessionForFreshLogin } from './steps/discard-session-for-fresh-login.js';
import { establishBrowserSession } from './steps/establish-session.js';
import { handOffToConsent } from './steps/hand-off-to-consent.js';
import { loadTransactionById } from './steps/load-transaction.js';
import { verifyGoogleLoginCallback } from './steps/verify-google-callback.js';

/**
 * EXTENSION (google-login) — the Google login callback (login_uri), API layer.
 *
 * Sign in with Google (redirect mode) posts the ID token to POST
 * /login/google once the user picks an account. completeGoogleLogin() checks
 * it and establishes the OP session exactly like a password login — the last
 * steps are the login endpoint's own — and reports the outcome; page.ts
 * turns it into HTTP. Each block calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint login-google`).
 */

export type { GoogleLoginOutcome } from './outcome.js';

/**
 * ステップを順に実行し、ログインの結果を返す。
 *
 * `POST /login/google` の処理である。
 * Google の ID トークンと `nonce` を検証してアカウントに対応する OP のユーザーを特定し、`nonce` を発行したトランザクションを読み込んで、OP のセッションを確立し、同意のステップに引き継ぐ。
 * トランザクションの読み込みから同意のステップへの引き継ぎまでは、パスワードによるログイン（`POST /login`）と同じ関数を使う。
 *
 * 成功すると、セッションの Cookie を付けた `authenticated` を返す。
 * 検証かトランザクションの読み込みに失敗すると、そのステップが返したエラーを返し、セッションは作らない。
 * `config.googleLogin` が設定されていなければ、何もせずに `not_configured` を返す。
 * `page.ts` がこの結果を、同意画面へのリダイレクトかエラーページにして応答する。
 */
export async function completeGoogleLogin(c: any): Promise<GoogleLoginOutcome> {
  const config = c.get('config');
  if (!config.googleLogin) {
    return { kind: 'not_configured' };
  }

  // [verify-google-callback] Verify the posted Google ID token and nonce
  const verified = await verifyGoogleLoginCallback(c, config.googleLogin);
  if ('kind' in verified) return verified;
  const { transactionId, subject } = verified;

  // [load-transaction] The nonce named the transaction; load it from the store.
  const loaded = await loadTransactionById(c, transactionId);
  if ('kind' in loaded) return loaded;
  const { transaction } = loaded;

  // [discard-session-for-fresh-login] prompt=login: discard the existing session — OIDC Core 1.0 §3.1.2.1
  await discardSessionForFreshLogin(c, transactionId, transaction);

  // [establish-session] Establish the OP browser session — OIDC Core 1.0 §3.1.2.3
  const { sessionId, authTime } = await establishBrowserSession(c, subject);

  // [hand-off-to-consent] Store the authenticated subject for the consent step
  return handOffToConsent(c, transactionId, subject, sessionId, authTime);
}
