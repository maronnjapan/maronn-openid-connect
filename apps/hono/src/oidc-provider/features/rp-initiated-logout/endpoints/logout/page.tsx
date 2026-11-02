/** @jsxImportSource hono/jsx */
/**
 * EXPERIMENTAL — RP-Initiated Logout screens (RP-Initiated Logout 1.0 §2),
 * screen routing layer.
 *
 * The RP sends the user agent to GET|POST /logout; the browser then sees one
 * of three things: the confirmation screen, the logged-out screen, or a
 * redirect to the RP's registered post_logout_redirect_uri. Deciding which —
 * verifying id_token_hint, matching the session, resolving the redirect — is
 * the steps of steps/, processEndSessionRequest() and approveLogout() (one box
 * each of `maronn-oidc graph --detail steps --endpoint logout`); this file only
 * turns their outcome into HTTP, with the cookies the outcome carries. To
 * customize the logout UI, edit this file or the views in ../../views.tsx; the
 * steps never have to change. The confirmation form must keep
 * posting csrf_token to /logout/approve: it is paired with the HttpOnly cookie
 * the logic mints.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { Hono } from 'hono';
import { renderErrorPage } from '../../../../pages/errors.js';
import { redirectWithCookies, withCookies } from '../../../../pages/respond.js';
import { renderView } from '../../../../views.js';
import {
  logoutViews,
  type LogoutCompletedPageParams,
  type LogoutConfirmationPageParams,
} from '../../views.js';
import type { LogoutOutcome } from './outcome.js';
import { approveLogout } from './steps/approve-logout.js';
import { processEndSessionRequest } from './steps/process-end-session-request.js';

export const logoutPage = new Hono<{ Variables: Record<string, any> }>();

/**
 * ログアウトの確認画面の HTML を返す。
 *
 * 有効な `id_token_hint` がないときに出す画面で、確認は必須である（RP-Initiated Logout 1.0 §2 の MUST）。
 * ビューは `logoutViews()` で選ぶので、アプリが差し替えたビューがあればそれを使う。
 */
export function renderLogoutConfirmationPage(
  c: any,
  params: LogoutConfirmationPageParams,
): Response {
  const views = logoutViews(c);
  return renderView(<views.logoutConfirmationPage {...params} />);
}

/**
 * ログアウトの完了画面の HTML を返す。
 *
 * ビューは `logoutViews()` で選ぶので、アプリが差し替えたビューがあればそれを使う。
 */
export function renderLogoutCompletedPage(c: any, params: LogoutCompletedPageParams): Response {
  const views = logoutViews(c);
  return renderView(<views.logoutCompletedPage {...params} />);
}

/**
 * ログアウトの結果を HTTP レスポンスにして返す。
 *
 * 結果の種類ごとに、次のように応答する。
 * - `invalid_confirmation`: OP のエラーページを 400 で返す。
 * - `confirmation`: 確認画面を、結果の Cookie を付けて返す。
 * - `redirect`: 結果の `location` へ、結果の Cookie を付けて 302 でリダイレクトする。
 * - `completed`: 完了画面を、結果の Cookie を付けて返す。
 */
function respond(c: any, outcome: LogoutOutcome): Response {
  if (outcome.kind === 'invalid_confirmation') {
    // 偽造、リプレイ、期限切れのどれかの確認であり、何も削除していない。
    // ブラウザに見せる画面なので、OAuth のエラーの JSON ではなくエラーページで応答する。
    return renderErrorPage(c, { error: 'Invalid logout confirmation', statusCode: 400 });
  }
  if (outcome.kind === 'confirmation') {
    return withCookies(
      renderLogoutConfirmationPage(c, { csrfToken: outcome.csrfToken }),
      outcome.cookies,
    );
  }
  if (outcome.kind === 'redirect') {
    // 登録済みの `post_logout_redirect_uri` へリダイレクトする（RP-Initiated Logout 1.0 §3）。
    // `state` はすでに付いている。
    return redirectWithCookies(outcome.location, outcome.cookies);
  }
  return withCookies(renderLogoutCompletedPage(c, {}), outcome.cookies);
}

/** end_session_endpoint - GET (§2: the OP MUST support GET and POST). */
logoutPage.get('/', async (c) =>
  respond(c, await processEndSessionRequest(c, new URL(c.req.url).searchParams)),
);

/** end_session_endpoint - POST, application/x-www-form-urlencoded body (§2). */
logoutPage.post('/', async (c) => {
  const body = await c.req.parseBody();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      params.append(key, value);
    }
  }
  return respond(c, await processEndSessionRequest(c, params));
});

/** Confirmation approve - POST */
logoutPage.post('/approve', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await approveLogout(c, String(body['csrf_token'] ?? '')));
});
