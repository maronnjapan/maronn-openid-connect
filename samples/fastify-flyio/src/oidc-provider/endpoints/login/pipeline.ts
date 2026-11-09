import type { LoginError, LoginOutcome, LoginScreen, LoginSubmission } from './screen.js';
import { authenticateEndUser } from './steps/authenticate-user.js';
import { describeLoginScreen } from './steps/describe-login-screen.js';
import { discardSessionForFreshLogin } from './steps/discard-session-for-fresh-login.js';
import { establishBrowserSession } from './steps/establish-session.js';
import { handOffToConsent } from './steps/hand-off-to-consent.js';
import { loadTransaction } from './steps/load-transaction.js';
import { recordLoginFailure } from './steps/record-login-failure.js';
import { rejectCrossOriginFormPost } from './steps/reject-cross-origin-post.js';
import { validateLoginCsrfToken } from './steps/validate-csrf-token.js';

/**
 * Login step (API layer: logic only).
 *
 * Everything the login screen has to decide is a step (steps/), one box of
 * `maronn-oidc graph --detail steps --endpoint login`: finding the
 * transaction through the transaction cookie (loadTransaction), the
 * csrf_token check (validateLoginCsrfToken), the credential check
 * (authenticateEndUser), the lockout (recordLoginFailure), the OP session
 * cookie (establishBrowserSession) and the hand-off to the consent step
 * (handOffToConsent). None of them builds a Response — each returns an
 * outcome, and page.tsx turns that outcome into a screen or a redirect.
 * prepareLogin() (GET) and submitLogin() (POST) run them in the order the
 * screen needs, so the UI can be changed without touching this file.
 */

/**
 * トランザクションを読み込み、ログイン画面の内容を返す。
 *
 * GET `/login` のハンドラ（page.tsx）が呼ぶ。
 * トランザクションは、ブラウザの Cookie が指すものを読み込む。
 * ログイン画面の内容は、`csrf_token`、`login_hint`、機能が加えるほかのログイン方法の表示である。
 * トランザクションを読み込めないときは、代わりに表示するエラー（`kind: 'error'`）を返す。
 */
export async function prepareLogin(c: any): Promise<LoginScreen | LoginError> {
  // [load-transaction] Cookie が指すトランザクションを読み込む
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;

  // [describe-login-screen] ログイン画面の表示内容を組み立てる — OIDC Core 1.0 §3.1.2.1 (login_hint)
  return describeLoginScreen(c, loaded.transactionId, loaded.transaction);
}

/**
 * 認証情報を確かめ、合えば OP のセッションを確立する。
 *
 * POST `/login` のハンドラ（page.tsx）が呼ぶ。
 * 認証に成功すると、OP のセッションを確立し、セッションの Cookie を含む `authenticated` を返す。
 * 認証情報が誤っていれば失敗を数え、試行回数が残っていれば再表示するフォームの内容と残りの回数を含む `invalid_credentials` を、使い切っていれば `locked_out` を返す。
 * フォームが別オリジンから送られたとき、トランザクションが見つからないとき、`csrf_token` が一致しないときは、エラー（`kind: 'error'`）を返す。
 *
 * ステップの順は画面に合わせて固定してある（`maronn-oidc graph --detail steps --endpoint login` で確かめられる）。
 */
export async function submitLogin(c: any, input: LoginSubmission): Promise<LoginOutcome> {
  const { csrfToken, username, password } = input;

  // [reject-cross-origin-post] 別オリジンからのフォーム POST を拒否する
  // 最初に、フォームの送信元を、ブラウザ自身が付けるヘッダーで確かめる（cookies.ts の `isSameOriginFormPost()`）。
  // この確認は Cookie にも `csrf_token` にも依存しないので、両方を仕込まれていても偽造された POST を止められる。
  const sameOriginError = rejectCrossOriginFormPost(c);
  if (sameOriginError) return sameOriginError;

  // [load-transaction] Cookie が指すトランザクションを読み込む
  const loaded = await loadTransaction(c, [input.transactionId]);
  if ('kind' in loaded) return loaded;
  const { transactionId, transaction } = loaded;

  // [validate-csrf-token] csrf_token をトランザクションと照合する
  // 一致すれば、このトランザクションのために OP が描画したフォームから送られたと分かる。
  const csrfError = validateLoginCsrfToken(transaction, csrfToken);
  if (csrfError) return csrfError;

  // [authenticate-user] 認証情報を確かめる
  const user = await authenticateEndUser(c, username, password);
  if (!user) {
    // [record-login-failure] 失敗した試行を数える（ロックアウト）
    // 試行回数を使い切ったときはトランザクションを削除して `locked_out` を返し、残っているときは残りの回数を添えてフォームを再表示する。
    const failure = await recordLoginFailure(c, transactionId, transaction);
    if (!failure.canRetry) {
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      screen: await describeLoginScreen(c, transactionId, transaction),
      remainingAttempts: failure.remainingAttempts,
    };
  }

  // [discard-session-for-fresh-login] prompt=login: 既存のセッションを破棄する — OIDC Core 1.0 §3.1.2.1
  await discardSessionForFreshLogin(c, transactionId, transaction);

  // [establish-session] ブラウザに OP のセッションを確立する — OIDC Core 1.0 §3.1.2.3
  const { sessionId, authTime } = await establishBrowserSession(c, user.sub);

  // [hand-off-to-consent] 認証したサブジェクトを同意のために保存する
  return handOffToConsent(c, transactionId, user.sub, sessionId, authTime);
}
