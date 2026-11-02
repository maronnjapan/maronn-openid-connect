'use server';

import { redirect } from 'next/navigation';
import {
  AuthTransactionError,
  AuthTransactionErrorCode,
  handleLoginFailure,
  validateCsrfToken,
} from '@maronn-openid-connect/core';
import { errorPagePath } from '../_oidc-provider/http';
import { stores } from '../_oidc-provider/provider';
import { requireSameOriginFormPost, requireTransaction } from '../_oidc-provider/transaction';
import { startSession } from './session';

/**
 * 認証情報を確かめ、同意画面へリダイレクトする。
 *
 * ログインフォームのサーバーアクションである。
 * 認証に成功すると OP のセッションを始め（`startSession()`）、同意画面へリダイレクトする。
 * パスワードが誤っていれば、エラーと残りの試行回数をクエリに入れてログイン画面へリダイレクトし、画面がそのメッセージを表示する。
 * 試行回数を使い切ったとき、フォームが別オリジンから送られたとき、`csrf_token` が一致しないときは、クライアントへは戻さず、OP のエラーページ（oidc-error/page.tsx）へリダイレクトする。
 * トランザクションが見つからないときは、`notFound()` でページの横の not-found.tsx を表示する。
 */
export async function loginAction(formData: FormData): Promise<void> {
  // 最初に、フォームの送信元を、ブラウザ自身が付けるヘッダーで確かめる。
  // この確認は、後で確かめる Cookie にも `csrf_token` にも依存しない。
  await requireSameOriginFormPost();

  // トランザクションの Cookie から、このブラウザが進めているトランザクションを読み込む。
  const { transactionId, transaction } = await requireTransaction();

  // `csrf_token` が一致すれば、このトランザクションのためにこのブラウザへ表示したフォームから送られたと分かる。
  try {
    validateCsrfToken(transaction, String(formData.get('csrf_token') ?? ''));
  } catch (error) {
    if (error instanceof AuthTransactionError) redirect(errorPagePath(error.code, error.message));
    throw error;
  }

  // ユーザーストアで認証情報を確かめる。
  // 独自の確認（LDAP、WebAuthn、上流の ID プロバイダなど）に差し替えるときは、この呼び出しだけを置き換えればよく、前後の処理は変えずに済む。
  const user = await stores.userStore.authenticate(
    String(formData.get('username') ?? ''),
    String(formData.get('password') ?? ''),
  );
  if (!user) {
    const failure = await handleLoginFailure(transactionId, transaction, stores.transactionStore);
    if (!failure.canRetry) {
      // `handleLoginFailure()` がトランザクションを削除したので、このログインは続けられない。
      redirect(
        errorPagePath(
          AuthTransactionErrorCode.MaxAttemptsExceeded,
          'Too many login attempts. Start again from the application.',
        ),
      );
    }
    const remaining = failure.maxAttempts - failure.failedAttempts;
    redirect(`/login?error=invalid_credentials&remaining=${remaining}`);
  }

  await startSession(transactionId, transaction, user.sub);
  redirect('/consent');
}
