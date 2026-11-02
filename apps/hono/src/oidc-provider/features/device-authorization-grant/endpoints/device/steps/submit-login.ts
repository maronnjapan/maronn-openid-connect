import {
  findPendingRecordByUserCode,
  recordDeviceLoginFailure,
  validateVerificationBinding,
  validateVerificationCsrfToken,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { generateRandomString } from '@maronn-openid-connect/core';
import { buildSessionCookie } from '../../../../../cookies.js';
import { parseDeviceBindingSecret } from '../../../cookies.js';
import { deviceAuthorizationConfig } from '../../../config.js';
import { resolveGrantableScopes } from '../../../../../scopes.js';
import { type DeviceOutcome, type DeviceLoginSubmission, verificationFailure } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'submit-login',
  endpoint: 'device',
  feature: 'device-authorization-grant',
  kind: 'validate',
  label: 'このブラウザでエンドユーザーをログインさせる',
  spec: 'RFC 8628 §3.3',
  function: 'submitDeviceLogin',
  consumes: ['record', 'bindingCookie'],
  produces: ['session'],
  removable: false,
});

/**
 * エンドユーザーをログインさせ、承認画面の結果を返す。
 *
 * `POST /device/login` の処理で、`user_code`、バインディング Cookie、`csrf_token`、認証情報（ユーザー名とパスワード）の順に確かめる。
 * バインディング Cookie は、このブラウザが `user_code` を送信したブラウザであることを示す。
 * 偽造された POST で被害者のブラウザに OP のセッションが作られるのを防ぐため、認証情報より前に確かめる。
 *
 * `user_code` が保留中のレコードに一致しなければ `invalid_user_code`、バインディング Cookie か `csrf_token` がないか一致しなければ `error`（403）の結果を返す。
 * 認証情報が誤っていればレコードに失敗の回数を記録し、残りの回数を持つ `invalid_credentials` の結果を返す。
 * 上限に達するとレコードを拒否の状態にし、`locked_out`（429）の結果を返す。
 * 成功すると新しい ID の OP のセッションを保存し、このエンドユーザーに許可できるスコープと、セッションの Cookie を持つ `approval` の結果を返す。
 *
 * @spec RFC 8628 §3.3
 */
export async function submitDeviceLogin(c: any, input: DeviceLoginSubmission): Promise<DeviceOutcome> {
  const { userCode: submittedUserCode, csrfToken, username, password } = input;

  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore');
  const authenticateUser = c.get('authenticateUser');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return { kind: 'invalid_user_code', userCode: submittedUserCode };
  }

  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(c.req.header('Cookie') ?? null, record.userCode),
    );
    validateVerificationCsrfToken(record, csrfToken);
  } catch (error) {
    return verificationFailure(error);
  }

  // ユーザー名とパスワードでエンドユーザーを認証する。
  // 独自の認証（LDAP、WebAuthn、上流の IdP など）に替えるときは、この呼び出しだけを差し替えればよく、前後の処理は変えずに済む。
  const user = await authenticateUser(username, password);
  if (!user) {
    // 失敗の回数をレコードに記録し、上限に達したらレコードを拒否の状態にする。
    // 回数の制限は、レコードごとにしかかからない。
    // デバイス認可グラントを使えるクライアントを持つ攻撃者はレコードをいくらでも作れるので、パスワードを試せる合計の回数は `/login` と同じく実質的に制限されない。
    // ユーザーごとの制限は、別に扱う課題である。
    const failure = await recordDeviceLoginFailure(
      record,
      deviceStore,
      deviceAuthorizationConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // レコードは拒否の状態になったので、デバイスは次のポーリングで `access_denied` を受け取る。
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      userCode: record.userCodeDisplay,
      csrfToken,
      remainingAttempts: failure.remainingAttempts,
    };
  }

  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // 承認画面に、新しい OP のセッションの Cookie を付ける。
  // 承認の送信でも、ブラウザはバインディング Cookie をもう一度提示する必要がある。
  return {
    kind: 'approval',
    userCode: record.userCodeDisplay,
    csrfToken,
    clientId: record.clientId,
    scopes: await resolveGrantableScopes(record.scope, user.sub),
    cookies: [buildSessionCookie(sessionId)],
  };
}
