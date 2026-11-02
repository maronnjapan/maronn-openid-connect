import { recordCibaLoginFailure, validateCibaLoginSubmission } from '@maronn-openid-connect/experimental/ciba';
import { generateRandomString } from '@maronn-openid-connect/core';
import {
  buildClearedCibaLoginBindingCookie,
  parseCibaLoginBindingSecret,
} from '../../../cookies.js';
import { buildSessionCookie } from '../../../../../cookies.js';
import { cibaConfig } from '../../../config.js';
import { type CibaOutcome, type CibaLoginSubmission, verificationFailure, listPendingRequests } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'submit-login',
  endpoint: 'ciba',
  feature: 'ciba',
  kind: 'validate',
  label: 'このブラウザでエンドユーザーをログインさせる',
  function: 'submitCibaLogin',
  consumes: ['loginTransaction'],
  produces: ['session'],
  removable: false,
});

/**
 * エンドユーザーをログインさせ、一覧の結果を返す。
 *
 * `POST /ciba/login` の処理で、バインディング Cookie、`csrf_token`、認証情報（ユーザー名とパスワード）の順に確かめる。
 * バインディング Cookie は、このブラウザがログインフォームを受け取ったブラウザであることを示す。
 * 偽造された POST で被害者のブラウザに OP のセッションが作られるのを防ぐため、認証情報より前に確かめる。
 *
 * ログイントランザクションが見つからない、期限切れ、別のブラウザに渡したもの（バインディング Cookie が一致しない）、`csrf_token` が一致しない、のどれかに当たると、`error`（403）の結果を返す。
 * 認証情報が誤っていれば失敗の回数を記録し、残りの回数を持つ `invalid_credentials` の結果を返す。
 * 上限に達するとトランザクションを削除し、`locked_out`（429）の結果を返す。
 * 成功するとトランザクションを削除して新しい ID の OP のセッションを保存し、保留中のリクエストと、セッションの Cookie とバインディング Cookie を消す Cookie を持つ `pending_requests` の結果を返す。
 */
export async function submitCibaLogin(c: any, input: CibaLoginSubmission): Promise<CibaOutcome> {
  const { loginTransactionId: transactionId, csrfToken, username, password } = input;

  const browserSessionStore = c.get('browserSessionStore');
  const loginTransactionStore = c.get('cibaLoginTransactionStore');
  const authenticateUser = c.get('authenticateUser');

  let transaction;
  try {
    transaction = await validateCibaLoginSubmission({
      transactionId,
      csrfToken,
      bindingSecret: parseCibaLoginBindingSecret(c.req.header('Cookie') ?? null, transactionId),
      store: loginTransactionStore,
    });
  } catch (error) {
    return verificationFailure(error);
  }

  // ユーザー名とパスワードでエンドユーザーを認証する。
  // 独自の認証（LDAP、WebAuthn、上流の IdP など）に替えるときは、この呼び出しだけを差し替えればよく、前後の処理は変えずに済む。
  const user = await authenticateUser(username, password);
  if (!user) {
    // 失敗の回数をログイントランザクションに記録し、上限に達したらトランザクションを削除する。
    // 回数の制限は、トランザクションごとにしかかからない。
    // `/ciba` を開き直せば誰でも新しいトランザクションを作れるので、パスワードを試せる合計の回数は `/login` と同じく実質的に制限されない。
    // ユーザーごとの制限は、別に扱う課題である。
    const failure = await recordCibaLoginFailure(
      transaction,
      loginTransactionStore,
      cibaConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // トランザクションは削除されたので、このフォームからは再試行できない。
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      loginTransactionId: transaction.id,
      csrfToken: transaction.csrfToken,
      remainingAttempts: failure.remainingAttempts,
    };
  }

  // ログイントランザクションは一度しか使えないので、ログインに成功したら削除する。
  // セッションは新しく作った ID で保存し、リクエストに含まれていた ID は使わない（セッション固定攻撃を防ぐ）。
  await loginTransactionStore.delete(transaction.id);
  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // 一覧の画面に、新しい OP のセッションの Cookie と、バインディング Cookie を消す Cookie を付ける。
  // バインディング Cookie は一度しか使えず、消さなければ `Max-Age` まで残るためである。
  return {
    kind: 'pending_requests',
    requests: await listPendingRequests(c, user.sub),
    cookies: [buildSessionCookie(sessionId), buildClearedCibaLoginBindingCookie(transaction.id)],
  };
}
