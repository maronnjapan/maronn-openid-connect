/**
 * EXPERIMENTAL — RP-Initiated Logout screens (RP-Initiated Logout 1.0 §2),
 * screen routing layer.
 *
 * The RP sends the user agent to GET|POST /logout; the browser then sees one
 * of three things: the confirmation screen, the logged-out screen, or a
 * redirect to the RP's registered post_logout_redirect_uri. Deciding which —
 * verifying id_token_hint, matching the session, resolving the redirect — is
 * processEndSessionRequest() and approveLogout() in routes/logout.ts; this file
 * only turns their outcome into HTTP, with the cookies the outcome carries. To
 * customize the logout UI, edit this file or the logout* views in views.tsx;
 * the route module never has to change. The confirmation form must keep
 * posting csrf_token to /logout/approve: it is paired with the HttpOnly cookie
 * the logic mints.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { Hono } from 'hono';
import { approveLogout, processEndSessionRequest, type LogoutOutcome } from '../routes/logout.js';
import {
  defaultViews,
  renderView,
  type LogoutCompletedPageParams,
  type LogoutConfirmationPageParams,
} from '../views.js';
import { renderErrorPage } from './errors.js';
import { redirectWithCookies, withCookies } from './respond.js';

export const logoutPage = new Hono<{ Variables: Record<string, any> }>();

/** Render the logout confirmation screen (§2 MUST when no valid hint is presented). */
export function renderLogoutConfirmationPage(
  c: any,
  params: LogoutConfirmationPageParams,
): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.logoutConfirmationPage(params));
}

/** Render the logged-out screen. */
export function renderLogoutCompletedPage(c: any, params: LogoutCompletedPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.logoutCompletedPage(params));
}

/** Turn the outcome of a logout step into the HTTP response. */
function respond(c: any, outcome: LogoutOutcome): Response {
  if (outcome.kind === 'invalid_confirmation') {
    // Forged, replayed or expired confirmation: nothing was deleted. This is a
    // browser surface, so the answer is the error page, not OAuth error JSON.
    return renderErrorPage(c, { error: 'Invalid logout confirmation', statusCode: 400 });
  }
  if (outcome.kind === 'confirmation') {
    return withCookies(
      renderLogoutConfirmationPage(c, { csrfToken: outcome.csrfToken }),
      outcome.cookies,
    );
  }
  if (outcome.kind === 'redirect') {
    // §3: the registered post_logout_redirect_uri, state already appended.
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
