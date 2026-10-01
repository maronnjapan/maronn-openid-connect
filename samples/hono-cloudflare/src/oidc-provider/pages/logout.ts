/**
 * EXPERIMENTAL — RP-Initiated Logout screens (RP-Initiated Logout 1.0 §2),
 * screen routing layer.
 *
 * routes/logout.ts owns the end_session_endpoint (GET|POST /logout) and the
 * confirmation approve step, and renders its two screens through the helpers
 * below. To customize the logout UI, edit this file or the logout* views in
 * views.ts; the route never has to change. The confirmation form must keep
 * posting csrf_token to /logout/approve: it is paired with the HttpOnly cookie
 * the route sets.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import {
  defaultViews,
  renderView,
  type LogoutCompletedPageParams,
  type LogoutConfirmationPageParams,
} from '../views.js';

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
