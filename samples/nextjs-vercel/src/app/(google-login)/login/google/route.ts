/**
 * EXTENSION (google-login) — the Google login callback (login_uri).
 *
 * Sign in with Google (redirect mode) posts the ID token here once the user
 * picks an account. A Route Handler rather than a Server Action: the POST comes
 * from Google's page and carries no Server Action id. After the callback checks
 * it continues exactly like a password login: same session, same consent step.
 *
 * The transaction cookie does not come along: Google's POST is a cross-site
 * navigation, so the browser withholds SameSite=Lax cookies. The single-use
 * nonce stands in for it — it was issued on the login page, which only the
 * browser holding the cookie could load. The consent step that follows is a
 * plain navigation again and reads the cookie as usual.
 *
 * A failed callback ends on the OP's error page (oidc-error/page.tsx), like
 * every error that must not reach a client.
 */
import { notFound } from 'next/navigation';
import { NextResponse } from 'next/server';
import { AuthTransactionError, getAuthTransaction } from '@maronn-openid-connect/core';
import {
  getDefaultGoogleIdTokenVerifier,
  GoogleLoginError,
  handleGoogleLoginRedirect,
  resolveGoogleLoginSubject,
  type GoogleAccountResolver,
  type GoogleIdTokenPayload,
  type GoogleIdTokenVerifier,
} from '@maronn-openid-connect/google-login';
import { readFormFields, redirectToErrorPage } from '../../../_oidc-provider/http';
import { config, stores } from '../../../_oidc-provider/provider';
import { startSession } from '../../../login/session';
import {
  createGoogleLoginNonceStore,
  googleAccountToFederatedIdentity,
} from '../../../_oidc-provider/features/google-login/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Verifies the ID token Google posts: google-auth-library
 * (OAuth2Client.verifyIdToken) with a process-wide certificate cache. Replace
 * it for tests or a proxied environment.
 */
const googleIdTokenVerifier: GoogleIdTokenVerifier = getDefaultGoogleIdTokenVerifier();

/**
 * Maps a verified Google account to the OP subject: just-in-time provisioning
 * through the user store (userStore.linkFederatedIdentity), keyed by the
 * Google sub.
 */
const googleAccountResolver: GoogleAccountResolver = {
  resolveSubject: async (account: GoogleIdTokenPayload) =>
    (await stores.userStore.linkFederatedIdentity(googleAccountToFederatedIdentity(account))).sub,
};

/**
 * ID トークンでログインし、同意画面へリダイレクトする。
 *
 * `POST /login/google` のルートハンドラで、「Google でログイン」を終えたブラウザから ID トークンが POST で届く。
 * ID トークンと `nonce` を検証して Google アカウントに対応する OP のユーザーを特定し（初回のログインならユーザーを作る）、`nonce` を発行したトランザクションのために OP のセッションを始めて、`/consent` へ 302 でリダイレクトする。
 * `prompt` に `login` か `select_account` があれば、セッションを始める前に既存のセッションを破棄する。
 *
 * 検証（CSRF の Cookie、ID トークン、`nonce`、設定したときは `hd` と `email_verified`）に失敗したときと、トランザクションがないか期限切れのときは、OP のエラーページへ 303 でリダイレクトする。
 * `config.googleLogin` が設定されていなければ 404 で応答する。
 */
export async function POST(request: Request): Promise<Response> {
  const googleLogin = config.googleLogin;
  // `config.googleLogin` がなければ Google でのログインは始まらないので、このコールバックはないものとして 404 で応答する。
  if (!googleLogin) notFound();

  let transactionId: string;
  let subject: string;
  try {
    // Cookie とボディの `g_csrf_token` の照合、ID トークンの検証、`nonce` によるトランザクションの特定を、この順に行う。
    // 照合を検証より先に行うのは、サーバー側で ID トークンを検証する手順を示した Google のドキュメントに従うためである。
    // `nonce` を最後に使うのは、検証を通らないトークンでレコードが消費されないようにするためである。
    const login = await handleGoogleLoginRedirect({
      params: await readFormFields(request),
      cookieHeader: request.headers.get('Cookie'),
      clientId: googleLogin.clientId,
      verifier: googleIdTokenVerifier,
      nonceStore: createGoogleLoginNonceStore(stores.upstreamLoginStore),
      hostedDomain: googleLogin.hostedDomain,
      requireVerifiedEmail: googleLogin.requireVerifiedEmail,
    });
    transactionId = login.transactionId;
    subject = await resolveGoogleLoginSubject(login.account, googleAccountResolver);
  } catch (error) {
    // `nonce` を検証するまでは、どのトランザクションの POST なのか OP には分からない。
    // そのため、失敗したときはクライアントにリダイレクトせず、OP のエラーページで終える。
    if (!(error instanceof GoogleLoginError)) throw error;
    return redirectToErrorPage(error.code, error.message);
  }

  let transaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return redirectToErrorPage(error.code, error.message);
  }

  await startSession(transactionId, transaction, subject);
  return NextResponse.redirect(new URL('/consent', config.issuer), 302);
}
