/** @jsxImportSource hono/jsx */
/**
 * Login screen (screen routing layer).
 *
 * GET /login renders the form and POST /login submits it. Neither handler
 * holds OIDC logic: prepareLogin() and submitLogin() in pipeline.ts find
 * the transaction through the transaction cookie, check the csrf_token, verify
 * the credentials and mint the OP session, and report what happened as an
 * outcome. Neither the URL nor the form names the transaction: the form only
 * embeds csrf_token, which is accepted together with the cookie. This file turns
 * each outcome into a screen or a redirect. To customize the login UI, edit
 * this file or the loginPage view in views.tsx; pipeline.ts never has to
 * change.
 */
import { Hono } from 'hono';
import { renderErrorPage } from '../../pages/errors.js';
import { redirectWithCookies } from '../../pages/respond.js';
import { defaultViews, renderView, type LoginPageParams, type Views } from '../../views.js';
import { prepareLogin, submitLogin } from './pipeline.js';
import type { LoginScreen } from './screen.js';

export const loginPage = new Hono<{ Variables: Record<string, any> }>();

/**
 * ログイン画面を描画し、HTML の `Response` を返す。
 *
 * ビューは、リクエストコンテキストの `views` にあればそれを使い、なければ既定のビューを使う。
 * ログイン画面の見た目を変えるときは、この関数だけを変えればよい（ビューを差し替える、フレームワークで描画した `Response` を返す、独自の UI へリダイレクトする）。
 *
 * `renderView()` は、ヘッダーで別の指定をしない限り `Cache-Control: no-store` を付ける。
 * ログイン画面の URL はどのトランザクションでも同じなので、保存された画面を別のブラウザや後のフローで表示すると、別のトランザクションの `csrf_token` や `login_hint` が見えてしまうためである。
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
 * 同意画面は、ログイン画面と同じトランザクションの Cookie でトランザクションを見つける。
 * URL は、リクエストの URL ではなく設定の `issuer` をもとに作る。
 * 実行環境によってはリクエストの URL を `Host` ヘッダーから作るので、リクエストの URL を使うと、送信者がリダイレクト先のオリジンを選べてしまうためである。
 *
 * @spec OIDC Discovery 1.0 §3
 * @spec RFC 9700 §2.1
 */
export function consentScreenUrl(c: any): string {
  const config = c.get('config');
  return new URL('/consent', config.issuer).toString();
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
  return redirectWithCookies(consentScreenUrl(c), outcome.cookies);
});
