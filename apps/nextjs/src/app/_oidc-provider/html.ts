/**
 * HTML responses for the screens that are served by Route Handlers instead of
 * React pages: the device verification UI, the CIBA authentication device UI
 * and the RP-Initiated Logout screens.
 *
 * Those screens set a cookie on the very response that renders them (a browser
 * binding, or a confirmation secret), and their failures carry a status code
 * (403, 429, ...) that the security model and its tests rely on. A Server
 * Component can do neither, and Next.js does not render React from a Route
 * Handler, so these stay plain HTML responses. Every other screen of the OP is
 * a React page (login, consent, oidc-error).
 */

/** Escape a value for HTML text and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** An HTML page, with the Set-Cookie values the step that rendered it decided on. */
export function htmlResponse(
  html: string,
  init: { status?: number; cookies?: readonly string[] } = {},
): Response {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=UTF-8' });
  for (const cookie of init.cookies ?? []) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(html, { status: init.status ?? 200, headers });
}

/**
 * The OP's own error page. statusCode is the HTTP status and nothing else, so
 * the page never claims a different outcome than the response (a 429 lockout
 * answers 429, a 403 binding failure 403).
 */
export function errorPage(error: string, statusCode: number, errorDescription?: string): Response {
  const descriptionHtml = errorDescription ? `  <p>${escapeHtml(errorDescription)}</p>\n` : '';
  return htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body>
  <h1>Error</h1>
  <p>${escapeHtml(error)}</p>
${descriptionHtml}</body>
</html>`,
    { status: statusCode },
  );
}
