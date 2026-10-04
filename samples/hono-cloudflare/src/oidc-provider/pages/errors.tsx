/** @jsxImportSource hono/jsx */
/**
 * Error screen (screen routing layer).
 *
 * Whenever a page has to stop the browser on the OP's own error page it calls
 * renderErrorPage() here. Customize the error UI in views.tsx (errorPage), or
 * change how it is delivered in this file — for example by redirecting to a
 * page of your own.
 */
import { defaultProviderConfig } from '../config.js';
import { defaultViews, renderView, type ErrorPageParams, type Views } from '../views.js';

/**
 * Render the OP's error page.
 *
 * params.statusCode is both the HTTP status of the response and the value the
 * view receives, so a custom view can show it and the status never diverges
 * from the message (a 429 lockout page answers 429, a 403 binding failure 403).
 */
export function renderErrorPage(c: any, params: ErrorPageParams): Response {
  const views: Views = c.get('views') ?? defaultViews;
  return renderView(<views.errorPage {...params} />, { status: params.statusCode });
}

/**
 * Deliver a non-redirectable authorization error (OIDC Core 1.0 §3.1.2.2) to
 * the browser.
 *
 * An unknown client_id, an unregistered redirect_uri or a redirect_uri with a
 * fragment leaves the OP without a redirect target it may trust, so the error
 * MUST stay on the OP (RFC 6749 §4.1.2.1). Two deliveries are supported:
 *
 * - config.authorizationErrorRedirectPath set: 303 to that path of the OP with
 *   error / error_description in the query, for deployments whose error screen
 *   is a framework-native page (the generated Next.js output uses /oidc-error).
 *   That page answers 200, so the HTTP 400 is traded for the framework's own
 *   error UI; the browser still sees an error screen (the OIDF Conformance
 *   Suite screenshots it for oidcc-ensure-registered-redirect-uri). Only an
 *   OP-internal root-relative path is honored: an absolute URL or a
 *   protocol-relative '//host' would turn this into an open redirect, so those
 *   fall back to the inline page below.
 * - otherwise: the error view as an HTML 400 response.
 */
export function renderAuthorizationErrorPage(
  c: any,
  params: { error: string; errorDescription?: string },
): Response {
  const config = c.get('config') ?? defaultProviderConfig;
  const errorPagePath = config.authorizationErrorRedirectPath;
  if (errorPagePath && errorPagePath.startsWith('/') && !errorPagePath.startsWith('//')) {
    const query = new URLSearchParams({ error: params.error });
    if (params.errorDescription) {
      query.set('error_description', params.errorDescription);
    }
    return c.redirect(`${errorPagePath}?${query.toString()}`, 303);
  }
  return renderErrorPage(c, {
    error: params.error,
    errorDescription: params.errorDescription,
    statusCode: 400,
  });
}
