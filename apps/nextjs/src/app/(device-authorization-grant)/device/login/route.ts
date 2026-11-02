/**
 * EXPERIMENTAL — device verification UI, step 2: sign in (RFC 8628 §3.3).
 *
 * Binding first, then CSRF, then credentials: the binding proves this is the
 * browser that submitted the user_code, and it must gate the step that would
 * otherwise let a forged POST plant an OP session in the victim's browser
 * (login CSRF).
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import {
  findPendingRecordByUserCode,
  recordDeviceLoginFailure,
  validateVerificationBinding,
  validateVerificationCsrfToken,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { generateRandomString } from '@maronn-openid-connect/core';
import { errorPage } from '../../../_oidc-provider/html';
import { readFormFields } from '../../../_oidc-provider/http';
import { deviceAuthorizationStore } from '../../../_oidc-provider/features/device-authorization-grant/store';
import { stores } from '../../../_oidc-provider/provider';
import { buildSessionCookie } from '../../../_oidc-provider/cookies';
import { parseDeviceBindingSecret } from '../../../_oidc-provider/features/device-authorization-grant/cookies';
import { resolveGrantableScopes } from '../../../_oidc-provider/scopes';
import { deviceAuthorizationConfig } from '../../../_oidc-provider/features/device-authorization-grant/config';
import {
  approvalScreen,
  invalidUserCodeScreen,
  loginScreen,
  verificationFailureScreen,
} from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * エンドユーザーをログインさせ、承認画面を返す。
 *
 * `POST /device/login` の処理で、`user_code`、バインディング Cookie、`csrf_token`、認証情報（ユーザー名とパスワード）の順に確かめる。
 * バインディング Cookie は、このブラウザが `user_code` を送信したブラウザであることを示す。
 * 偽造された POST で被害者のブラウザに OP のセッションが作られるのを防ぐため、認証情報より前に確かめる。
 *
 * `user_code` が未知、期限切れ、使用済みのどれかなら、ユーザーコードの入力フォームを 400 で返す。
 * バインディング Cookie か `csrf_token` がないか一致しなければ、403 の OP のエラーページを返す。
 * 認証情報が誤っていれば、残りの試行回数を添えたログインフォームを返す。
 * 上限に達するとデバイスのリクエストを拒否の状態にし、429 のエラーページを返す。
 * 成功すると新しい ID の OP のセッションを保存し、デバイスの承認画面を、セッションの Cookie を付けて返す。
 *
 * @spec RFC 8628 §3.3
 */
export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const submittedUserCode = String(form.get('user_code') ?? '');
  const csrfToken = String(form.get('csrf_token') ?? '');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceAuthorizationStore);
  if (!record) {
    return invalidUserCodeScreen(submittedUserCode);
  }

  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(request.headers.get('Cookie'), record.userCode),
    );
    validateVerificationCsrfToken(record, csrfToken);
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
    // 失敗の回数をレコードに記録し、上限に達したらレコードを拒否の状態にする。
    // 回数の制限は、レコードごとにしかかからない。
    // デバイス認可グラントを使えるクライアントを持つ攻撃者はレコードをいくらでも作れるので、パスワードを試せる合計の回数は `/login` と同じく実質的に制限されない。
    // ユーザーごとの制限は、別に扱う課題である。
    const failure = await recordDeviceLoginFailure(
      record,
      deviceAuthorizationStore,
      deviceAuthorizationConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // レコードは拒否の状態になったので、デバイスは次のポーリングで `access_denied` を受け取る。
      return errorPage('Too many login attempts', 429);
    }
    return loginScreen({
      userCode: record.userCodeDisplay,
      csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: failure.remainingAttempts,
    });
  }

  const sessionId = generateRandomString(32);
  await stores.browserSessionStore.set(sessionId, {
    subject: user.sub,
    authTime: Math.floor(Date.now() / 1000),
  });

  // 承認画面に、新しい OP のセッションの Cookie を付ける。
  // 承認の送信でも、ブラウザはバインディング Cookie をもう一度提示する必要がある。
  return approvalScreen(
    {
      userCode: record.userCodeDisplay,
      csrfToken,
      clientId: record.clientId,
      scopes: await resolveGrantableScopes(record.scope, user.sub),
    },
    [buildSessionCookie(sessionId)],
  );
}
