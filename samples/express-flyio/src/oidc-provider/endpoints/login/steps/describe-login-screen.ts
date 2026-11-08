import type { AuthTransaction } from '@maronn-openid-connect/core';
import { features } from '../../../features/enabled.js';
import { loginMethodsOf } from '../../../features/feature.js';
import type { ViewResult } from '../../../views.js';
import type { LoginScreen } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'describe-login-screen',
  endpoint: 'login',
  kind: 'transform',
  label: 'ログイン画面の表示内容を組み立てる',
  spec: 'OIDC Core 1.0 §3.1.2.1 (login_hint)',
  function: 'describeLoginScreen',
  consumes: ['transaction'],
  produces: ['screen'],
  removable: false,
});

/**
 * ログインフォームに表示する内容を返す。
 *
 * 内容は、トランザクションの `csrf_token` と `login_hint`、機能が加えるほかのログイン方法（Google でのログインなど）の表示である（OIDC Core 1.0 §3.1.2.1）。
 * ログイン方法はそれぞれ、このトランザクション向けの表示を描画する。
 * 設定されていないログイン方法は何も返さないので、表示に含めない。
 * `prepareLogin()`（GET）と、ログインに失敗したときの `submitLogin()`（POST）の両方が呼ぶ。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export async function describeLoginScreen(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<LoginScreen> {
  const loginMethods: ViewResult[] = [];
  for (const method of loginMethodsOf(features)) {
    const view = await method.render(c, { transactionId, transaction });
    if (view !== undefined) loginMethods.push(view);
  }
  return {
    kind: 'screen',
    transactionId,
    csrfToken: transaction.csrfToken,
    loginHint: transaction.loginHint,
    loginMethods,
  };
}
