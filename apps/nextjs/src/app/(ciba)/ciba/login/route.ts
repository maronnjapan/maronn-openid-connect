/**
 * EXPERIMENTAL — CIBA authentication device UI, sign in.
 *
 * Binding first, then CSRF, then credentials: the binding proves this is the
 * browser the login form was issued to, and it must gate the step that would
 * otherwise let a forged POST plant an OP session in the victim's browser.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { recordCibaLoginFailure, validateCibaLoginSubmission } from '@maronn-openid-connect/experimental/ciba';
import { generateRandomString } from '@maronn-openid-connect/core';
import { errorPage } from '../../../_oidc-provider/html';
import { readFormFields } from '../../../_oidc-provider/http';
import { cibaLoginTransactionStore } from '../../../_oidc-provider/features/ciba/store';
import { stores } from '../../../_oidc-provider/provider';
import { buildClearedCibaLoginBindingCookie, parseCibaLoginBindingSecret } from '../../../_oidc-provider/features/ciba/cookies';
import { buildSessionCookie } from '../../../_oidc-provider/cookies';
import { cibaConfig } from '../../../_oidc-provider/features/ciba/config';
import { loginScreen, pendingRequestsScreen, verificationFailureScreen } from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * エンドユーザーをログインさせ、一覧の画面を返す。
 *
 * `POST /ciba/login` の処理で、ログイントランザクションのバインディング Cookie、`csrf_token`、認証情報（ユーザー名とパスワード）の順に確かめる。
 * バインディング Cookie は、このブラウザがログインフォームを受け取ったブラウザであることを示す。
 * 偽造された POST で被害者のブラウザに OP のセッションが作られるのを防ぐため、認証情報より前に確かめる。
 *
 * トランザクションが見つからない、期限切れ、別のブラウザに渡したもの（バインディング Cookie が一致しない）、`csrf_token` が一致しない、のどれかに当たると、403 の OP のエラーページを返す。
 * 認証情報が誤っていれば、残りの試行回数を添えたログインフォームを返す。
 * 上限に達するとトランザクションを削除し、429 のエラーページを返す。
 * 成功するとトランザクションを削除して新しい ID の OP のセッションを保存し、自分宛ての保留中のリクエストの一覧を、セッションの Cookie とバインディング Cookie を消す Cookie を付けて返す。
 */
export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const transactionId = String(form.get('login_transaction_id') ?? '');

  let transaction;
  try {
    transaction = await validateCibaLoginSubmission({
      transactionId,
      csrfToken: String(form.get('csrf_token') ?? ''),
      bindingSecret: parseCibaLoginBindingSecret(request.headers.get('Cookie'), transactionId),
      store: cibaLoginTransactionStore,
    });
  } catch (error) {
    return verificationFailureScreen(error);
  }

  // ユーザー名とパスワードでエンドユーザーを認証する。
  // 独自の認証（LDAP、WebAuthn、上流の IdP など）に替えるときは、この呼び出しだけを差し替えればよく、前後の処理は変えずに済む。
  const user = await stores.userStore.authenticate(
    String(form.get('username') ?? ''),
    String(form.get('password') ?? ''),
  );
  if (!user) {
    // 失敗の回数をログイントランザクションに記録し、上限に達したらトランザクションを削除する。
    // 回数の制限は、トランザクションごとにしかかからない。
    // `/ciba` を開き直せば誰でも新しいトランザクションを作れるので、パスワードを試せる合計の回数は `/login` と同じく実質的に制限されない。
    // ユーザーごとの制限は、別に扱う課題である。
    const failure = await recordCibaLoginFailure(
      transaction,
      cibaLoginTransactionStore,
      cibaConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // トランザクションは削除されたので、このフォームからは再試行できない。
      return errorPage('Too many login attempts', 429);
    }
    return loginScreen({
      loginTransactionId: transaction.id,
      csrfToken: transaction.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failure.remainingAttempts,
    });
  }

  // ログイントランザクションは一度しか使えないので、ログインに成功したら削除する。
  // セッションは新しく作った ID で保存し、リクエストに含まれていた ID は使わない（セッション固定攻撃を防ぐ）。
  await cibaLoginTransactionStore.delete(transaction.id);
  const sessionId = generateRandomString(32);
  await stores.browserSessionStore.set(sessionId, {
    subject: user.sub,
    authTime: Math.floor(Date.now() / 1000),
  });

  // 一覧の画面に、新しい OP のセッションの Cookie と、バインディング Cookie を消す Cookie を付ける。
  // バインディング Cookie は一度しか使えず、消さなければ `Max-Age` まで残るためである。
  return pendingRequestsScreen(user.sub, [
    buildSessionCookie(sessionId),
    buildClearedCibaLoginBindingCookie(transaction.id),
  ]);
}
