import {
  GoogleLoginError,
  handleGoogleLoginRedirect,
  resolveGoogleLoginSubject,
} from '@maronn-openid-connect/google-login';
import type { LoginError } from '../../../../../endpoints/login/screen.js';
import { step } from '../../../../../endpoints/step.js';
import type { GoogleLoginConfig } from '../../../config.js';

export const meta = step({
  id: 'verify-google-callback',
  endpoint: 'login-google',
  feature: 'google-login',
  kind: 'validate',
  label: 'Google の ID トークンと nonce を検証する',
  function: 'verifyGoogleLoginCallback',
  consumes: [],
  produces: ['transactionId', 'subject'],
  removable: false,
});

/**
 * POST を検証し、ユーザーとトランザクションを特定する。
 *
 * `handleGoogleLoginRedirect()` で POST を検証してトランザクション ID と Google アカウントを取り出し、`resolveGoogleLoginSubject()` でアカウントに対応する OP のサブジェクトを取得して、その二つを返す。
 * 検証器、`nonce` のストア、アカウントのリゾルバはリクエストコンテキストから取り出す。
 *
 * 検証に失敗して `GoogleLoginError` が投げられたときは、エラーコード、メッセージ、ステータスコードを入れたエラー（`kind: 'error'`）を返す。
 * 呼び出し側はこのエラーをクライアントにリダイレクトせず、OP のエラーページに表示する。
 * `nonce` を検証するまでは、どのトランザクションの POST なのか OP には分からないためである。
 * `GoogleLoginError` 以外のエラーはそのまま投げる。
 */
export async function verifyGoogleLoginCallback(
  c: any,
  googleLogin: GoogleLoginConfig,
): Promise<{ transactionId: string; subject: string } | LoginError> {
  const nonceStore = c.get('googleLoginNonceStore');
  const verifier = c.get('googleIdTokenVerifier');
  const accountResolver = c.get('googleAccountResolver');
  try {
    // Cookie とボディの `g_csrf_token` の照合、ID トークンの検証、`nonce` によるトランザクションの特定を、この順に行う。
    // 照合を検証より先に行うのは、サーバー側で ID トークンを検証する手順を示した Google のドキュメントに従うためである。
    // `nonce` を最後に使うのは、検証を通らないトークンでレコードが消費されないようにするためである。
    const login = await handleGoogleLoginRedirect({
      params: await c.req.parseBody(),
      cookieHeader: c.req.header('Cookie') ?? null,
      clientId: googleLogin.clientId,
      verifier,
      nonceStore,
      hostedDomain: googleLogin.hostedDomain,
      requireVerifiedEmail: googleLogin.requireVerifiedEmail,
    });
    const subject = await resolveGoogleLoginSubject(login.account, accountResolver);
    return { transactionId: login.transactionId, subject };
  } catch (error) {
    if (!(error instanceof GoogleLoginError)) throw error;
    return {
      kind: 'error',
      error: error.code,
      errorDescription: error.message,
      statusCode: error.httpStatusCode,
    };
  }
}
