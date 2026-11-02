/**
 * EXTENSION (google-login): the "Sign in with Google" button of the login page.
 */
import Script from 'next/script';
import { issueGoogleLoginNonce } from '@maronn-openid-connect/google-login';
import {
  buildGoogleSignInAttributes,
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
  type GoogleSignInAttributes,
} from '@maronn-openid-connect/google-login/sign-in';
import type { AuthTransaction } from '@maronn-openid-connect/core';
import type { LoginMethod } from '../../../login/login-method';
import type { ProviderConfig } from '../../config';
import type { ProviderStores } from '../../store';
import { createGoogleLoginNonceStore } from './store';

/**
 * `nonce` を発行し、GIS の設定の属性を組み立てて返す。
 *
 * 返すのは、ログイン画面の `g_id_onload` 要素に付ける属性である。
 * `config.googleLogin` が設定されていなければ、`nonce` を発行せずに `undefined` を返す。
 * 設定とストアは引数で受け取り、`nonce` は `stores.upstreamLoginStore` に保存する。
 *
 * ログインフォームを描画するたびに、このトランザクションに対応付けた新しい `nonce` を発行する。
 * リダイレクトモードの POST にはトランザクションを示す値がほかにないので、`login_uri` の処理（`(google-login)/login/google/route.ts`）は、Google が ID トークンに入れて返すこの `nonce` から認可リクエストを特定する。
 * `hostedDomain` が一つの文字列のときだけ、アカウントの選択をそのドメインに絞る（`data-hd`）。
 */
export async function buildGoogleSignIn(input: {
  transactionId: string;
  transaction: AuthTransaction;
  config: ProviderConfig;
  stores: ProviderStores;
}): Promise<GoogleSignInAttributes | undefined> {
  const { transactionId, transaction, config, stores } = input;
  const googleLogin = config.googleLogin;
  if (!googleLogin) return undefined;
  return buildGoogleSignInAttributes({
    clientId: googleLogin.clientId,
    // Google の OAuth クライアントに登録した、承認済みのリダイレクト URI と一致する必要がある。
    // OP が自分の URL を作るときと同じく、リクエストの URL ではなく `config.issuer` から組み立てる。
    loginUri: new URL('/login/google', config.issuer).toString(),
    nonce: await issueGoogleLoginNonce({
      transactionId,
      expiresAt: transaction.expiresAt,
      store: createGoogleLoginNonceStore(stores.upstreamLoginStore),
    }),
    // Google がアカウントを事前に選べるように、`login_hint` を引き継ぐ（OIDC Core 1.0 §3.1.2.1）。
    loginHint: transaction.loginHint,
    hostedDomain: typeof googleLogin.hostedDomain === 'string' ? googleLogin.hostedDomain : undefined,
  });
}

export const googleLoginMethod: LoginMethod = {
  id: 'google',
  async render(input) {
    const googleSignIn = await buildGoogleSignIn(input);
    if (!googleSignIn) return undefined;
    // The three elements GIS needs for redirect mode. googleSignIn holds the
    // g_id_onload attributes (data-ux_mode="redirect", data-login_uri,
    // data-nonce, ...) and spreads straight onto the element; GIS replaces
    // .g_id_signin with the button: style it through the GIS button attributes
    // (data-theme, data-size, data-text, ...).
    return (
      <section aria-label="Sign in with Google">
        <Script src={GOOGLE_GSI_CLIENT_SCRIPT_URL} strategy="afterInteractive" />
        <div {...googleSignIn} />
        <div className="g_id_signin" data-type="standard" />
      </section>
    );
  },
};
