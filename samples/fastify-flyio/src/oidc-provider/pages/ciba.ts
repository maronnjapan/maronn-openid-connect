/**
 * EXPERIMENTAL — CIBA authentication device screens (CIBA Core 1.0 §7.1),
 * screen routing layer.
 *
 * routes/ciba-verification.ts owns every step of the UI, including GET /ciba
 * (it mints the login transaction and binding cookie the sign-in form needs),
 * and renders its screens through the helpers below. To customize the CIBA UI,
 * edit this file or the ciba* views in views.ts; the route never has to change.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import {
  defaultViews,
  renderView,
  type CibaCompletedPageParams,
  type CibaLoginPageParams,
  type CibaPendingRequestsPageParams,
} from '../views.js';

/** Render the sign-in form of the authentication device UI. */
export function renderCibaLoginPage(c: any, params: CibaLoginPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.cibaLoginPage(params));
}

/** Render the pending-requests approval screen (CIBA Core 1.0 §7.1 binding_message). */
export function renderCibaPendingRequestsPage(
  c: any,
  params: CibaPendingRequestsPageParams,
): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.cibaPendingRequestsPage(params));
}

/** Render the decision-recorded screen. */
export function renderCibaCompletedPage(c: any, params: CibaCompletedPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.cibaCompletedPage(params));
}
