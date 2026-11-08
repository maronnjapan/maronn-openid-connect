/** @jsxImportSource hono/jsx */
/**
 * Render and submit the login form, preserving the transaction ID in the URL
 * and hidden field. The pipeline checks both against the browser's cookie and
 * validates csrf_token before authenticating. Customize the loginPage view to
 * change the screen while preserving these fields.
 */
import { WebRouter } from '../../web-router.js';
import { buildTransactionPath } from '@maronn-openid-connect/core';
import { renderErrorPage } from '../../pages/errors.js';
import { redirectWithCookies } from '../../pages/respond.js';
import { defaultViews, renderView, type LoginPageParams, type Views } from '../../views.js';
import { prepareLogin, submitLogin } from './pipeline.js';
import type { LoginScreen } from './screen.js';

export const loginPage = new WebRouter();

/**
 * ログイン画面を描画し、HTML の `Response` を返す。
 *
 * ビューは、リクエストコンテキストの `views` にあればそれを使い、なければ既定のビューを使う。
 * ログイン画面の見た目を変えるときは、この関数だけを変えればよい（ビューを差し替える、フレームワークで描画した `Response` を返す、独自の UI へリダイレクトする）。
 *
 * `renderView()` は、ヘッダーで別の指定をしない限り `Cache-Control: no-store` を付ける。
 * Cached forms could disclose a transaction’s csrf_token or login_hint to another browser or later flow.
 * 独自の `Response` を返すときも、このヘッダーを付ける。
 */
export function renderLoginPage(c: any, params: LoginPageParams): Response {
  const views: Views = c.get('views') ?? defaultViews;
  return renderView(<views.loginPage {...params} />);
}

/**
 * ログイン画面の内容を、ビューのパラメータに変えて返す。
 *
 * ログインのビューに既定より多くの値が必要なときは、ここに加える。
 */
function loginPageParams(screen: LoginScreen): LoginPageParams {
  return {
    transactionId: screen.transactionId,
    csrfToken: screen.csrfToken,
    // ビューがログインフォームにあらかじめ入れる `login_hint` を渡す（OIDC Core 1.0 §3.1.2.1 では RECOMMENDED）。
    loginHint: screen.loginHint,
    // 機能が加える、ほかのログイン方法（Google でのログインなど）の表示を渡す。
    loginMethods: screen.loginMethods,
  };
}

/**
 * ログイン後に移る同意画面の URL を返す。
 *
 * The consent URL carries the same transaction ID as the browser cookie.
 * URL は、リクエストの URL ではなく設定の `issuer` をもとに作る。
 * 実行環境によってはリクエストの URL を `Host` ヘッダーから作るので、リクエストの URL を使うと、送信者がリダイレクト先のオリジンを選べてしまうためである。
 *
 * @spec OIDC Discovery 1.0 §3
 * @spec RFC 9700 §2.1
 */
export function consentScreenUrl(c: any, transactionId: string): string {
  const config = c.get('config');
  return new URL(buildTransactionPath('/consent', transactionId), config.issuer).toString();
}

/**
 * Login Page - GET
 * Displays the login form for the transaction in this browser's cookie.
 */
loginPage.get('/', async (c) => {
  const screen = await prepareLogin(c);
  if (screen.kind === 'error') return renderErrorPage(c, screen);
  return renderLoginPage(c, loginPageParams(screen));
});

/**
 * Login Handler - POST
 * Submits the login form and shows the next screen.
 */
loginPage.post('/', async (c) => {
  const body = await c.req.parseBody();
  const outcome = await submitLogin(c, {
    transactionId: String(body['transaction_id'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    username: String(body['username'] ?? ''),
    password: String(body['password'] ?? ''),
  });

  if (outcome.kind === 'error') return renderErrorPage(c, outcome);
  if (outcome.kind === 'locked_out') {
    return renderErrorPage(c, {
      error: 'Too many login attempts',
      statusCode: 429,
    });
  }
  if (outcome.kind === 'invalid_credentials') {
    // The same form again, with the failure shown.
    return renderLoginPage(c, {
      ...loginPageParams(outcome.screen),
      error: 'Invalid credentials',
      remainingAttempts: outcome.remainingAttempts,
    });
  }
  // Signed in: set the OP session cookie and continue to the consent step.
  return redirectWithCookies(consentScreenUrl(c, outcome.transactionId), outcome.cookies);
});
