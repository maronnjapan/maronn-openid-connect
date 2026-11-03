/** @jsxImportSource hono/jsx */
import type { AuthTransaction } from '@maronn-openid-connect/core';
import { issueGoogleLoginNonce } from '@maronn-openid-connect/google-login';
import {
  buildGoogleSignInAttributes,
  type GoogleSignInAttributes,
} from '@maronn-openid-connect/google-login/sign-in';
import type { LoginMethod } from '../../endpoints/login/login-method.js';
import { contribute } from '../../endpoints/step.js';
import type { GoogleLoginConfig } from './config.js';
import { googleViews } from './views.js';

/**
 * What this method adds to the describe-login-screen box of the login
 * endpoint: buildGoogleSignIn() runs inside it, and reads the transactionId.
 */
export const contribution = contribute({
  endpoint: 'login',
  step: 'describe-login-screen',
  feature: 'google-login',
  calls: ['buildGoogleSignIn'],
  consumes: ['transactionId'],
});

/**
 * `nonce` を発行し、GIS の設定の属性を組み立てて返す。
 *
 * 返すのは、ログイン画面の `g_id_onload` 要素に付ける属性である。
 * `config.googleLogin` が設定されていなければ、`nonce` を発行せずに `undefined` を返す。
 * 設定と `nonce` のストアは、リクエストコンテキストから取り出す。
 *
 * ログインフォームを描画するたびに、このトランザクションに対応付けた新しい `nonce` を発行する。
 * リダイレクトモードの POST にはトランザクションを示す値がほかにないので、`login_uri` の処理（`endpoints/login-google/`）は、Google が ID トークンに入れて返すこの `nonce` から認可リクエストを特定する。
 * `hostedDomain` が一つの文字列のときだけ、アカウントの選択をそのドメインに絞る（`data-hd`）。
 */
export async function buildGoogleSignIn(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<GoogleSignInAttributes | undefined> {
  const config = c.get('config');
  const googleLogin: GoogleLoginConfig | undefined = config.googleLogin;
  if (!googleLogin) return undefined;
  const nonce = await issueGoogleLoginNonce({
    transactionId,
    expiresAt: transaction.expiresAt,
    store: c.get('googleLoginNonceStore'),
  });
  return buildGoogleSignInAttributes({
    clientId: googleLogin.clientId,
    // Google の OAuth クライアントに登録した、承認済みのリダイレクト URI と一致する必要がある。
    // `/consent` へのリダイレクトと同じく、リクエストの URL ではなく `config.issuer` から組み立てる。
    // リクエストの URL はランタイムによっては `Host` ヘッダーから作られ、送信者がオリジンを選べてしまうためである（RFC 9700 §2.1）。
    loginUri: new URL('/login/google', config.issuer).toString(),
    nonce,
    // Google がアカウントを事前に選べるように、`login_hint` を引き継ぐ（OIDC Core 1.0 §3.1.2.1）。
    loginHint: transaction.loginHint,
    hostedDomain: typeof googleLogin.hostedDomain === 'string' ? googleLogin.hostedDomain : undefined,
  });
}

/** The "Sign in with Google" button of the login page; nothing until config.googleLogin is set. */
export const googleLoginMethod: LoginMethod = {
  id: 'google',
  async render(c, { transactionId, transaction }) {
    const googleSignIn = await buildGoogleSignIn(c, transactionId, transaction);
    if (!googleSignIn) return undefined;
    const views = googleViews(c);
    return <views.googleSignInButton googleSignIn={googleSignIn} />;
  },
};
